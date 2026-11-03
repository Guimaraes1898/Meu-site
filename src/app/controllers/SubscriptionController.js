import { Op } from 'sequelize';
import * as yup from 'yup';
import Subscription from '../models/subscription.js';
import User from '../models/user.js';
import {
  cancelPreapproval,
  createPreapproval,
  getAuthorizedPayment,
  getPreapproval,
  MercadoPagoApiError,
  MercadoPagoConfigurationError,
  getWebhookSignatureFailure,
} from '../services/MercadoPagoService.js';
import { subscriptionPlans } from '../services/subscriptionPlans.js';

const checkoutSchema = yup.object({
  plan: yup.string().oneOf(Object.keys(subscriptionPlans)).required(),
});

const openStatuses = ['pending', 'authorized', 'paused'];

function toDate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSubscriptionStatus(status) {
  const statuses = {
    authorized: 'authorized',
    pending: 'pending',
    paused: 'paused',
    cancelled: 'cancelled',
    rejected: 'rejected',
    expired: 'expired',
    finished: 'expired',
  };
  const normalized = statuses[status];
  if (!normalized) {
    throw new Error(`Unsupported Mercado Pago subscription status: ${status}`);
  }
  return normalized;
}

async function findSubscription(resource) {
  if (
    typeof resource.external_reference === 'string' &&
    /^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(
      resource.external_reference,
    )
  ) {
    const byReference = await Subscription.findByPk(
      resource.external_reference,
    );
    if (byReference) {
      return byReference;
    }
  }

  if (resource.id) {
    return Subscription.findOne({
      where: { providerSubscriptionId: String(resource.id) },
    });
  }

  return null;
}

async function synchronizePreapproval(resource) {
  if (
    (typeof resource.id !== 'string' && typeof resource.id !== 'number') ||
    !resource.status
  ) {
    throw new Error('Mercado Pago returned an incomplete subscription.');
  }
  const subscription = await findSubscription(resource);
  if (!subscription) {
    console.warn(
      'Received Mercado Pago subscription notification without a matching local subscription.',
    );
    return null;
  }

  const providerId = String(resource.id);
  if (
    subscription.providerSubscriptionId &&
    subscription.providerSubscriptionId !== providerId
  ) {
    throw new Error(
      'Mercado Pago subscription ID does not match local record.',
    );
  }

  const status = normalizeSubscriptionStatus(resource.status);
  const currentPeriodEnd = toDate(
    resource.next_payment_date ?? resource.auto_recurring?.end_date,
  );
  const values = {
    providerSubscriptionId: providerId,
    status,
    cancelAtPeriodEnd: status === 'cancelled' || subscription.cancelAtPeriodEnd,
  };
  if (currentPeriodEnd) {
    values.currentPeriodEnd = currentPeriodEnd;
  }
  await subscription.update(values);
  return subscription;
}

async function synchronizeAuthorizedPayment(paymentId) {
  const payment = await getAuthorizedPayment(paymentId);
  if (
    typeof payment.preapproval_id !== 'string' &&
    typeof payment.preapproval_id !== 'number'
  ) {
    throw new Error(
      'Mercado Pago authorized payment has no associated subscription.',
    );
  }

  const providerSubscriptionId = String(payment.preapproval_id);
  const subscription = await Subscription.findOne({
    where: { providerSubscriptionId },
  });
  if (!subscription) {
    console.warn(
      'Received Mercado Pago payment notification without a matching local subscription.',
    );
    return null;
  }

  const paymentStatuses = [
    'approved',
    'pending',
    'rejected',
    'cancelled',
    'refunded',
    'charged_back',
  ];
  if (!paymentStatuses.includes(payment.status)) {
    throw new Error(
      `Unsupported Mercado Pago authorized payment status: ${payment.status}`,
    );
  }

  const paymentDate = toDate(payment.date_created ?? payment.debit_date);
  const values = { lastPaymentStatus: payment.status };
  if (paymentDate) {
    values.lastPaymentAt = paymentDate;
  }
  await subscription.update(values);

  if (payment.status === 'approved') {
    const preapproval = await getPreapproval(providerSubscriptionId);
    return synchronizePreapproval(preapproval);
  }

  return subscription;
}

