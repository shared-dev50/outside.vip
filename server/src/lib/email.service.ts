import crypto from 'crypto';
import { Resend } from 'resend';
import { env, normalizeEmail } from '../config/env.js';
import { ServiceUnavailableError } from '../utils/errors.js';

export const DEFAULT_EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;
export const DEFAULT_EMAIL_RETRY_DELAY_MS = 150;
export const DEFAULT_EMAIL_MAX_RETRIES = 1;

export interface VerificationEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  code: string;
  expiresInMinutes: number;
  sentAt: Date;
}

export interface EmailDeliveryResult {
  sent: boolean;
  status: 'sent' | 'recorded';
  provider: 'resend' | 'test-recorder';
  messageId: string;
  from: string;
  to: string;
  expiresInMinutes: number;
  sentAt: Date;
}

export class EmailDeliveryError extends ServiceUnavailableError {
  public readonly providerStatusCode: number | null;
  public readonly retryable: boolean;
  public readonly timedOut: boolean;
  public readonly providerDetail?: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      providerStatusCode?: number | null;
      retryable?: boolean;
      timedOut?: boolean;
      providerDetail?: string;
    }
  ) {
    super(message, options?.code || 'EMAIL_DELIVERY_FAILED');
    this.name = 'EmailDeliveryError';
    this.providerStatusCode = options?.providerStatusCode ?? null;
    this.retryable = options?.retryable ?? false;
    this.timedOut = options?.timedOut ?? false;
    this.providerDetail = options?.providerDetail;
  }
}

