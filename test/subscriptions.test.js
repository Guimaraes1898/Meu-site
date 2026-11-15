import assert from 'node:assert/strict';
import { createHmac, scryptSync } from 'node:crypto';
import test from 'node:test';
import { jwtVerify } from 'jose';
import SubscriptionController from '../src/app/controllers/SubscriptionController.js';
import {
  createPixPayment,
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

test('administrator checkout is rejected without creating a payment', async () => {
  let statusCode;
  let responseBody;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await SubscriptionController.checkout(
    { user: { admin: true }, body: { plan: 'monthly' } },
    response,
  );

  assert.equal(statusCode, 403);
  assert.equal(
    responseBody.message,
    'Administradores já têm acesso gratuito a todas as ferramentas.',
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

test('webhook signature accepts manifests with omitted fields', () => {
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const dataId = 'subscription-123';
  const requestId = 'request-123';
  const secret = 'webhook-test-secret';

  const withoutDataId = createHmac('sha256', secret)
    .update(`request-id:${requestId};ts:${timestamp};`)
    .digest('hex');
  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${timestamp},v1=${withoutDataId}`,
      requestId,
      dataId,
      secret,
      now,
    }),
    true,
  );

  const withoutRequestId = createHmac('sha256', secret)
    .update(`id:${dataId};ts:${timestamp};`)
    .digest('hex');
  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${timestamp},v1=${withoutRequestId}`,
      requestId,
      dataId,
      secret,
      now,
    }),
    true,
  );

  const tampered = createHmac('sha256', secret)
    .update(`id:other-id;request-id:${requestId};ts:${timestamp};`)
    .digest('hex');
  assert.equal(
    verifyWebhookSignature({
      signature: `ts=${timestamp},v1=${tampered}`,
      requestId,
      dataId,
      secret,
      now,
    }),
    false,
  );
});

test('checkout creates a Mercado Pago Pix payment using the selected plan', async () => {
  const previousFetch = globalThis.fetch;
  const previousAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-access-token';
  let capturedRequest;
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return new Response(
      JSON.stringify({
        id: 123456789,
        status: 'pending',
        date_of_expiration: '2026-11-10T12:00:00.000Z',
        point_of_interaction: {
          transaction_data: {
            qr_code: 'pix-copia-e-cola',
            qr_code_base64: 'aW1hZ2VtLXBpeA==',
            ticket_url: 'https://www.mercadopago.com.br/payments/123/ticket',
          },
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await createPixPayment({
      subscriptionId: 'subscription-123',
      user: {
        name: 'Maria Silva',
        email: 'member@example.com',
        cpf: '12345678909',
      },
      plan: subscriptionPlans.quarterly,
    });

    assert.equal(result.id, 123456789);
    assert.equal(result.qrCode, 'pix-copia-e-cola');
    assert.equal(result.qrCodeBase64, 'aW1hZ2VtLXBpeA==');
    assert.equal(result.expiresAt, '2026-11-10T12:00:00.000Z');
    assert.equal(
      capturedRequest.url,
      'https://api.mercadopago.com/v1/payments',
    );
    assert.equal(
      capturedRequest.options.headers['X-Idempotency-Key'],
      'subscription-123',
    );
    const body = JSON.parse(capturedRequest.options.body);
    assert.equal(body.transaction_amount, 10);
    assert.equal(body.description, 'Assinatura Trimestral');
    assert.equal(body.payment_method_id, 'pix');
    assert.equal(body.external_reference, 'subscription-123');
    assert.deepEqual(body.payer, {
      email: 'member@example.com',
      first_name: 'Maria',
      last_name: 'Silva',
      identification: { type: 'CPF', number: '12345678909' },
    });
    const expiresAt = new Date(body.date_of_expiration);
    assert.ok(!Number.isNaN(expiresAt.getTime()));
    const expirationMs = expiresAt.getTime() - Date.now();
    assert.ok(expirationMs > 23 * 60 * 60 * 1000);
    assert.ok(expirationMs <= 24 * 60 * 60 * 1000);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAccessToken === undefined) {
      delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    } else {
      process.env.MERCADO_PAGO_ACCESS_TOKEN = previousAccessToken;
    }
  }
});

test('checkout errors expose only a safe Mercado Pago status and code', async () => {
  const previousFetch = globalThis.fetch;
  const previousAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-access-token';
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
      createPixPayment({
        subscriptionId: 'subscription-123',
        user: { name: 'Maria Silva', email: 'member@example.com' },
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
  }
});