class SubscriptionController {
  // Este é o método `checkout` que você deve SUBSTITUIR COMPLETAMENTE
  async checkout(request, response) {
    let data;
    try {
      data = await checkoutSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Selecione um plano mensal, trimestral ou semestral válido.',
        });
      }
      throw error;
    }

    const checkout = await Subscription.sequelize.transaction(
      async (transaction) => {
        const user = await User.findByPk(request.user.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) {
          return { userNotFound: true };
        }

        const existingSubscription = await Subscription.findOne({
          where: {
            userId: user.id,
            [Op.or]: [
              { status: { [Op.in]: openStatuses } },
              {
                status: 'cancelled',
                cancelAtPeriodEnd: true,
                currentPeriodEnd: { [Op.gt]: new Date() },
              },
            ],
          },
          transaction,
        });
        if (existingSubscription) {
          return { conflict: true };
        }

        const planDetailsFromService = subscriptionPlans[data.plan]; // Obtém os detalhes do plano
        if (!planDetailsFromService) { // Adicionado para garantir que o plano existe
          return { invalidPlan: true };
        }

        const subscription = await Subscription.create(
          {
            userId: user.id,
            plan: data.plan,
            amount: planDetailsFromService.amount, 
            currency: 'BRL',
            status: 'pending', 
          },
          { transaction },
        );
        return { subscription, user, plan: planDetailsFromService }; 
      },
    );

    if (checkout.userNotFound) {
      return response.status(401).json({
        message: 'Usuário não encontrado.',
      });
    }

    if (checkout.conflict) {
      return response.status(409).json({
        message: 'Você já possui uma assinatura ativa ou pendente.',
      });
    }

    const plan = subscriptionPlans[data.plan];
    const { subscription, user } = checkout;

    try {
      const preapproval = await createPreapproval({
        subscriptionId: subscription.id,
        email: user.email,
        plan,
      });
      await subscription.update({
        providerSubscriptionId: preapproval.id,
        currentPeriodEnd: toDate(preapproval.next_payment_date),
      });
      return response.status(201).json({
        id: subscription.id,
        plan: data.plan,
        status: 'pending',
        checkoutUrl: preapproval.init_point,
      });
    } catch (error) {
      await subscription.update({ status: 'failed' });
      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        console.error('Mercado Pago subscription creation failed:', error);
        return response.status(502).json({
          message: 'Não foi possível iniciar a assinatura no Mercado Pago.',
        });
      }
      throw error;
    }
  }

  async show(request, response) {
    const subscription = await Subscription.findOne({
      where: { userId: request.user.id },
      order: [['createdAt', 'DESC']],
    });

    if (!subscription) {
      return response.status(200).json({ subscription: null });
    }

    return response.status(200).json({
      subscription: {
        id: subscription.id,
        plan: subscription.plan,
        amount: subscription.amount,
        currency: subscription.currency,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        lastPaymentStatus: subscription.lastPaymentStatus,
      },
    });
  }

  async cancel(request, response) {
    const subscription = await Subscription.findOne({
      where: {
        userId: request.user.id,
        status: { [Op.in]: ['pending', 'authorized', 'paused'] },
      },
      order: [['createdAt', 'DESC']],
    });

    if (!subscription) {
      return response.status(404).json({
        message: 'Não há uma assinatura ativa para cancelar.',
      });
    }
    if (!subscription.providerSubscriptionId) {
      return response.status(409).json({
        message: 'A assinatura ainda não foi criada no Mercado Pago.',
      });
    }

    try {
      await cancelPreapproval(subscription.providerSubscriptionId);
      await subscription.update({
        providerSubscriptionId: mpPreapproval.id,
      });

      return response.status(200).json({
        message: 'Assinatura iniciada com sucesso. Redirecione para o Mercado Pago.',
        paymentUrl: mpPreapproval.init_point, 
      });

    } catch (error) {
      console.error('--- ERRO AO CHAMAR createPreapproval do Mercado Pago ---');
      console.error('Erro:', error); 
      console.error('----------------------------------------------------');

    
      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(500).json({
          message: 'Erro de configuração do Mercado Pago no servidor.',
          details: error.message,
        });
      } else if (error instanceof MercadoPagoApiError) {
        return response.status(error.status || 500).json({
          message: `Erro da API do Mercado Pago: ${error.message}`,
          mpCode: error.providerCode,
        });
      } else {
       
        return response.status(500).json({
          message: 'Ocorreu um erro interno inesperado ao processar a assinatura.',
          details: error.message,
        });
      }
    }
  }


  async webhook(request, response) {
  console.log('--- Webhook do Mercado Pago recebido! ---'); // <-- NOVO LOG
  console.log('Request Headers:', request.headers); // <-- NOVO LOG
  console.log('Request Query:', request.query);   // <-- NOVO LOG
  console.log('Request Body:', JSON.stringify(request.body, null, 2)); // <-- NOVO LOG

  const isEmptyProbe =
    request.body &&
    typeof request.body === 'object' &&
    !Array.isArray(request.body) &&
    Object.keys(request.body).length === 0 &&
    !request.query['data.id'] &&
    !request.query.type &&
    !request.query.topic;
  if (isEmptyProbe) {
    console.log('Webhook é uma requisição de probe vazia.'); // <-- NOVO LOG
    return response.status(200).json({ received: true });
  }

  const dataId = String(
    request.body?.data?.id ?? request.query['data.id'] ?? '',
  );
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) {
    console.error('ERRO: MERCADO_PAGO_WEBHOOK_SECRET não configurado.'); // <-- NOVO LOG
    return response.status(503).json({
      message: 'As notificações do Mercado Pago não estão configuradas.',
    });
  }
  console.log('Webhook dataId:', dataId); // <-- NOVO LOG
  console.log('Webhook secret (primeiros 5 chars):', secret.substring(0, 5) + '...'); // <-- NOVO LOG

  const signatureFailure = getWebhookSignatureFailure({
    signature: request.get('x-signature'),
    requestId: request.get('x-request-id'),
    dataId,
    secret,
  });

  if (signatureFailure) {
    console.warn('Mercado Pago webhook signature validation failed:', {
      reason: signatureFailure,
      dataIdSource: request.query['data.id'] ? 'query' : 'body',
      notificationType:
        request.body?.type ?? request.query.type ?? request.query.topic ?? null,
    });
    return response.status(401).json({
      message: 'Assinatura de notificação inválida.',
    });
  }
  console.log('Webhook signature validated successfully!'); // <-- NOVO LOG

  const notificationType =
    request.body?.type ?? request.query.type ?? request.query.topic;
  console.log('Webhook notificationType:', notificationType); // <-- NOVO LOG

  try {
    if (
      notificationType === 'subscription_preapproval' ||
      notificationType === 'preapproval'
    ) {
      console.log('Processing preapproval notification...'); // <-- NOVO LOG
      const preapproval = await getPreapproval(dataId);
      console.log('Preapproval fetched from MP:', JSON.stringify(preapproval, null, 2)); // <-- NOVO LOG
      await synchronizePreapproval(preapproval);
      console.log('Preapproval synchronized successfully!'); // <-- NOVO LOG
    } else if (
      notificationType === 'subscription_authorized_payment' ||
      notificationType === 'authorized_payment'
    ) {
      console.log('Processing authorized payment notification...'); // <-- NOVO LOG
      const payment = await getAuthorizedPayment(dataId); // <-- Precisamos dessa variável 'payment'
      console.log('Payment fetched from MP:', JSON.stringify(payment, null, 2)); // <-- NOVO LOG
      await synchronizeAuthorizedPayment(dataId); // <-- Este aqui precisa do 'payment.preapproval_id' ou similar
      console.log('Authorized payment synchronized successfully!'); // <-- NOVO LOG
    } else {
      console.warn(
        'Ignoring unsupported Mercado Pago notification type:',
        notificationType,
      );
    }
  } catch (error) {
    if (error instanceof MercadoPagoConfigurationError) {
      console.error('Mercado Pago webhook processing failed (Configuration Error):', error); // <-- NOVO LOG
      return response.status(503).json({
        message: 'Os pagamentos não estão configurados no servidor.',
      });
    }
    if (error instanceof MercadoPagoApiError) {
      console.error('Mercado Pago webhook processing failed (API Error):', error); // <-- NOVO LOG
      return response.status(error.status || 502).json({ // Use error.status se disponível
        message: 'Não foi possível processar a notificação do Mercado Pago.',
      });
    }
    console.error('Mercado Pago webhook processing failed (Unhandled Error):', error); // <-- NOVO LOG
    throw error;
  }

  console.log('Webhook processed successfully, sending 200 OK.'); // <-- NOVO LOG
  return response.status(200).json({ received: true });
}
}

export default new SubscriptionController();
