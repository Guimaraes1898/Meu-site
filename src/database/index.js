import { Sequelize } from 'sequelize';
import Subscription from '../app/models/subscription.js';
import User from '../app/models/user.js';
import UserToolUsage from '../app/models/userToolUsage.js';
import databaseConfig from '../config/database.cjs';

const models = [User, Subscription, UserToolUsage];
const environment = process.env.NODE_ENV || 'development';
const config = databaseConfig[environment];

if (!config) {
  throw new Error(`No database configuration found for "${environment}"`);
}

class Database {
  constructor() {
    this.connection = new Sequelize(config);

    models.forEach((model) => {
      model.init(this.connection);
    });
  }
}

export default new Database();
