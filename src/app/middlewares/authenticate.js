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
import { jwtVerify } from 'jose';
import User from '../models/user.js';
import { getTokenKey, TokenConfigurationError } from '../services/tokens.js';

async function authenticate(request, response, next) {
  console.log('*** Middleware authenticate foi chamado! ***'); // <-- Este você já adicionou
  const authorization = request.get('authorization');
  console.log('Authorization Header:', authorization); // <-- NOVO LOG
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    console.warn('Autenticação falhou: Token Bearer não encontrado.'); // <-- NOVO LOG
    return response.status(401).json({
      message: 'Autenticação necessária.',
    });
  }
  console.log('Token encontrado (primeiros 10 chars):', token.substring(0, 10) + '...'); // <-- NOVO LOG

  let key;
  try {
    key = getTokenKey();
  } catch (error) {
    if (error instanceof TokenConfigurationError) {
      console.error('ERRO: Autenticação falhou: JWT_SECRET não configurado.', error); 
      return response.status(503).json({
        message: 'A autenticação não está configurada no servidor.',
      });
    }
    console.error('ERRO INESPERADO no getTokenKey:', error); 
    throw error;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
    }));
    console.log('Token JWT verificado com sucesso. Payload:', payload);
  } catch (e) { 
    console.warn('Autenticação falhou: Token inválido ou expirado.', e.message); 
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  if (typeof payload.sub !== 'string') {
    console.warn('Autenticação falhou: Payload.sub inválido.', payload.sub); 
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  const user = await User.findByPk(payload.sub);
  if (!user) {
    console.warn('Autenticação falhou: Usuário não encontrado para payload.sub:', payload.sub); // <-- NOVO LOG
    return response.status(401).json({
      message: 'Token inválido ou expirado.',
    });
  }

  console.log('Usuário autenticado:', user.email); 
  request.user = user;
  return next();
}

export default authenticate;
