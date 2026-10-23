import * as yup from 'yup';
import User from '../models/user.js';
import { verifyPassword } from '../services/passwords.js';
import {
  createAccessToken,
  TokenConfigurationError,
} from '../services/tokens.js';

const sessionSchema = yup.object({
  email: yup.string().trim().email().max(254).required(),
  password: yup.string().max(128).required(),
});

class SessionController {
  async store(request, response) {
    let credentials;
    try {
      credentials = await sessionSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message: 'Informe um e-mail e uma senha válidos.',
        });
      }
      throw error;
    }

    const user = await User.findOne({
      where: { email: credentials.email.toLowerCase() },
    });
    const passwordIsValid =
      user && (await verifyPassword(credentials.password, user.password_hash));

    if (!passwordIsValid) {
      return response.status(401).json({
        message: 'E-mail ou senha inválidos.',
      });
    }

    try {
      const token = await createAccessToken(user);
      return response.status(200).json({
        token,
        tokenType: 'Bearer',
        expiresIn: 3600,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          admin: user.admin,
        },
      });
    } catch (error) {
      if (error instanceof TokenConfigurationError) {
        return response.status(503).json({
          message: 'A autenticação não está configurada no servidor.',
        });
      }
      throw error;
    }
  }
}

export default new SessionController();
