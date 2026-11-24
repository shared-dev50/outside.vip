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

  const platformSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  const rawConnectSecret = (
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET ??
    env.STRIPE_CONNECT_WEBHOOK_SECRET ??
    ''
  ).trim();
  const connectSecret =
    rawConnectSecret && rawConnectSecret !== platformSecret ? rawConnectSecret : '';

  let parsedEnvelope: { account?: unknown } | null = null;
  try {
    const rawText = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : String(req.rawBody);
    parsedEnvelope = JSON.parse(rawText) as { account?: unknown };
  } catch {
    res.status(400).json({
      success: false,
      error: {
        message: 'Invalid webhook payload JSON',
        statusCode: 400,
      },
    });
    return;
  }

  const envelopeAccount =
    typeof parsedEnvelope?.account === 'string' ? parsedEnvelope.account.trim() : '';
  const isConnectScopedEvent = envelopeAccount.length > 0;

  let event: Stripe.Event | null = null;
  let lastErrorMessage = 'Invalid signature';

  if (isConnectScopedEvent) {
    // Connected-account events MUST ONLY be verified using an independent STRIPE_CONNECT_WEBHOOK_SECRET.
    if (!connectSecret || connectSecret === 'whsec_placeholder') {
      console.error(
        'Webhook signature verification failed: connected-account event received without independent STRIPE_CONNECT_WEBHOOK_SECRET.'
      );
      res.status(400).json({
        success: false,
        error: {
          message:
            'Webhook signature verification failed: connected-account webhook signing secret is not configured independently',
          statusCode: 400,
        },
      });
      return;
    }

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, connectSecret);
    } catch (connectErr: any) {
      lastErrorMessage = connectErr?.message || 'Signature verification failed';
    }
  } else {
    // Platform events (!event.account) MUST ONLY be verified using STRIPE_WEBHOOK_SECRET.
    const canVerifyPlatformInCurrentEnv =
      Boolean(platformSecret) &&
      (platformSecret !== 'whsec_placeholder' || process.env.NODE_ENV === 'test');

    if (!canVerifyPlatformInCurrentEnv) {
      console.warn(
        'Webhook signature verification failed: STRIPE_WEBHOOK_SECRET is unset or set to placeholder.'
      );
      res.status(400).json({
        success: false,
        error: {
          message: 'Webhook signature verification failed: platform webhook signing secret is unavailable',
          statusCode: 400,
        },
      });
      return;
    }

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, platformSecret);
    } catch (err: any) {
      lastErrorMessage = err?.message || 'Signature verification failed';
    }
  }

  if (!event) {
    console.error(
      `Webhook signature verification failed for ${isConnectScopedEvent ? 'connect' : 'platform'} event.`
    );

    res.status(400).json({
      success: false,
      error: {
        message: `Webhook signature verification failed: ${lastErrorMessage}`,
        statusCode: 400,
      },
    });
    return;
  }

  const verifiedAccount =
    typeof (event as any).account === 'string' ? (event as any).account.trim() : '';
  const verifiedIsConnectEvent = verifiedAccount.length > 0;
  if (verifiedIsConnectEvent !== isConnectScopedEvent) {
    console.error('Webhook scope verification mismatch between payload envelope and verified Stripe event.');
    res.status(400).json({
      success: false,
      error: {
        message: 'Webhook signature verification failed: event scope mismatch',
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
