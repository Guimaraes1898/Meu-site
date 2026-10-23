import assert from 'node:assert/strict';
import test from 'node:test';
import UserController from '../src/app/controllers/UserController.js';

test('user registration explains which fields are invalid', async () => {
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

  await UserController.store(
    {
      body: {
        name: '',
        email: 'invalid-email',
        password: 'short',
      },
    },
    response,
  );

  assert.equal(statusCode, 400);
  assert.deepEqual(responseBody, {
    message: 'Não foi possível criar a conta. Confira os campos informados.',
    errors: [
      { field: 'name', message: 'O nome é obrigatório.' },
      { field: 'email', message: 'Informe um endereço de e-mail válido.' },
      {
        field: 'password',
        message: 'A senha deve ter pelo menos 8 caracteres.',
      },
    ],
  });
});

test('user registration rejects passwords longer than bcrypt supports', async () => {
  let responseBody;
  const response = {
    status() {
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await UserController.store(
    {
      body: {
        name: 'Example User',
        email: 'example@example.com',
        password: 'a'.repeat(73),
      },
    },
    response,
  );

  assert.deepEqual(responseBody.errors, [
    {
      field: 'password',
      message: 'A senha deve ter no máximo 72 bytes em UTF-8.',
    },
  ]);
});
