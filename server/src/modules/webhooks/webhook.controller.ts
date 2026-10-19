import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { processStripeWebhookEvent } from './webhook.service.js';

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'];

  if (!signature || typeof signature !== 'string') {
    res.status(400).json({
      success: false,
      error: {
        message: 'Missing Stripe signature header',
        statusCode: 400,
      },
    });
    return;
  }

  if (!req.rawBody) {
    res.status(400).json({
      success: false,
      error: {
        message: 'Raw body buffer missing; ensure request body was preserved',
        statusCode: 400,
      },
    });
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    if (env.STRIPE_WEBHOOK_SECRET === 'whsec_placeholder') {
      console.warn(
        'Webhook signature verification failed: STRIPE_WEBHOOK_SECRET is set to placeholder "whsec_placeholder". Update STRIPE_WEBHOOK_SECRET in server/.env with the signing secret from "stripe listen" or Stripe Dashboard.'
      );
    } else {
      console.error('Webhook signature verification failed:', err.message);
    }
    res.status(400).json({
      success: false,
      error: {
        message: `Webhook signature verification failed: ${err.message}`,
        statusCode: 400,
      },
    });
    return;
  }

  try {
    const result = await processStripeWebhookEvent(event);
    res.status(200).json({ received: true, ...result });
  } catch (error: any) {
    console.error('Error executing webhook fulfillment:', error);
    res.status(500).json({
      success: false,
      error: {
        message: 'Webhook processing error',
        statusCode: 500,
      },
    });
  }
}
