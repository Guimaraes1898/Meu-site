import { Op } from 'sequelize';
import * as yup from 'yup';
import Subscription from '../models/subscription.js';
import User from '../models/user.js';
import {
  cancelPayment,
  createPixPayment,
  getPayment,
  getWebhookSignatureFailure,
  MercadoPagoApiError,
  MercadoPagoConfigurationError,
} from '../services/MercadoPagoService.js';
import { subscriptionPlans } from '../services/subscriptionPlans.js';

const checkoutSchema = yup.object({
  plan: yup.string().oneOf(Object.keys(subscriptionPlans)).required(),
});

const openStatuses = ['pending', 'authorized'];

function toDate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// O status local 'authorized' significa "pago, com acesso vigente"; o
// Mercado Pago usa 'approved' para o pagamento Pix em si.
const subscriptionStatusByPaymentStatus = {
  approved: 'authorized',
  pending: 'pending',
  in_process: 'pending',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'cancelled',
  charged_back: 'cancelled',
};

function normalizePaymentStatus(status) {
  const normalized = subscriptionStatusByPaymentStatus[status];
  if (!normalized) {
    throw new Error(`Unsupported Mercado Pago payment status: ${status}`);
  }
  return normalized;
}

async function findSubscriptionByPayment(payment) {
  if (
    typeof payment.external_reference === 'string' &&
    /^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(
      payment.external_reference,
    )
  ) {
    const byReference = await Subscription.findByPk(payment.external_reference);
    if (byReference) {
      return byReference;
    }
  }

  if (payment.id) {
    return Subscription.findOne({
      where: { providerPaymentId: String(payment.id) },
    });
  }

  return null;
}

async function synchronizePayment(payment) {
  if (
    (typeof payment.id !== 'string' && typeof payment.id !== 'number') ||
    !payment.status
  ) {
    throw new Error('Mercado Pago returned an incomplete payment.');
  }
  const subscription = await findSubscriptionByPayment(payment);
  if (!subscription) {
    console.warn(
      'Received Mercado Pago payment notification without a matching local subscription.',
    );
    return null;
  }

  const providerId = String(payment.id);
  if (
    subscription.providerPaymentId &&
    subscription.providerPaymentId !== providerId
  ) {
    throw new Error('Mercado Pago payment ID does not match local record.');
  }

  const status = normalizePaymentStatus(payment.status);
  const paymentDate = toDate(payment.date_approved ?? payment.date_created);
  const values = {
    providerPaymentId: providerId,
    status,
    lastPaymentStatus: payment.status,
  };
  if (paymentDate) {
    values.lastPaymentAt = paymentDate;
  }
  if (status === 'authorized') {
    // O acesso passa a valer na aprovação do Pix e dura o período do plano.
    const plan = subscriptionPlans[subscription.plan];
    values.currentPeriodEnd = addMonths(
      paymentDate ?? new Date(),
      plan?.frequency ?? 1,
    );
  }
  await subscription.update(values);
  return subscription;
}

// Busca o estado real no Mercado Pago para corrigir o registro local quando
// algum webhook foi perdido ou rejeitado.
async function reconcileWithMercadoPago(subscription) {
  if (!subscription?.providerPaymentId) {
    return;
  }
  try {
    const payment = await getPayment(subscription.providerPaymentId);
    await synchronizePayment(payment);
  } catch (error) {
    console.error('Failed to reconcile subscription with Mercado Pago:', error);
  }
}

function subscriptionBlocksCheckout(subscription, now = new Date()) {
  if (subscription.status === 'pending') {
    // Um Pix vencido sem pagamento não bloqueia um novo checkout.
    const expiresAt = subscription.pixExpiresAt
      ? new Date(subscription.pixExpiresAt)
      : null;
    return !expiresAt || expiresAt > now;
  }
  if (subscription.status === 'authorized') {
    // Após o fim do período pago o usuário pode renovar com um novo Pix.
    const periodEnd = subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd)
      : null;
    return !periodEnd || periodEnd > now;
  }
  return (
    subscription.status === 'cancelled' &&
    subscription.cancelAtPeriodEnd &&
    subscription.lastPaymentStatus === 'approved' &&
    subscription.currentPeriodEnd !== null &&
    new Date(subscription.currentPeriodEnd) > now
  );
}