interface EmailServiceTestOptions {
  useResendInTest?: boolean;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

let testOptions: EmailServiceTestOptions = {};

/**
 * Configures email transport options exclusively during automated Vitest execution.
 * Ignored in all non-test runtimes.
 */
export function setEmailServiceTestOptions(options: EmailServiceTestOptions): void {
  if (env.NODE_ENV !== 'test') return;
  testOptions = { ...options };
}

export function resetEmailServiceTestOptions(): void {
  testOptions = {};
}

// Test-only in-memory recorder. Never populated outside NODE_ENV=test.
export const sentVerificationEmails: VerificationEmailMessage[] = [];

function getActiveNodeEnv(): string {
  return (process.env.NODE_ENV || env.NODE_ENV || 'development').trim().toLowerCase();
}

export function resetSentVerificationEmails(): void {
  sentVerificationEmails.length = 0;
}

export function getLatestVerificationEmail(email: string): VerificationEmailMessage | undefined {
  if (getActiveNodeEnv() !== 'test') {
    return undefined;
  }
  const normalized = normalizeEmail(email);
  for (let i = sentVerificationEmails.length - 1; i >= 0; i--) {
    if (normalizeEmail(sentVerificationEmails[i].to) === normalized) {
      return sentVerificationEmails[i];
    }
  }
  return undefined;
}

export function resolveEmailFrom(): string {
  const raw = (process.env.EMAIL_FROM ?? env.EMAIL_FROM ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
  return raw || DEFAULT_EMAIL_FROM;
}

function resolveResendApiKey(): string {
  return (process.env.RESEND_API_KEY ?? env.RESEND_API_KEY ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function sanitizeHeaderField(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function sanitizeEmailLogMessage(raw: string, sensitiveValues: string[] = []): string {
  let clean = raw || 'Unknown error';
  for (const secret of sensitiveValues) {
    if (secret && secret.length >= 4) {
      clean = clean.split(secret).join('[REDACTED]');
    }
  }
  clean = clean.replace(/\bre_[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_API_KEY]');
  clean = clean.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [REDACTED]');
  return clean.slice(0, 300);
}

function maskEmailForLog(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '[redacted-email]';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}

function getEffectiveTimeoutMs(): number {
  if (env.NODE_ENV === 'test' && typeof testOptions.timeoutMs === 'number' && testOptions.timeoutMs > 0) {
    return testOptions.timeoutMs;
  }
  return DEFAULT_EMAIL_TIMEOUT_MS;
}

function getEffectiveRetryDelayMs(): number {
  if (env.NODE_ENV === 'test' && typeof testOptions.retryDelayMs === 'number' && testOptions.retryDelayMs >= 0) {
    return testOptions.retryDelayMs;
  }
  return DEFAULT_EMAIL_RETRY_DELAY_MS;
}

function getEffectiveMaxRetries(): number {
  if (env.NODE_ENV === 'test' && typeof testOptions.maxRetries === 'number' && testOptions.maxRetries >= 0) {
    return testOptions.maxRetries;
  }
  return DEFAULT_EMAIL_MAX_RETRIES;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyProviderError(error: {
  name?: string;
  statusCode?: number | null;
  message?: string;
}): EmailDeliveryError {
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
  const providerDetail = error.message ? `${error.name || 'error'}: ${error.message}` : error.name;

  if (statusCode === 401 || statusCode === 403) {
    return new EmailDeliveryError(
      'Verification email delivery failed due to provider authentication configuration.',
      {
        code: 'EMAIL_PROVIDER_AUTH_FAILED',
        providerStatusCode: statusCode,
        retryable: false,
        providerDetail,
      }
    );
  }

  if (statusCode === 429) {
    return new EmailDeliveryError(
      'Email delivery provider is temporarily rate-limited. Please try again shortly.',
      {
        code: 'EMAIL_PROVIDER_RATE_LIMITED',
        providerStatusCode: 429,
        retryable: false,
        providerDetail,
      }
    );
  }

  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return new EmailDeliveryError(
      'Unable to send verification email. Please verify your email address and try again.',
      {
        code: 'EMAIL_DELIVERY_REJECTED',
        providerStatusCode: statusCode,
        retryable: false,
        providerDetail,
      }
    );
  }

  if (statusCode !== null && statusCode >= 500) {
    return new EmailDeliveryError(
      'Verification email service is temporarily unavailable. Please try again shortly.',
      {
        code: 'EMAIL_PROVIDER_UNAVAILABLE',
        providerStatusCode: statusCode,
        retryable: true,
        providerDetail,
      }
    );
  }

  return new EmailDeliveryError(
    'Unable to reach the email delivery service. Please try again shortly.',
    {
      code: 'EMAIL_NETWORK_ERROR',
      providerStatusCode: null,
      retryable: true,
      providerDetail,
    }
  );
}

async function sendSingleResendAttempt(params: {
  resend: Resend;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
  timeoutMs: number;
}): Promise<{ messageId: string }> {
  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reject(
        new EmailDeliveryError(
          'Email delivery timed out while contacting the email provider. Please try again.',
          {
            code: 'EMAIL_DELIVERY_TIMEOUT',
            providerStatusCode: null,
            retryable: true,
            timedOut: true,
          }
        )
      );
    }, params.timeoutMs);
  });

  try {
    const requestOptions: Record<string, unknown> = {
      signal: controller.signal,
    };
    if (params.idempotencyKey) {
      requestOptions.idempotencyKey = params.idempotencyKey;
    }

    const sendPromise = params.resend.emails.send(
      {
        from: params.from,
        to: [params.to],
        subject: params.subject,
        text: params.text,
        html: params.html,
      },
      requestOptions as any
    );
    // Prevent unhandled rejection warnings if timeout rejects first
    sendPromise.catch(() => {});

    const response = await Promise.race([sendPromise, timeoutPromise]);

    if (didTimeout) {
      throw new EmailDeliveryError(
        'Email delivery timed out while contacting the email provider. Please try again.',
        {
          code: 'EMAIL_DELIVERY_TIMEOUT',
          providerStatusCode: null,
          retryable: true,
          timedOut: true,
        }
      );
    }

    if (response.error) {
      throw classifyProviderError(response.error);
    }

    const messageId = response.data?.id;
    if (!messageId) {
      throw new EmailDeliveryError('Email provider did not return a message identifier.', {
        code: 'EMAIL_INVALID_PROVIDER_RESPONSE',
        providerStatusCode: null,
        retryable: true,
      });
    }

    return { messageId };
  } catch (err: any) {
    if (err instanceof EmailDeliveryError) {
      throw err;
    }

    if (didTimeout || err?.name === 'AbortError') {
      throw new EmailDeliveryError(
        'Email delivery timed out while contacting the email provider. Please try again.',
        {
          code: 'EMAIL_DELIVERY_TIMEOUT',
          providerStatusCode: null,
          retryable: true,
          timedOut: true,
        }
      );
    }

    throw new EmailDeliveryError(
      'Unable to reach the email delivery service. Please try again shortly.',
      {
        code: 'EMAIL_NETWORK_ERROR',
        providerStatusCode: null,
        retryable: true,
      }
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function sendVerificationOtpEmail(params: {
  to: string;
  name: string;
  code: string;
  expiresInMinutes?: number;
  idempotencyKey?: string;
}): Promise<EmailDeliveryResult> {
  const expiresInMinutes = params.expiresInMinutes ?? 10;
  const from = resolveEmailFrom();
  const to = sanitizeHeaderField(normalizeEmail(params.to));
  const cleanName = sanitizeHeaderField(params.name || 'there') || 'there';
  const cleanCode = sanitizeHeaderField(params.code);
  const subject = `${cleanCode} is your Outside.vip verification code`;

  const text = [
    `Hi ${cleanName},`,
    '',
    `Your Outside.vip verification code is: ${cleanCode}`,
    '',
    `This single-use code expires in ${expiresInMinutes} minutes.`,
    'If you did not request this code, you can safely ignore this email.',
  ].join('\n');

  const escapedName = escapeHtml(cleanName);
  const escapedCode = escapeHtml(cleanCode);
  const escapedExpiry = escapeHtml(String(expiresInMinutes));

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0A0A0C; color: #F5F5F7; padding: 32px; border-radius: 16px; max-width: 520px; margin: 0 auto;">
      <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: #FF5500; margin: 0 0 8px;">Outside.vip Security</p>
      <h1 style="font-size: 24px; margin: 0 0 16px; color: #FFFFFF;">Verify your email address</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #B8B8C2;">
        Hi ${escapedName}, enter the 6-digit verification code below to verify your email address and unlock organizer capabilities on Outside.vip:
      </p>
      <div style="margin: 24px 0; padding: 18px 24px; background: #141418; border: 1px solid #2A2A32; border-radius: 12px; text-align: center;">
        <span style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 0.25em; color: #FF5500;">${escapedCode}</span>
      </div>
      <p style="font-size: 13px; color: #8E8E99; margin-top: 16px;">
        This code is single-use and expires in <strong>${escapedExpiry} minutes</strong>.
      </p>
    </div>
  `.trim();

  const sentAt = new Date();
  const activeNodeEnv = getActiveNodeEnv();
  const shouldUseResendInTest = env.NODE_ENV === 'test' && Boolean(testOptions.useResendInTest);

  // Preserve the in-memory test recorder strictly for isolated Vitest runs
  if (activeNodeEnv === 'test' && !shouldUseResendInTest) {
    const message: VerificationEmailMessage = {
      to,
      from,
      subject,
      text,
      html,
      code: cleanCode,
      expiresInMinutes,
      sentAt,
    };
    sentVerificationEmails.push(message);
    return {
      sent: true,
      status: 'recorded',
      provider: 'test-recorder',
      messageId: `test_rec_${crypto.randomUUID()}`,
      from,
      to,
      expiresInMinutes,
      sentAt,
    };
  }

  const resendApiKey = resolveResendApiKey();
  if (!resendApiKey) {
    console.error(
      `[EmailService] Verification email aborted for ${maskEmailForLog(to)}: RESEND_API_KEY is not configured.`
    );
    throw new EmailDeliveryError(
      'Email delivery service is not configured. Please try again later.',
      {
        code: 'EMAIL_SERVICE_UNCONFIGURED',
        providerStatusCode: null,
        retryable: false,
      }
    );
  }

  const resend = new Resend(resendApiKey);
  const timeoutMs = getEffectiveTimeoutMs();
  const retryDelayMs = getEffectiveRetryDelayMs();
  const maxRetries = getEffectiveMaxRetries();
  const sensitiveValues = [resendApiKey, cleanCode, params.code];

  let lastError: EmailDeliveryError | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const { messageId } = await sendSingleResendAttempt({
        resend,
        from,
        to,
        subject,
        text,
        html,
        idempotencyKey: params.idempotencyKey,
        timeoutMs,
      });

      return {
        sent: true,
        status: 'sent',
        provider: 'resend',
        messageId,
        from,
        to,
        expiresInMinutes,
        sentAt,
      };
    } catch (err) {
      const deliveryError =
        err instanceof EmailDeliveryError
          ? err
          : classifyProviderError({ message: err instanceof Error ? err.message : undefined });
      lastError = deliveryError;

      const canRetry = deliveryError.retryable && attempt <= maxRetries;
      const safeDetail = sanitizeEmailLogMessage(
        deliveryError.providerDetail || deliveryError.message,
        sensitiveValues
      );

      if (canRetry) {
        console.warn(
          `[EmailService] Transient Resend failure on attempt ${attempt} for ${maskEmailForLog(to)} (code=${deliveryError.code}, status=${deliveryError.providerStatusCode ?? 'network'}): ${safeDetail}. Retrying with matching idempotency key.`
        );
        await sleep(retryDelayMs);
        continue;
      }

      console.error(
        `[EmailService] Verification email delivery failed for ${maskEmailForLog(to)} after ${attempt} attempt(s) (code=${deliveryError.code}, status=${deliveryError.providerStatusCode ?? 'network'}): ${safeDetail}`
      );
      throw deliveryError;
    }
  }

  throw lastError!;
}
