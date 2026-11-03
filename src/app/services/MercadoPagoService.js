import { createHmac, timingSafeEqual } from 'node:crypto';

const apiBaseUrl = 'https://api.mercadopago.com';

export class MercadoPagoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MercadoPagoConfigurationError';
  }
}

export class MercadoPagoApiError extends Error {
  constructor(status, message, providerCode) {
    super(message);
    this.name = 'MercadoPagoApiError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

function getAccessToken() {
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!accessToken) {
    throw new MercadoPagoConfigurationError(
      'MERCADO_PAGO_ACCESS_TOKEN is not configured.',
    );
  }
  return accessToken;
}

async function request(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${getAccessToken()}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new MercadoPagoApiError(
      response.status,
      'Mercado Pago returned an invalid response.',
    );
  }

  if (!response.ok) {
    const reason = [data?.code, data?.message]
      .filter((value) => typeof value === 'string')
      .join(': ');
    const providerCode = [
      data?.code,
      data?.error,
      ...(Array.isArray(data?.cause)
        ? data.cause.map((cause) => cause?.code)
        : []),
    ].find(
      (value) =>
        Number.isSafeInteger(value) ||
        (typeof value === 'string' && /^[a-z\d._-]{1,80}$/i.test(value)),
    );
    throw new MercadoPagoApiError(
      response.status,
      `Mercado Pago request failed with status ${response.status}${reason ? ` (${reason})` : ''}.`,
      providerCode === undefined ? undefined : String(providerCode),
    );
  }

  return data;
}

export async function createPreapproval({ subscriptionId, email, plan }) {
  const backUrl = process.env.MERCADO_PAGO_BACK_URL;
  if (!backUrl) {
    throw new MercadoPagoConfigurationError(
      'MERCADO_PAGO_BACK_URL is not configured.',
    );
  }
  let parsedBackUrl;
  try {
    parsedBackUrl = new URL(backUrl);
  } catch {
    throw new MercadoPagoConfigurationError(
      'MERCADO_PAGO_BACK_URL must be a valid HTTP(S) URL.',
    );
  }
  if (
    !['https:', 'http:'].includes(parsedBackUrl.protocol) ||
    (parsedBackUrl.protocol === 'http:' &&
      !['que-peixe-e-esse.com'].includes(parsedBackUrl.hostname)) // <-- Ajuste o hostname aqui para o domínio completo
  ) {
    throw new MercadoPagoConfigurationError(
      'MERCADO_PAGO_BACK_URL must use HTTPS outside localhost.',
    );
  }

  // --- Crie o payload em uma variável ANTES de usar ---
  const mercadoPagoPayload = {
    reason: `Assinatura ${plan.name}`,
    external_reference: subscriptionId,
    payer_email: email,
    back_url: backUrl,
    auto_recurring: {
      frequency: plan.frequency,
      frequency_type: 'months', // <-- VERIFIQUE SE plan.frequency_type DEVERIA SER USADO AQUI ou se 'months' é fixo
      transaction_amount: plan.amount,
      currency_id: 'BRL',
    },
  };

  console.log('Mercado Pago Preapproval Payload:', JSON.stringify(mercadoPagoPayload, null, 2)); // <-- AGORA VAI FUNCIONAR

  const result = await request('/preapproval', {
    method: 'POST',
    idempotencyKey: subscriptionId,
    body: mercadoPagoPayload, // <-- Passe a variável payload aqui
  });

  if (typeof result.id !== 'string' || typeof result.init_point !== 'string') {
    throw new MercadoPagoApiError(
      502,
      'Mercado Pago did not return a subscription ID and checkout URL.',
    );
  }

  return result;
}

export async function getAuthorizedPayment(id) {
  return request(`/authorized_payments/${encodeURIComponent(id)}`);
}

export function verifyWebhookSignature({
  signature,
  requestId,
  dataId,
  secret,
  now = Date.now(),
}) {
  return (
    getWebhookSignatureFailure({
      signature,
      requestId,
      dataId,
      secret,
      now,
    }) === null
  );
}

export function getWebhookSignatureFailure({
  signature,
  requestId,
  dataId,
  secret,
  now = Date.now(),
}) {
  if (!signature || !requestId || !dataId || !secret) {
    return 'missing_fields';
  }

  const fields = Object.fromEntries(
    signature.split(',').map((part) => {
      const [key, value] = part.trim().split('=');
      return [key, value];
    }),
  );
  const timestamp = Number(fields.ts);
  if (
    !Number.isSafeInteger(timestamp) ||
    !/^[a-f\d]{64}$/i.test(fields.v1 ?? '')
  ) {
    return 'invalid_format';
  }
  if (Math.abs(Math.floor(now / 1000) - timestamp) > 300) {
    return 'timestamp_out_of_range';
  }

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${fields.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(fields.v1, 'hex');
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return 'signature_mismatch';
  }
  return null;
}
