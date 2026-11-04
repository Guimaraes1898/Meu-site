import { Op } from 'sequelize';
import * as yup from 'yup';
import Subscription from '../models/subscription.js';
import User from '../models/user.js';
import {
  cancelPreapproval,
  createPreapproval,
  getAuthorizedPayment,
  getPreapproval,
  getWebhookSignatureFailure,
  MercadoPagoApiError,
  MercadoPagoConfigurationError,
  searchAuthorizedPayments,
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

const paymentStatuses = [
  'approved',
  'pending',
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
];
const installmentStatuses = [
  'processed',
  'pending',
  'waiting for gateway',
  'recycling',
];

// A parcela (authorized payment) tem status próprio no nível superior
// ('processed', 'recycling', ...) e o status real do pagamento fica em
// `payment.status`. Uma parcela 'processed' pode ter pagamento aprovado ou
// recusado, então só o status aninhado define o último pagamento.
function resolveAuthorizedPaymentStatus(authorizedPayment) {
  const nestedStatus = authorizedPayment.payment?.status;
  if (typeof nestedStatus === 'string') {
    if (!paymentStatuses.includes(nestedStatus)) {
      throw new Error(
        `Unsupported Mercado Pago payment status: ${nestedStatus}`,
      );
    }
    return nestedStatus;
  }

  const { status } = authorizedPayment;
  if (typeof status === 'string' && paymentStatuses.includes(status)) {
    return status;
  }
  if (typeof status === 'string' && installmentStatuses.includes(status)) {
    return null;
  }
  throw new Error(
    `Unsupported Mercado Pago authorized payment status: ${status}`,
  );
}

async function applyAuthorizedPayment(subscription, authorizedPayment) {
  const status = resolveAuthorizedPaymentStatus(authorizedPayment);
  const paymentDate = toDate(
    authorizedPayment.date_created ?? authorizedPayment.debit_date,
  );
  const values = {};
  if (status) {
    values.lastPaymentStatus = status;
  }
  if (paymentDate) {
    values.lastPaymentAt = paymentDate;
  }
  if (Object.keys(values).length > 0) {
    await subscription.update(values);
  }

  if (status === 'approved') {
    const preapproval = await getPreapproval(
      subscription.providerSubscriptionId,
    );
    return synchronizePreapproval(preapproval);
  }

  return subscription;
}

async function synchronizeAuthorizedPayment(paymentId) {
  const authorizedPayment = await getAuthorizedPayment(paymentId);
  if (
    typeof authorizedPayment.preapproval_id !== 'string' &&
    typeof authorizedPayment.preapproval_id !== 'number'
  ) {
    throw new Error(
      'Mercado Pago authorized payment has no associated subscription.',
    );
  }

  const providerSubscriptionId = String(authorizedPayment.preapproval_id);
  const subscription = await Subscription.findOne({
    where: { providerSubscriptionId },
  });
  if (!subscription) {
    console.warn(
      'Received Mercado Pago payment notification without a matching local subscription.',
    );
    return null;
  }

  return applyAuthorizedPayment(subscription, authorizedPayment);
}

// Busca o estado real no Mercado Pago para corrigir o registro local quando
// algum webhook foi perdido ou rejeitado.
async function reconcileWithMercadoPago(subscription) {
  if (!subscription?.providerSubscriptionId) {
    return;
  }
  try {
    const preapproval = await getPreapproval(
      subscription.providerSubscriptionId,
    );
    await synchronizePreapproval(preapproval);

    const result = await searchAuthorizedPayments(
      subscription.providerSubscriptionId,
    );
    const payments = Array.isArray(result?.results) ? result.results : [];
    if (payments.length > 0) {
      const latest = payments.reduce((previous, current) => {
        const previousDate = toDate(previous?.date_created);
        const currentDate = toDate(current?.date_created);
        if (!previousDate) {
          return current;
        }
        if (!currentDate) {
          return previous;
        }
        return previousDate >= currentDate ? previous : current;
      });
      await subscription.reload();
      await applyAuthorizedPayment(subscription, latest);
    }
  } catch (error) {
    console.error('Failed to reconcile subscription with Mercado Pago:', error);
  }
}

function subscriptionBlocksCheckout(subscription, now = new Date()) {
  if (openStatuses.includes(subscription.status)) {
    return true;
  }
  if (
    subscription.status !== 'cancelled' ||
    !subscription.cancelAtPeriodEnd ||
    subscription.lastPaymentStatus !== 'approved'
  ) {
    return false;
  }
  const periodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;
  return periodEnd !== null && periodEnd > now;
}

class SubscriptionController {
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

    const openSubscriptionQuery = {
      [Op.or]: [
        { status: { [Op.in]: openStatuses } },
        {
          status: 'cancelled',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: { [Op.gt]: new Date() },
        },
      ],
    };

    // Sincroniza com o Mercado Pago antes de bloquear: webhooks podem ter
    // sido perdidos e o estado local pode estar desatualizado.
    const subscriptionToSync = await Subscription.findOne({
      where: { userId: request.user.id, ...openSubscriptionQuery },
      order: [['createdAt', 'DESC']],
    });
    await reconcileWithMercadoPago(subscriptionToSync);

    const checkout = await Subscription.sequelize.transaction(
      async (transaction) => {
        const user = await User.findByPk(request.user.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) {
          return { userNotFound: true };
        }

        let existingSubscription = await Subscription.findOne({
          where: { userId: user.id, ...openSubscriptionQuery },
          order: [['createdAt', 'DESC']],
          transaction,
        });

        const orphanThresholdMs = 15 * 60 * 1000;
        if (
          existingSubscription?.status === 'pending' &&
          !existingSubscription.providerSubscriptionId &&
          Date.now() - new Date(existingSubscription.createdAt).getTime() >
            orphanThresholdMs
        ) {
          // O checkout anterior nunca chegou ao Mercado Pago; descarta o
          // registro órfão para não bloquear uma nova assinatura.
          await existingSubscription.update(
            { status: 'failed' },
            { transaction },
          );
          existingSubscription = null;
        }

        if (
          existingSubscription &&
          subscriptionBlocksCheckout(existingSubscription)
        ) {
          return {
            conflict: true,
            accessUntil: openStatuses.includes(existingSubscription.status)
              ? null
              : existingSubscription.currentPeriodEnd,
          };
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
      const message = checkout.accessUntil
        ? `Sua assinatura já está paga e o acesso continua até ${new Date(checkout.accessUntil).toLocaleDateString('pt-BR')}. Quando o período terminar, você poderá assinar novamente.`
        : 'Você já possui uma assinatura ativa ou pendente.';
      return response.status(409).json({ message });
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
        status: 'cancelled',
        cancelAtPeriodEnd: true,
      });

      return response.status(200).json({
        id: subscription.id,
        status: 'cancelled',
        accessUntil: subscription.currentPeriodEnd,
      });
    } catch (error) {
      console.error('Mercado Pago subscription cancellation failed:', error);

      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        return response.status(502).json({
          message: 'Não foi possível cancelar a assinatura no Mercado Pago.',
        });
      }
      throw error;
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
