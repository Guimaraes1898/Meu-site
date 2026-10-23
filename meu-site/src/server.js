import app from './app.js';
import database from './database/index.js';

const port = Number(process.env.PORT || 3001);

try {
  await database.connection.authenticate();
  console.log('Database connection established.');

  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
} catch (error) {
  console.error('Unable to start the server:', error);
  process.exitCode = 1;
}
