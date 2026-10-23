import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DatabaseError } from 'sequelize';
import routes from './routes.js';

const app = express();
const publicDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public',
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(routes);
app.use(express.static(publicDirectory));
app.use((error, _request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }
  console.error('Unhandled request error:', error);
  if (error.type === 'entity.too.large') {
    return response.status(413).json({
      message: 'A imagem deve ter no máximo 2 MB após a compactação.',
    });
  }
  if (error instanceof DatabaseError && error.parent?.code === '42P01') {
    return response.status(503).json({
      message:
        'A tabela necessária não existe no banco de dados. Execute "pnpm db:migrate" e tente novamente.',
    });
  }
  return response.status(500).json({
    message: 'Ocorreu um erro interno no servidor.',
  });
});

export default app;
