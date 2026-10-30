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
 * Redacts API keys, webhook secrets, account IDs, and auth tokens from strings.
 */
export function redactSensitiveData(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    .replace(/sk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_SECRET_KEY]')
    .replace(/rk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_RESTRICTED_KEY]')
    .replace(/whsec_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_WEBHOOK_SECRET]')
    .replace(/pk_(?:live|test)_[a-zA-Z0-9*]{4,}/gi, '[REDACTED_STRIPE_PUBLISHABLE_KEY]')
    .replace(/acct_[a-zA-Z0-9*]{6,}/gi, '[REDACTED_ACCOUNT_ID]')
    .replace(/Bearer\s+[a-zA-Z0-9_.\-]+/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Strips raw exception text and credentials before returning errors to clients.
 */
export function sanitizeErrorMessage(message?: string): string {
  if (!message || typeof message !== 'string') {
    return 'An unexpected error occurred. Please try again.';
  }

  const sanitized = redactSensitiveData(message);

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
 * Maps raw Stripe or network errors to safe client categories and HTTP codes.
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

  // Platform API key issue
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

  // Account deleted, unlinked, or owned by another platform
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

  // Network drops, rate limits, timeouts, or Stripe downtime
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
