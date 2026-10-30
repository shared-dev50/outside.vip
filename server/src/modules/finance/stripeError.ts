export type StripeErrorCategory =
  | 'not_connected'
  | 'invalid_or_inaccessible'
  | 'configuration_unavailable'
  | 'service_unavailable'
  | 'unknown';

export interface ClassifiedStripeError {
  category: StripeErrorCategory;
  code: string;
  safeMessage: string;
  statusCode: number;
}

/**
 * Scans any string and replaces sensitive credentials, Stripe keys, account IDs,
 * and auth tokens with safe redaction markers.
 */
export function redactSensitiveData(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    // Full or partially masked Stripe secret keys
    .replace(/sk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_SECRET_KEY]')
    // Full or partially masked Stripe restricted keys
    .replace(/rk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_RESTRICTED_KEY]')
    // Stripe webhook secrets
    .replace(/whsec_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_WEBHOOK_SECRET]')
    // Stripe Publishable keys
    .replace(/pk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_PUBLISHABLE_KEY]')
    // Connected account IDs
    .replace(/acct_[a-zA-Z0-9*]{6,}/gi, '[REDACTED_ACCOUNT_ID]')
    // HTTP Authorization headers
    .replace(/Bearer\s+[a-zA-Z0-9_.\-]+/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Ensures any message destined for client consumption is free of raw exceptions,
 * internal account identifiers, and API credentials.
 */
export function sanitizeErrorMessage(message?: string): string {
  if (!message || typeof message !== 'string') {
    return 'An unexpected error occurred. Please try again.';
  }

  const sanitized = redactSensitiveData(message);

  // If the message contains technical Stripe error artifacts, provide a clean fallback
  if (
    /StripeInvalidRequestError|StripeAuthenticationError|StripePermissionError|StripeConnectionError|StripeAPIError/i.test(
      sanitized
    ) ||
    /No such account|Invalid API Key|resource_missing|account_inaccessible/i.test(sanitized)
  ) {
    return 'Payment and payout services encountered an issue. Please try again later or reconnect your Stripe account.';
  }

  return sanitized;
}

/**
 * Categorizes an error thrown by Stripe or network clients into one of 4 defined states:
 * 1. No connected account.
 * 2. Invalid or inaccessible connected account.
 * 3. Stripe platform configuration problem.
 * 4. Temporary Stripe API / network failure.
 */
export function classifyStripeError(err: any): ClassifiedStripeError {
  if (!err) {
    return {
      category: 'unknown',
      code: 'STRIPE_UNKNOWN_ERROR',
      safeMessage: 'An unexpected payment service error occurred. Please try again.',
      statusCode: 500,
    };
  }

  const rawMessage = (err.message || '').toString();
  const errCode = (err.code || err.raw?.code || '').toString();
  const errType = (err.type || err.rawType || '').toString();
  const statusCode = err.statusCode || err.status || 500;

  // 1. Stripe platform configuration problem
  // Invalid or placeholder API key, expired key, or authentication failure
  if (
    errType === 'StripeAuthenticationError' ||
    errCode === 'api_key_expired' ||
    /Invalid API Key|api_key|secret key|placeholder/i.test(rawMessage) ||
    errCode === 'bad_api_key'
  ) {
    return {
      category: 'configuration_unavailable',
      code: 'STRIPE_CONFIGURATION_UNAVAILABLE',
      safeMessage:
        'Stripe Connect is currently being configured for this platform. Please check back shortly.',
      statusCode: 503,
    };
  }

  // 2. Invalid or inaccessible connected account
  // Account does not exist in Stripe, has been deleted, or belongs to a different Stripe platform
  if (
    errCode === 'resource_missing' ||
    errCode === 'account_invalid' ||
    errCode === 'account_inaccessible' ||
    errType === 'StripePermissionError' ||
    /No such account|account.*does not exist|not have access to account|account_inaccessible/i.test(
      rawMessage
    )
  ) {
    return {
      category: 'invalid_or_inaccessible',
      code: 'INVALID_CONNECTED_ACCOUNT',
      safeMessage:
        'The previously connected Stripe account could not be found or is no longer accessible. Please reconnect your Stripe account.',
      statusCode: 422,
    };
  }

  // 3. Temporary Stripe API / network failure
  // Rate limits, connection timeouts, connection resets, DNS failures, Stripe 5xx
  if (
    errType === 'StripeConnectionError' ||
    errType === 'StripeAPIError' ||
    errType === 'StripeRateLimitError' ||
    errCode === 'ETIMEDOUT' ||
    errCode === 'ECONNRESET' ||
    errCode === 'ENOTFOUND' ||
    statusCode >= 500
  ) {
    return {
      category: 'service_unavailable',
      code: 'STRIPE_SERVICE_UNAVAILABLE',
      safeMessage:
        'Stripe services are temporarily unreachable. Please check your connection and try refreshing in a few moments.',
      statusCode: 503,
    };
  }

  // Default fallback for operational errors
  return {
    category: 'unknown',
    code: 'STRIPE_SERVICE_ERROR',
    safeMessage: 'Could not complete the requested Stripe operation. Please try again.',
    statusCode: statusCode >= 400 && statusCode < 500 ? statusCode : 500,
  };
}

/**
 * Safely logs diagnostic information on the server console while strictly redacting
 * sensitive keys and account details.
 */
export function logStripeDiagnostic(
  operation: string,
  error: any,
  meta?: Record<string, any>
): void {
  const sanitizedMeta: Record<string, any> = {};
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'string') {
        sanitizedMeta[key] = redactSensitiveData(value);
      } else {
        sanitizedMeta[key] = value;
      }
    }
  }

  const rawMessage = (error?.message || 'Unknown error').toString();
  const sanitizedMessage = redactSensitiveData(rawMessage);

  console.error(`[StripeDiagnostic][${operation}]`, {
    type: error?.type || error?.name || 'Error',
    code: error?.code || 'UNKNOWN_CODE',
    statusCode: error?.statusCode || error?.status || 500,
    requestId: error?.requestId || null,
    message: sanitizedMessage,
    ...sanitizedMeta,
  });
}