class SubscriptionController {
  async checkout(request, response) {
    if (request.user.admin) {
      return response.status(403).json({
        message:
          'Administradores já têm acesso gratuito a todas as ferramentas.',
      });
    }

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
      where: {
        userId: request.user.id,
        status: 'pending',
        providerPaymentId: { [Op.ne]: null },
      },
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
          !existingSubscription.providerPaymentId &&
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
          existingSubscription?.status === 'pending' &&
          existingSubscription.pixExpiresAt &&
          new Date(existingSubscription.pixExpiresAt) <= new Date()
        ) {
          // O Pix venceu sem pagamento; libera o usuário para gerar outro.
          await existingSubscription.update(
            { status: 'expired' },
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
            accessUntil:
              existingSubscription.status === 'pending'
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
        : 'Você já possui um pagamento Pix pendente. Conclua o pagamento ou cancele-o para gerar um novo.';
      return response.status(409).json({ message });
    }

    const plan = subscriptionPlans[data.plan];
    const { subscription, user } = checkout;

    try {
      const payment = await createPixPayment({
        subscriptionId: subscription.id,
        user,
        plan,
      });
      await subscription.update({
        providerPaymentId: String(payment.id),
        pixQrCode: payment.qrCode,
        pixQrCodeBase64: payment.qrCodeBase64,
        pixExpiresAt: toDate(payment.expiresAt),
      });
      return response.status(201).json({
        id: subscription.id,
        plan: data.plan,
        status: 'pending',
        pix: {
          qrCode: payment.qrCode,
          qrCodeBase64: payment.qrCodeBase64,
          ticketUrl: payment.ticketUrl,
          expiresAt: payment.expiresAt,
        },
      });
    } catch (error) {
      await subscription.update({ status: 'failed' });
      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        console.error('Mercado Pago Pix payment creation failed:', error);
        return response.status(502).json({
          message: 'Não foi possível gerar o pagamento Pix no Mercado Pago.',
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
        pix:
          subscription.status === 'pending' && subscription.pixQrCode
            ? {
                qrCode: subscription.pixQrCode,
                qrCodeBase64: subscription.pixQrCodeBase64,
                expiresAt: subscription.pixExpiresAt,
              }
            : null,
      },
    });
  }

  async cancel(request, response) {
    const subscription = await Subscription.findOne({
      where: {
        userId: request.user.id,
        status: 'pending',
      },
      order: [['createdAt', 'DESC']],
    });

    if (!subscription) {
      return response.status(404).json({
        message: 'Não há um pagamento Pix pendente para cancelar.',
      });
    }

    if (!subscription.providerPaymentId) {
      // O pagamento nunca chegou ao Mercado Pago; basta descartar o registro.
      await subscription.update({ status: 'cancelled' });
      return response.status(200).json({
        id: subscription.id,
        status: 'cancelled',
      });
    }

    // Garante que o Pix não foi pago enquanto algum webhook se perdeu.
    await reconcileWithMercadoPago(subscription);
    await subscription.reload();
    if (subscription.status !== 'pending') {
      return response.status(409).json({
        message: 'Este pagamento já foi processado e não pode ser cancelado.',
      });
    }

    try {
      await cancelPayment(subscription.providerPaymentId);
      await subscription.update({ status: 'cancelled' });

      return response.status(200).json({
        id: subscription.id,
        status: 'cancelled',
      });
    } catch (error) {
      console.error('Mercado Pago Pix payment cancellation failed:', error);

      if (error instanceof MercadoPagoConfigurationError) {
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        return response.status(502).json({
          message: 'Não foi possível cancelar o pagamento Pix no Mercado Pago.',
        });
      }
      throw error;
    }
  }


  async webhook(request, response) {
    const isEmptyProbe =
      request.body &&
      typeof request.body === 'object' &&
      !Array.isArray(request.body) &&
      Object.keys(request.body).length === 0 &&
      !request.query['data.id'] &&
      !request.query.type &&
      !request.query.topic;
    if (isEmptyProbe) {
      return response.status(200).json({ received: true });
    }

    const dataId = String(
      request.body?.data?.id ??
        request.query['data.id'] ??
        request.query.id ??
        '',
    );
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!secret) {
      console.error('MERCADO_PAGO_WEBHOOK_SECRET não configurado.');
      return response.status(503).json({
        message: 'As notificações do Mercado Pago não estão configuradas.',
      });
    }

    const signatureFailure = getWebhookSignatureFailure({
      signature: request.get('x-signature'),
      requestId: request.get('x-request-id'),
      dataId,
      secret,
    });

    if (signatureFailure) {
      console.warn('Mercado Pago webhook signature validation failed:', {
        reason: signatureFailure,
        dataIdSource: request.body?.data?.id ? 'body' : 'query',
        notificationType:
          request.body?.type ??
          request.query.type ??
          request.query.topic ??
          null,
      });
      return response.status(401).json({
        message: 'Assinatura de notificação inválida.',
      });
    }

    const notificationType =
      request.body?.type ?? request.query.type ?? request.query.topic;

    try {
      if (notificationType === 'payment') {
        const payment = await getPayment(dataId);
        await synchronizePayment(payment);
      } else {
        console.warn(
          'Ignoring unsupported Mercado Pago notification type:',
          notificationType,
        );
      }
    } catch (error) {
      if (error instanceof MercadoPagoConfigurationError) {
        console.error('Mercado Pago webhook processing failed:', error);
        return response.status(503).json({
          message: 'Os pagamentos não estão configurados no servidor.',
        });
      }
      if (error instanceof MercadoPagoApiError) {
        console.error('Mercado Pago webhook processing failed:', error);
        return response.status(error.status || 502).json({
          message: 'Não foi possível processar a notificação do Mercado Pago.',
        });
      }
      console.error('Mercado Pago webhook processing failed:', error);
      throw error;
    }

    return response.status(200).json({ received: true });
  }
}

export default new SubscriptionController();
