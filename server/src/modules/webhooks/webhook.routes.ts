import { Router } from 'express';
import { handleStripeWebhook } from './webhook.controller.js';

export const webhookRouter = Router();

webhookRouter.post('/stripe', handleStripeWebhook);
