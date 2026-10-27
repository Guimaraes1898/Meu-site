import assert from 'node:assert/strict';
import { createHmac, scryptSync } from 'node:crypto';
import test from 'node:test';
import { jwtVerify } from 'jose';
import {
  createPreapproval,
  MercadoPagoApiError,
  verifyWebhookSignature,
} from '../src/app/services/MercadoPagoService.js';
import { hashPassword, verifyPassword } from '../src/app/services/passwords.js';
import { subscriptionPlans } from '../src/app/services/subscriptionPlans.js';
import { createAccessToken, getTokenKey } from '../src/app/services/tokens.js';

test('subscription plans use the agreed BRL prices and billing intervals', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(subscriptionPlans).map(([key, plan]) => [
        key,
        [plan.amount, plan.frequency],
      ]),
    ),
    {
      monthly: [5, 1],
      quarterly: [10, 3],
      semiannual: [20, 6],
    },
  );
});

test('password hashes verify only the original password', async () => {
  const encodedHash = await hashPassword('strong-test-password');

  assert.match(encodedHash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword('strong-test-password', encodedHash), true);
  assert.equal(await verifyPassword('incorrect-password', encodedHash), false);
  assert.equal(await verifyPassword('password', 'invalid-hash'), false);
  await assert.rejects(hashPassword('a'.repeat(73)), RangeError);
});

test('legacy scrypt password hashes remain valid', async () => {
  const password = 'legacy-test-password';
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = scryptSync(password, salt, 64).toString('hex');

  assert.equal(await verifyPassword(password, `scrypt:${salt}:${hash}`), true);
  assert.equal(
    await verifyPassword('incorrect-password', `scrypt:${salt}:${hash}`),
    false,
  );
});

test('access tokens are signed with the configured key and expire in one hour', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

  try {
    const token = await createAccessToken({ id: 'user-123' });
    const { payload } = await jwtVerify(token, getTokenKey(), {
      algorithms: ['HS256'],
    });

    assert.equal(payload.sub, 'user-123');
    assert.equal(payload.exp - payload.iat, 3600);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});

test('webhook signature rejects invalid or stale signatures', () => {
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const dataId = 'subscription-123';
  const requestId = 'request-123';
  const secret = 'webhook-test-secret';
  const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  const signature = `ts=${timestamp},v1=${v1}`;

  assert.equal(
    verifyWebhookSignature({
      signature,
      requestId,
      dataId,
      secret,
      now,
    }),
    true,
  );
  assert.equal(
    verifyWebhookSignature({
      signature,
      requestId: 'different-request',
      dataId,
      secret,
      now,
    }),
    false,
  );

  const staleTimestamp = timestamp - 301;
  const staleManifest = `id:${dataId};request-id:${requestId};ts:${staleTimestamp};`;
  const staleSignature = createHmac('sha256', secret)
    .update(staleManifest)
    .digest('hex');
  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${staleTimestamp},v1=${staleSignature}`,
      requestId,
      dataId,
      secret,
      now,
    }),
    false,
  );
});

test('checkout creates a Mercado Pago preapproval using the selected plan', async () => {
  const previousFetch = globalThis.fetch;
  const previousAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const previousBackUrl = process.env.MERCADO_PAGO_BACK_URL;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-access-token';
  process.env.MERCADO_PAGO_BACK_URL = 'https://example.com/return';
  let capturedRequest;
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return new Response(
      JSON.stringify({
        id: 'preapproval-123',
        init_point: 'https://www.mercadopago.com/checkout/123',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await createPreapproval({
      subscriptionId: 'subscription-123',
      email: 'member@example.com',
      plan: subscriptionPlans.quarterly,
    });

    assert.equal(result.id, 'preapproval-123');
    assert.equal(
      capturedRequest.url,
      'https://api.mercadopago.com/preapproval',
    );
    assert.equal(
      capturedRequest.options.headers['X-Idempotency-Key'],
      'subscription-123',
    );
    assert.deepEqual(JSON.parse(capturedRequest.options.body), {
      reason: 'Assinatura Trimestral',
      external_reference: 'subscription-123',
      payer_email: 'member@example.com',
      back_url: 'https://example.com/return',
      auto_recurring: {
        frequency: 3,
        frequency_type: 'months',
        transaction_amount: 10,
        currency_id: 'BRL',
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAccessToken === undefined) {
      delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    } else {
      process.env.MERCADO_PAGO_ACCESS_TOKEN = previousAccessToken;
    }
    if (previousBackUrl === undefined) {
      delete process.env.MERCADO_PAGO_BACK_URL;
    } else {
      process.env.MERCADO_PAGO_BACK_URL = previousBackUrl;
    }
  }
});

test('checkout errors expose only a safe Mercado Pago status and code', async () => {
  const previousFetch = globalThis.fetch;
  const previousAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const previousBackUrl = process.env.MERCADO_PAGO_BACK_URL;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-access-token';
  process.env.MERCADO_PAGO_BACK_URL = 'https://example.com/return';
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: 'bad_request',
        message: 'Invalid payer email: member@example.com',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    await assert.rejects(
      createPreapproval({
        subscriptionId: 'subscription-123',
        email: 'member@example.com',
        plan: subscriptionPlans.monthly,
      }),
      (error) => {
        assert.ok(error instanceof MercadoPagoApiError);
        assert.equal(error.status, 400);
        assert.equal(error.providerCode, 'bad_request');
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAccessToken === undefined) {
      delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    } else {
      process.env.MERCADO_PAGO_ACCESS_TOKEN = previousAccessToken;
    }
    if (previousBackUrl === undefined) {
      delete process.env.MERCADO_PAGO_BACK_URL;
    } else {
      process.env.MERCADO_PAGO_BACK_URL = previousBackUrl;
    }
  }
});
