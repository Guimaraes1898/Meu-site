import express, { Router } from 'express';
import AccountController from './app/controllers/AccountController.js';
import FishController from './app/controllers/FishController.js';
import SessionController from './app/controllers/SessionController.js';
import SubscriptionController from './app/controllers/SubscriptionController.js';
import ToolController from './app/controllers/ToolController.js';
import UserController from './app/controllers/UserController.js';
import authenticate from './app/middlewares/authenticate.js';

const routes = new Router();

routes.get('/account/me', authenticate, AccountController.show);
routes.post(
  '/fish/identify',
  authenticate,
  express.raw({ type: 'image/jpeg', limit: '2mb' }),
  FishController.identify,
);
routes.post(
  '/tools/calculate-liters',
  authenticate,
  ToolController.calculateLiters,
);
routes.post('/tools/plan-fauna', authenticate, ToolController.planFauna);
routes.post('/tools/find-stores', authenticate, ToolController.findStores);
routes.post('/users', UserController.store);
routes.post('/sessions', SessionController.store);

routes.post(
  '/subscriptions/checkout',
  authenticate,
  SubscriptionController.checkout,
);
routes.get('/subscriptions/me', authenticate, SubscriptionController.show);
routes.post(
  '/subscriptions/cancel',
  authenticate,
  SubscriptionController.cancel,
);
routes.post('/webhooks/mercadopago', SubscriptionController.webhook);

export default routes;
