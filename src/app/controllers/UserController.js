import { UniqueConstraintError } from 'sequelize';
import * as yup from 'yup';
import User from '../models/user.js';
import { hashPassword } from '../services/passwords.js';

const userSchema = yup.object({
  name: yup
    .string()
    .typeError('O nome deve ser um texto.')
    .trim()
    .max(255, 'O nome deve ter no máximo 255 caracteres.')
    .required('O nome é obrigatório.'),
  email: yup
    .string()
    .typeError('O e-mail deve ser um texto.')
    .trim()
    .email('Informe um endereço de e-mail válido.')
    .max(254, 'O e-mail deve ter no máximo 254 caracteres.')
    .required('O e-mail é obrigatório.'),
  password: yup
    .string()
    .typeError('A senha deve ser um texto.')
    .min(8, 'A senha deve ter pelo menos 8 caracteres.')
    .max(128, 'A senha deve ter no máximo 128 caracteres.')
    .test(
      'bcrypt-byte-limit',
      'A senha deve ter no máximo 72 bytes em UTF-8.',
      (value) => !value || Buffer.byteLength(value, 'utf8') <= 72,
    )
    .required('A senha é obrigatória.'),
});

class UserController {
  async store(request, response) {
    let validatedData;

    try {
      validatedData = await userSchema.validate(request.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
    } catch (error) {
      if (error instanceof yup.ValidationError) {
        return response.status(400).json({
          message:
            'Não foi possível criar a conta. Confira os campos informados.',
          errors: error.inner.map(({ path, message }) => ({
            field: path ?? 'form',
            message,
          })),
        });
      }
      throw error;
    }

    const { name, email, password } = validatedData;
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return response
        .status(400)
        .json({ message: 'Este e-mail já está cadastrado.' });
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password_hash: passwordHash,
        admin: false,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        return response
          .status(400)
          .json({ message: 'Este e-mail já está cadastrado.' });
      }
      throw error;
    }

    return response.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      admin: user.admin,
    });
  }
}

export default new UserController();
