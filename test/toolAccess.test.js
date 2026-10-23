import assert from 'node:assert/strict';
import test from 'node:test';
import Subscription from '../src/app/models/subscription.js';
import User from '../src/app/models/user.js';
import UserToolUsage from '../src/app/models/userToolUsage.js';
import {
  executeAuthorizedTool,
  isSubscriptionActive,
  toolDefinitions,
} from '../src/app/services/toolAccess.js';

async function withAccessModels({ subscription = null, usage = null }, run) {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const originalDescriptors = [
    [User, 'sequelize', Object.getOwnPropertyDescriptor(User, 'sequelize')],
    [User, 'findByPk', Object.getOwnPropertyDescriptor(User, 'findByPk')],
    [
      Subscription,
      'findOne',
      Object.getOwnPropertyDescriptor(Subscription, 'findOne'),
    ],
    [
      UserToolUsage,
      'findOne',
      Object.getOwnPropertyDescriptor(UserToolUsage, 'findOne'),
    ],
    [
      UserToolUsage,
      'create',
      Object.getOwnPropertyDescriptor(UserToolUsage, 'create'),
    ],
  ];
  const createdUsages = [];

  Object.defineProperty(User, 'sequelize', {
    configurable: true,
    value: {
      transaction: (callback) => callback(transaction),
    },
  });
  Object.defineProperty(User, 'findByPk', {
    configurable: true,
    value: async (_userId, options) => {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, transaction.LOCK.UPDATE);
      return { id: 'user-id' };
    },
  });
  Object.defineProperty(Subscription, 'findOne', {
    configurable: true,
    value: async (_options) => subscription,
  });
  Object.defineProperty(UserToolUsage, 'findOne', {
    configurable: true,
    value: async () => usage,
  });
  Object.defineProperty(UserToolUsage, 'create', {
    configurable: true,
    value: async (values, options) => {
      createdUsages.push({ values, options });
      return values;
    },
  });

  try {
    return await run({ createdUsages, transaction });
  } finally {
    for (const [model, key, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(model, key, descriptor);
      } else {
        delete model[key];
      }
    }
  }
}

test('trial limits allow one use of identification and aquarium calculation only', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(toolDefinitions).map(([tool, definition]) => [
        tool,
        definition.trialLimit,
      ]),
    ),
    {
      'identify-fish': 1,
      'calculate-liters': 1,
      'plan-fauna': 0,
      'find-stores': 0,
    },
  );
});

test('paid subscription is active only after an approved payment', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');
  const activeSubscription = {
    status: 'authorized',
    lastPaymentStatus: 'approved',
    currentPeriodEnd: '2026-11-21T12:00:00.000Z',
  };

  assert.equal(isSubscriptionActive(activeSubscription, now), true);
  assert.equal(
    isSubscriptionActive(
      { ...activeSubscription, lastPaymentStatus: 'pending' },
      now,
    ),
    false,
  );
  assert.equal(
    isSubscriptionActive(
      { ...activeSubscription, currentPeriodEnd: '2026-10-20T12:00:00.000Z' },
      now,
    ),
    false,
  );
});

test('cancelled subscription remains active through its paid period only', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');
  const cancelledSubscription = {
    status: 'cancelled',
    cancelAtPeriodEnd: true,
    lastPaymentStatus: 'approved',
    currentPeriodEnd: '2026-11-21T12:00:00.000Z',
  };

  assert.equal(isSubscriptionActive(cancelledSubscription, now), true);
  assert.equal(
    isSubscriptionActive(
      { ...cancelledSubscription, currentPeriodEnd: null },
      now,
    ),
    false,
  );
  assert.equal(
    isSubscriptionActive(
      { ...cancelledSubscription, cancelAtPeriodEnd: false },
      now,
    ),
    false,
  );
});

test('successful operation consumes its free trial within the user lock', async () => {
  await withAccessModels({}, async ({ createdUsages, transaction }) => {
    const result = await executeAuthorizedTool(
      'user-id',
      'identify-fish',
      async () => ({ identified: true }),
    );

    assert.equal(result.allowed, true);
    assert.deepEqual(result.value, { identified: true });
    assert.equal(result.remaining, 0);
    assert.equal(createdUsages.length, 1);
    assert.deepEqual(createdUsages[0].values, {
      userId: 'user-id',
      tool: 'identify-fish',
      usageCount: 1,
    });
    assert.equal(createdUsages[0].options.transaction, transaction);
  });
});

test('tool is denied after its free trial and the operation is not run', async () => {
  const usage = { usageCount: 1 };
  await withAccessModels({ usage }, async ({ createdUsages }) => {
    let operationCalled = false;
    const result = await executeAuthorizedTool(
      'user-id',
      'identify-fish',
      async () => {
        operationCalled = true;
      },
    );

    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.equal(operationCalled, false);
    assert.equal(createdUsages.length, 0);
  });
});

test('premium tools are denied without an active subscription', async () => {
  await withAccessModels({}, async ({ createdUsages }) => {
    let operationCalled = false;
    const result = await executeAuthorizedTool(
      'user-id',
      'plan-fauna',
      async () => {
        operationCalled = true;
      },
    );

    assert.equal(result.allowed, false);
    assert.equal(operationCalled, false);
    assert.equal(createdUsages.length, 0);
  });
});

test('failed operation does not consume the free trial', async () => {
  await withAccessModels({}, async ({ createdUsages }) => {
    await assert.rejects(
      executeAuthorizedTool('user-id', 'identify-fish', async () => {
        throw new Error('AI unavailable');
      }),
      /AI unavailable/,
    );
    assert.equal(createdUsages.length, 0);
  });
});
