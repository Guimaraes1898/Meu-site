import { SignJWT } from 'jose';

export class TokenConfigurationError extends Error {
  constructor() {
    super('JWT_SECRET must contain at least 32 characters.');
    this.name = 'TokenConfigurationError';
  }
}

export function getTokenKey() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TokenConfigurationError();
  }
  return new TextEncoder().encode(secret);
}

export async function createAccessToken(user) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getTokenKey());
}
