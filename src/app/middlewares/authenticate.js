import { jwtVerify } from 'jose';
import User from '../models/user.js';
import { getTokenKey, TokenConfigurationError } from '../services/tokens.js';

async function authenticate(request, response, next) {
  const authorization = request.get('authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    return response.status(401).json({
      message: 'Autenticação necessária.',
    });
  }

  let key;
  try {
    key = getTokenKey();
  } catch (error) {
    if (error instanceof TokenConfigurationError) {
      return response.status(503).json({
        message: 'A autenticação não está configurada no servidor.',
      });
    }
    throw error;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
    }));
  } catch {
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  if (typeof payload.sub !== 'string') {
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  const user = await User.findByPk(payload.sub);
  if (!user) {
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  request.user = user;
  return next();
}

export default authenticate;
