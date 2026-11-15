import 'dotenv/config';
import * as yup from 'yup';
import User from '../app/models/user.js';
import { hashPassword } from '../app/services/passwords.js';
import database from '../database/index.js';

const credentialsSchema = yup.object({
  existingEmail: yup.string().trim().email().max(254).optional(),
  name: yup.string().trim().max(255).required(),
  email: yup.string().trim().email().max(254).required(),
  password: yup
    .string()
    .min(8)
    .max(128)
    .test(
      'bcrypt-byte-limit',
      'A senha deve ter no máximo 72 bytes em UTF-8.',
      (value) => !value || Buffer.byteLength(value, 'utf8') <= 72,
    )
    .required(),
});

function prompt(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Execute este comando em um terminal interativo.');
  }

  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';

    function finish(error) {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    function onData(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          finish(new Error('Configuração cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) {
              process.stdout.write('\b \b');
            }
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          if (!hidden) {
            process.stdout.write(character);
          }
        }
      }
    }

    process.stdin.on('data', onData);
  });
}

async function setupAdmin() {
  const existingEmail = await prompt(
    'E-mail atual da conta a promover/atualizar (Enter para criar nova): ',
  );
  const name = await prompt('Nome do gerenciador: ');
  const email = await prompt('Novo e-mail do gerenciador: ');
  const password = await prompt('Nova senha (mínimo 8 caracteres): ', {
    hidden: true,
  });
  const credentials = await credentialsSchema.validate(
    { existingEmail: existingEmail || undefined, name, email, password },
    { abortEarly: false },
  );

  await database.connection.authenticate();

  const user = credentials.existingEmail
    ? await User.findOne({
        where: { email: credentials.existingEmail.toLowerCase() },
      })
    : null;
  if (credentials.existingEmail && !user) {
    throw new Error('A conta informada para atualização não foi encontrada.');
  }

  const values = {
    name: credentials.name,
    email: credentials.email.toLowerCase(),
    password_hash: await hashPassword(credentials.password),
    admin: true,
  };

  if (user) {
    await user.update(values);
    console.log('Conta de administrador atualizada com sucesso.');
  } else {
    await User.create(values);
    console.log('Conta de administrador criada com sucesso.');
  }
}

try {
  await setupAdmin();
} catch (error) {
  console.error(
    `Não foi possível configurar o administrador: ${error.message}`,
  );
  process.exitCode = 1;
} finally {
  await database.connection.close();
}
