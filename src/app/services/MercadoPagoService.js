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

const PIX_EXPIRATION_MS = 24 * 60 * 60 * 1000;

export async function createPixPayment({ subscriptionId, user, plan }) {
  const [firstName, ...lastNameParts] = user.name.trim().split(/\s+/);
  const payer = {
    email: user.email,
    first_name: firstName,
  };
  if (lastNameParts.length > 0) {
    payer.last_name = lastNameParts.join(' ');
  }
  if (user.cpf) {
    payer.identification = { type: 'CPF', number: user.cpf };
  }

  const result = await request('/v1/payments', {
    method: 'POST',
    idempotencyKey: subscriptionId,
    body: {
      transaction_amount: plan.amount,
      description: `Assinatura ${plan.name}`,
      payment_method_id: 'pix',
      external_reference: subscriptionId,
      date_of_expiration: new Date(
        Date.now() + PIX_EXPIRATION_MS,
      ).toISOString(),
      payer,
    },
  });

  const transactionData = result.point_of_interaction?.transaction_data;
  if (
    (typeof result.id !== 'number' && typeof result.id !== 'string') ||
    typeof transactionData?.qr_code !== 'string' ||
    typeof transactionData?.qr_code_base64 !== 'string'
  ) {
    throw new MercadoPagoApiError(
      502,
      'Mercado Pago did not return a Pix QR code for the payment.',
    );
  }

  return {
    id: result.id,
    status: result.status,
    qrCode: transactionData.qr_code,
    qrCodeBase64: transactionData.qr_code_base64,
    ticketUrl: transactionData.ticket_url,
    expiresAt: result.date_of_expiration,
  };
}

export async function getPayment(id) {
  return request(`/v1/payments/${encodeURIComponent(id)}`);
}

export async function cancelPayment(id) {
  return request(`/v1/payments/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { status: 'cancelled' },
  });
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

  const received = Buffer.from(fields.v1, 'hex');
  // O Mercado Pago omite do manifest os campos ausentes na notificação
  // (ex.: uma notificação pode ser assinada sem o data.id), então
  // validamos contra as variantes documentadas.
  const manifestCandidates = [
    `id:${dataId.toLowerCase()};request-id:${requestId};ts:${fields.ts};`,
    `request-id:${requestId};ts:${fields.ts};`,
    `id:${dataId.toLowerCase()};ts:${fields.ts};`,
  ];
  const matches = manifestCandidates.some((manifest) => {
    const expected = createHmac('sha256', secret).update(manifest).digest();
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
  if (!matches) {
    return 'signature_mismatch';
  }
  return null;
}
