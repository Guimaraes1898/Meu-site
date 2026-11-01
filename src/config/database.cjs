require('dotenv').config();

if (!process.env.DB_PASSWORD) {
  throw new Error(
    'DB_PASSWORD não foi definida. Copie .env.example para .env e informe a senha do PostgreSQL usada no Beekeeper.',
  );
}

// Todas as configurações vêm das variáveis DB_*; em produção o Docker Compose
// injeta DB_HOST=db e DB_PORT=5432 no serviço app.
const config = {
  dialect: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'que-peixe-e-esse-db',
  define: {
    timestamps: true,
    underscored: true,
  },
  logging: process.env.NODE_ENV === 'production' ? false : undefined,
};

module.exports = {
  development: config,
  test: config,
  production: config,
};
