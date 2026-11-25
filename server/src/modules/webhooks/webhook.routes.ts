import { Router } from 'express';
import { handleStripeConnectWebhook, handleStripeWebhook } from './webhook.controller.js';

export const webhookRouter = Router();

webhookRouter.post('/stripe', handleStripeWebhook);
webhookRouter.post('/stripe/connect', handleStripeConnectWebhook);
