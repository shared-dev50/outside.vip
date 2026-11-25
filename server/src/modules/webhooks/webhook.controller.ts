import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { redactSensitiveData } from '../finance/stripeError.js';
import { processStripeWebhookEvent } from './webhook.service.js';

async function verifyAndDispatchStripeWebhook(
  req: Request,
  res: Response,
  options?: { requireConnectScope?: boolean }
): Promise<void> {
  const requireConnectScope = Boolean(options?.requireConnectScope);
  const signature = req.headers['stripe-signature'];

  if (!signature || typeof signature !== 'string') {
    console.warn('[StripeWebhook][InvalidSignature]', {
      endpoint: req.path,
      reason: 'MISSING_SIGNATURE_HEADER',
    });
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
    console.warn('[StripeWebhook][InvalidSignature]', {
      endpoint: req.path,
      reason: 'MISSING_RAW_BODY',
    });
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
    console.warn('[StripeWebhook][InvalidPayload]', {
      endpoint: req.path,
      reason: 'INVALID_JSON',
    });
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

  if (requireConnectScope && !isConnectScopedEvent) {
    console.warn('[StripeWebhook][ScopeMismatch]', {
      endpoint: req.path,
      expectedScope: 'connect',
      observedScope: 'platform',
    });
    res.status(400).json({
      success: false,
      error: {
        message: 'Webhook signature verification failed: Connect endpoint requires a connected-account event',
        statusCode: 400,
      },
    });
    return;
  }

  let event: Stripe.Event | null = null;
  let lastErrorMessage = 'Invalid signature';

  if (requireConnectScope || isConnectScopedEvent) {
    // Connected-account events MUST ONLY be verified using an independent STRIPE_CONNECT_WEBHOOK_SECRET.
    if (!connectSecret || connectSecret === 'whsec_placeholder') {
      console.error('[StripeWebhook][ConfigUnavailable]', {
        endpoint: req.path,
        scope: 'connect',
        reason: 'MISSING_INDEPENDENT_CONNECT_SECRET',
      });
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
      console.warn('[StripeWebhook][ConfigUnavailable]', {
        endpoint: req.path,
        scope: 'platform',
        reason: 'MISSING_PLATFORM_SECRET',
      });
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
    console.warn('[StripeWebhook][InvalidSignature]', {
      endpoint: req.path,
      scope: requireConnectScope || isConnectScopedEvent ? 'connect' : 'platform',
      reason: redactSensitiveData(lastErrorMessage),
    });

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
  if (verifiedIsConnectEvent !== isConnectScopedEvent || (requireConnectScope && !verifiedIsConnectEvent)) {
    console.warn('[StripeWebhook][ScopeMismatch]', {
      endpoint: req.path,
      eventId: event.id,
      eventType: event.type,
    });
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
    console.error('[StripeWebhook][ProcessingFailed]', {
      endpoint: req.path,
      eventId: event.id,
      eventType: event.type,
      scope: verifiedIsConnectEvent ? 'connect' : 'platform',
      errorCode: error?.code || error?.anomalyCode || null,
      message: redactSensitiveData(error?.message || 'Webhook processing error'),
    });
    res.status(500).json({
      success: false,
      error: {
        message: 'Webhook processing error',
        statusCode: 500,
      },
    });
  }
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  await verifyAndDispatchStripeWebhook(req, res, { requireConnectScope: false });
}

export async function handleStripeConnectWebhook(req: Request, res: Response): Promise<void> {
  await verifyAndDispatchStripeWebhook(req, res, { requireConnectScope: true });
}
