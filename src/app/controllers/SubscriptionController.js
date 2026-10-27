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
  verifyWebhookSignature,
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

        const plan = subscriptionPlans[data.plan];
        const subscription = await Subscription.create(
          {
            userId: user.id,
            plan: data.plan,
            amount: plan.amount,
            currency: 'BRL',
            status: 'pending',
          },
          { transaction },
        );
        return { subscription, user };
      },
    );

    if (checkout.userNotFound) {
      return response.status(401).json({
        message: 'Autenticação necessária.',
      });
    }
    if (checkout.conflict) {
      return response.status(409).json({
        message: 'Já existe uma assinatura em andamento para esta conta.',
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
        const details = [
          `HTTP ${error.status}`,
          error.providerCode ? `código ${error.providerCode}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return response.status(502).json({
          message: `Não foi possível iniciar a assinatura no Mercado Pago (${details}).`,
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
      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        console.error('Mercado Pago subscription cancellation failed:', error);
        return response.status(502).json({
          message: 'Não foi possível cancelar a assinatura no Mercado Pago.',
        });
      }
      throw error;
    }
  }

  async webhook(request, response) {
    const dataId = String(
      request.body?.data?.id ?? request.query['data.id'] ?? '',
    );
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!secret) {
      return response.status(503).json({
        message: 'As notificações do Mercado Pago não estão configuradas.',
      });
    }
    const validSignature = verifyWebhookSignature({
      signature: request.get('x-signature'),
      requestId: request.get('x-request-id'),
      dataId,
      secret,
    });

    if (!validSignature) {
      return response.status(401).json({
        message: 'Assinatura de notificação inválida.',
      });
    }

    const notificationType =
      request.body?.type ?? request.query.type ?? request.query.topic;
    try {
      if (
        notificationType === 'subscription_preapproval' ||
        notificationType === 'preapproval'
      ) {
        const preapproval = await getPreapproval(dataId);
        await synchronizePreapproval(preapproval);
      } else if (
        notificationType === 'subscription_authorized_payment' ||
        notificationType === 'authorized_payment'
      ) {
        await synchronizeAuthorizedPayment(dataId);
      } else {
        console.warn(
          'Ignoring unsupported Mercado Pago notification type:',
          notificationType,
        );
      }
    } catch (error) {
      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        console.error('Mercado Pago webhook processing failed:', error);
        return response.status(502).json({
          message: 'Não foi possível processar a notificação do Mercado Pago.',
        });
      }
      throw error;
    }

    return response.status(200).json({ received: true });
  }
}

export default new SubscriptionController();
