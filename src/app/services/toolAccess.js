import { Op } from 'sequelize';
import Subscription from '../models/subscription.js';
import User from '../models/user.js';
import UserToolUsage from '../models/userToolUsage.js';

export const toolDefinitions = Object.freeze({
  'identify-fish': Object.freeze({ trialLimit: 1 }),
  'calculate-liters': Object.freeze({ trialLimit: 1 }),
  'plan-fauna': Object.freeze({ trialLimit: 0 }),
  'find-stores': Object.freeze({ trialLimit: 0 }),
});

export function isSubscriptionActive(subscription, now = new Date()) {
  if (subscription?.lastPaymentStatus !== 'approved') {
    return false;
  }

  const periodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;
  const periodIsCurrent = !periodEnd || periodEnd > now;

  if (subscription.status === 'authorized') {
    return periodIsCurrent;
  }

  return (
    subscription.status === 'cancelled' &&
    subscription.cancelAtPeriodEnd &&
    periodEnd !== null &&
    periodEnd > now
  );
}

async function findCurrentSubscription(userId, options = {}) {
  return Subscription.findOne({
    where: {
      userId,
      [Op.or]: [
        { status: { [Op.in]: ['authorized', 'cancelled'] } },
        { status: 'pending' },
      ],
    },
    order: [['createdAt', 'DESC']],
    ...options,
  });
}

export async function getToolStatus(userId, now = new Date()) {
  const [user, subscription, usages] = await Promise.all([
    User.findByPk(userId),
    findCurrentSubscription(userId),
    UserToolUsage.findAll({ where: { userId } }),
  ]);

  if (!user) {
    return null;
  }

  const usageByTool = Object.fromEntries(
    usages.map(({ tool, usageCount }) => [tool, usageCount]),
  );
  const subscriptionActive = isSubscriptionActive(subscription, now);
  const tools = Object.fromEntries(
    Object.entries(toolDefinitions).map(([tool, { trialLimit }]) => {
      const used = usageByTool[tool] ?? 0;
      return [
        tool,
        {
          allowed: subscriptionActive || used < trialLimit,
          used,
          trialLimit,
          remaining: subscriptionActive ? null : Math.max(0, trialLimit - used),
        },
      ];
    }),
  );

  return {
    user: { id: user.id, name: user.name, email: user.email },
    subscriptionActive,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          hasProviderSubscription: Boolean(subscription.providerSubscriptionId),
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          lastPaymentStatus: subscription.lastPaymentStatus,
        }
      : null,
    tools,
  };
}

export async function executeAuthorizedTool(
  userId,
  tool,
  operation,
  now = new Date(),
) {
  if (!Object.hasOwn(toolDefinitions, tool)) {
    return { invalidTool: true };
  }

  return User.sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) {
      return { userNotFound: true };
    }

    const subscription = await findCurrentSubscription(userId, {
      transaction,
    });
    if (isSubscriptionActive(subscription, now)) {
      return {
        allowed: true,
        subscriptionActive: true,
        remaining: null,
        value: await operation(),
      };
    }

    const { trialLimit } = toolDefinitions[tool];
    const usage = await UserToolUsage.findOne({
      where: { userId, tool },
      transaction,
    });
    const used = usage?.usageCount ?? 0;

    if (used >= trialLimit) {
      return {
        allowed: false,
        subscriptionActive: false,
        used,
        trialLimit,
        remaining: 0,
      };
    }

    const value = await operation();

    if (usage) {
      await usage.update({ usageCount: used + 1 }, { transaction });
    } else {
      await UserToolUsage.create(
        { userId, tool, usageCount: 1 },
        { transaction },
      );
    }

    return {
      allowed: true,
      subscriptionActive: false,
      used: used + 1,
      trialLimit,
      remaining: trialLimit - used - 1,
      value,
    };
  });
}
