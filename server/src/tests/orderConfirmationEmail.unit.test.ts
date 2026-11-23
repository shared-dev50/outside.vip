import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildOrderTicketAccessUrl,
  DEFAULT_EMAIL_TIMEOUT_MS,
  EmailDeliveryError,
  normalizeClientOrigin,
  ORDER_CONFIRMATION_TEMPLATE_VERSION,
  OrderConfirmationContentSnapshot,
  renderOrderConfirmationEmail,
  resetEmailServiceTestOptions,
  resetSentOrderConfirmationEmails,
  resolveEmailFrom,
  sanitizeEmailLogMessage,
  sendOrderConfirmationEmail,
  setEmailServiceTestOptions,
} from '../lib/email.service.js';
import {
  buildOrderConfirmationDedupeKey,
  buildOrderConfirmationIdempotencyKey,
  buildOrderConfirmationSnapshot,
  classifyOutboxFailure,
  computeNextRetryDelayMs,
  EMAIL_OUTBOX_BATCH_SIZE,
  EMAIL_OUTBOX_LEASE_MS,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  EMAIL_OUTBOX_RETRY_DELAYS_MS,
} from '../modules/notifications/emailOutbox.service.js';

function makeSampleSnapshot(
  overrides: Partial<OrderConfirmationContentSnapshot> = {}
): OrderConfirmationContentSnapshot {
  return {
    templateVersion: ORDER_CONFIRMATION_TEMPLATE_VERSION,
    clientOrigin: 'https://out-side.vip',
    fromEmail: 'Outside.vip <no-reply@out-side.vip>',
    orderNumber: 'OUT-2026-48291',
    purchaseDateIso: '2026-11-20T14:30:00.000Z',
    totalInCents: 11590,
    currency: 'USD',
    buyerName: 'Maya Lin',
    eventTitle: 'Sunset Rooftop Sessions',
    eventStartAtIso: '2026-12-05T19:00:00.000Z',
    eventEndAtIso: '2026-12-06T01:00:00.000Z',
    eventTimezone: 'America/New_York',
    venueName: 'The Glasshouse',
    venueAddress: '140 Mercer St',
    city: 'New York',
    country: 'US',
    organizerName: 'Outside Collective',
    totalTickets: 2,
    items: [
      {
        tierName: 'VIP Terrace Pass',
        quantity: 2,
        unitPriceInCents: 5000,
        subtotalInCents: 10000,
        currency: 'USD',
        validityStartAtIso: '2026-12-05T20:00:00.000Z',
        validityEndAtIso: '2026-12-05T23:30:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('P1-01 Buyer Ticket Confirmation Email — Unit Tests', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    CLIENT_URL: process.env.CLIENT_URL,
  };

  beforeEach(() => {
    resetEmailServiceTestOptions();
    resetSentOrderConfirmationEmails();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;

    if (originalEnv.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalEnv.EMAIL_FROM;

    if (originalEnv.CLIENT_URL === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalEnv.CLIENT_URL;

    resetEmailServiceTestOptions();
    resetSentOrderConfirmationEmails();
    vi.restoreAllMocks();
  });

  describe('1. Snapshot, Deterministic Keys & Retry Schedule', () => {
    it('builds deterministic dedupe and Resend idempotency keys from orderId', () => {
      expect(buildOrderConfirmationDedupeKey('ord_123')).toBe('order_confirmation:ord_123');
      expect(buildOrderConfirmationIdempotencyKey('ord_123')).toBe('order-confirmation:ord_123');
    });

    it('builds immutable content snapshot with normalized clientOrigin and sanitized fromEmail, without bearer tokens', () => {
      process.env.CLIENT_URL = '  "https://OUT-SIDE.VIP///"  ';
      process.env.EMAIL_FROM = '  "Outside.vip <tickets-a@out-side.vip>\r\nBcc: bad@example.com"  ';
      const snapshot = buildOrderConfirmationSnapshot({
        id: 'ord_123',
        orderNumber: 'OUT-2026-90001',
        customerEmail: 'buyer@example.com',
        customerName: 'Amina Ochieng',
        totalInCents: 8500,
        currency: 'usd',
        createdAt: new Date('2026-11-22T12:00:00.000Z'),
        event: {
          title: 'Nairobi Night Market',
          startAt: new Date('2026-12-10T16:00:00.000Z'),
          endAt: new Date('2026-12-10T22:00:00.000Z'),
          timezone: 'Africa/Nairobi',
          venueName: 'Alchemist Courtyard',
          venueAddress: 'Parklands Rd',
          city: 'Nairobi',
          country: 'Kenya',
          organizer: {
            name: 'Fallback Org',
            organizer: { displayName: 'Nairobi Sound System' },
          },
        },
        items: [
          {
            quantity: 2,
            unitPriceInCents: 4000,
            subtotalInCents: 8000,
            ticketTier: {
              name: 'Early Bird',
              currency: 'usd',
              validityStartAt: new Date('2026-12-10T16:00:00.000Z'),
              validityEndAt: new Date('2026-12-10T19:00:00.000Z'),
            },
          },
        ],
      });

      expect(snapshot.templateVersion).toBe(1);
      expect(snapshot.clientOrigin).toBe('https://out-side.vip');
      expect(snapshot.fromEmail).not.toMatch(/[\r\n]/);
      expect(snapshot.fromEmail).toBe('Outside.vip <tickets-a@out-side.vip> Bcc: bad@example.com');
      expect(resolveEmailFrom()).not.toMatch(/[\r\n]/);
      expect(snapshot.currency).toBe('USD');
      expect(snapshot.organizerName).toBe('Nairobi Sound System');
      expect(snapshot.totalTickets).toBe(2);
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].validityStartAtIso).toBe('2026-12-10T16:00:00.000Z');
      expect(snapshot.items[0].validityEndAtIso).toBe('2026-12-10T19:00:00.000Z');

      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain('orderAccessToken');
      expect(serialized).not.toContain('oat_');
      expect(serialized).not.toContain('tkt_sec_');

      // Changing CLIENT_URL and EMAIL_FROM after snapshotting does not alter rendered output
      process.env.CLIENT_URL = 'https://changed-later.example.com';
      process.env.EMAIL_FROM = 'Other Sender <other@changed-later.example.com>';
      const stableUrl = buildOrderTicketAccessUrl(
        snapshot.orderNumber,
        'oat_canonical_token_123456',
        snapshot.clientOrigin
      );
      expect(stableUrl).toBe(
        'https://out-side.vip/orders/OUT-2026-90001?token=oat_canonical_token_123456'
      );
      const rendered = renderOrderConfirmationEmail({
        to: 'buyer@example.com',
        snapshot,
        ticketAccessUrl: stableUrl,
      });
      expect(rendered.from).toBe(snapshot.fromEmail);

      expect(normalizeClientOrigin('https://Sub.Out-Side.VIP/app///')).toBe(
        'https://sub.out-side.vip/app'
      );
      expect(() => normalizeClientOrigin('javascript:alert(1)')).toThrow(/Unsupported CLIENT_URL protocol/);
      expect(() => normalizeClientOrigin('ftp://files.example.com')).toThrow(/Unsupported CLIENT_URL protocol/);
      expect(() => normalizeClientOrigin('not-a-valid-url')).toThrow(/Invalid CLIENT_URL/);
    });

    it('keeps batch worst-case sequential timeout safely below the 90s worker lease', () => {
      expect(EMAIL_OUTBOX_BATCH_SIZE).toBe(5);
      expect(EMAIL_OUTBOX_LEASE_MS).toBe(90_000);
      expect(EMAIL_OUTBOX_BATCH_SIZE * DEFAULT_EMAIL_TIMEOUT_MS).toBeLessThan(
        EMAIL_OUTBOX_LEASE_MS
      );
    });

    it('keeps exponential backoff with jitter strictly inside Resend 24h idempotency window', () => {
      expect(EMAIL_OUTBOX_MAX_ATTEMPTS).toBe(8);
      expect(EMAIL_OUTBOX_RETRY_DELAYS_MS).toHaveLength(7);

      let maxTotalMs = 0;
      for (let attempt = 1; attempt <= EMAIL_OUTBOX_MAX_ATTEMPTS - 1; attempt++) {
        const minDelay = computeNextRetryDelayMs(attempt, () => 0);
        const midDelay = computeNextRetryDelayMs(attempt, () => 0.5);
        const maxDelay = computeNextRetryDelayMs(attempt, () => 1);

        expect(minDelay).toBe(Math.round(EMAIL_OUTBOX_RETRY_DELAYS_MS[attempt - 1] * 0.8));
        expect(midDelay).toBe(EMAIL_OUTBOX_RETRY_DELAYS_MS[attempt - 1]);
        expect(maxDelay).toBe(Math.round(EMAIL_OUTBOX_RETRY_DELAYS_MS[attempt - 1] * 1.2));
        maxTotalMs += maxDelay;
      }

      // Even at maximum +20% jitter across all 7 retries, cumulative window stays well below 24h
      expect(maxTotalMs).toBeLessThan(24 * 60 * 60 * 1000);
    });
  });

  describe('2. Deterministic Rendering, Content Completeness & Security', () => {
    it('builds secure ticket-access URL reusing /orders/:orderNumber?token=... with zero PII', () => {
      process.env.CLIENT_URL = 'https://out-side.vip/';
      const url = buildOrderTicketAccessUrl('OUT-2026-48291', 'oat_securetoken1234567890abcdef');

      expect(url).toBe(
        'https://out-side.vip/orders/OUT-2026-48291?token=oat_securetoken1234567890abcdef'
      );

      const parsed = new URL(url);
      expect(Array.from(parsed.searchParams.keys())).toEqual(['token']);
      expect(url).not.toContain('email');
      expect(url).not.toContain('name');
      expect(url).not.toContain('phone');
      expect(url).not.toContain('tkt_sec_');
    });

    it('renders byte-for-byte identical subject, text, and html across retries', () => {
      const snapshot = makeSampleSnapshot();
      const accessUrl = 'https://out-side.vip/orders/OUT-2026-48291?token=oat_stable_token_12345';

      const first = renderOrderConfirmationEmail({
        to: 'Maya@Example.com',
        from: 'Outside.vip <no-reply@out-side.vip>',
        snapshot,
        ticketAccessUrl: accessUrl,
      });

      const second = renderOrderConfirmationEmail({
        to: '  maya@example.com ',
        from: 'Outside.vip <no-reply@out-side.vip>',
        snapshot,
        ticketAccessUrl: accessUrl,
      });

      expect(first).toEqual(second);
      expect(first.to).toBe('maya@example.com');
      expect(first.subject).toBe('Your tickets for Sunset Rooftop Sessions — Order #OUT-2026-48291');

      // Required buyer, event, order, ticket, validity, and access details
      expect(first.html).toContain('Maya Lin');
      expect(first.html).toContain('Sunset Rooftop Sessions');
      expect(first.html).toContain('OUT-2026-48291');
      expect(first.html).toContain('$115.90');
      expect(first.html).toContain('VIP Terrace Pass');
      expect(first.html).toContain('Entry validity:');
      expect(first.html).toContain('The Glasshouse, 140 Mercer St, New York, US');
      expect(first.html).toContain(accessUrl);
      expect(first.html).toContain('QR passes');
      expect(first.html).toContain('PDF passes');

      expect(first.text).toContain('Maya Lin');
      expect(first.text).toContain('OUT-2026-48291');
      expect(first.text).toContain('2x VIP Terrace Pass');
      expect(first.text).toContain('Entry validity:');
      expect(first.text).toContain('$115.90');
      expect(first.text).toContain(accessUrl);
    });

    it('escapes HTML and strips CRLF header injection in user/event controlled fields', () => {
      const snapshot = makeSampleSnapshot({
        buyerName: '<script>alert("buyer")</script> & \'Co\'',
        eventTitle: 'Rooftop\r\nBcc: evil@attacker.test <img src=x onerror=alert(1)>',
        venueName: 'Club <b>Bold</b>',
        items: [
          {
            tierName: 'VIP <svg onload=alert(1)>',
            quantity: 1,
            unitPriceInCents: 5000,
            subtotalInCents: 5000,
            currency: 'USD',
            validityStartAtIso: null,
            validityEndAtIso: null,
          },
        ],
      });

      const rendered = renderOrderConfirmationEmail({
        to: 'buyer@example.com\r\nBcc: evil@example.com',
        snapshot,
        ticketAccessUrl: 'https://out-side.vip/orders/OUT-2026-48291?token=oat_safe_1234567890',
      });

      expect(rendered.subject).not.toMatch(/[\r\n]/);
      expect(rendered.to).not.toMatch(/[\r\n]/);
      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).not.toContain('<img src=x');
      expect(rendered.html).not.toContain('<svg onload');
      expect(rendered.html).toContain('&lt;script&gt;alert(&quot;buyer&quot;)&lt;/script&gt;');
      expect(rendered.html).toContain('&lt;svg onload=alert(1)&gt;');
    });

    it('redacts orderAccessToken, ticket tokens, query tokens, and Resend API keys in logs', () => {
      const raw =
        'Failed with key re_secret_key_9999 for https://out-side.vip/orders/OUT-1?token=oat_supersecret1234567890 and tkt_sec_9876543210abcdef';
      const sanitized = sanitizeEmailLogMessage(raw, ['oat_supersecret1234567890']);

      expect(sanitized).not.toContain('re_secret_key_9999');
      expect(sanitized).not.toContain('oat_supersecret1234567890');
      expect(sanitized).not.toContain('tkt_sec_9876543210abcdef');
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('formats zero-price tickets using the order currency rather than hardcoding USD', () => {
      const kesRendered = renderOrderConfirmationEmail({
        to: 'buyer@example.com',
        snapshot: makeSampleSnapshot({
          totalInCents: 0,
          currency: 'KES',
          items: [
            {
              tierName: 'Guest List Pass',
              quantity: 1,
              unitPriceInCents: 0,
              subtotalInCents: 0,
              currency: 'KES',
              validityStartAtIso: null,
              validityEndAtIso: null,
            },
          ],
        }),
        ticketAccessUrl: 'https://out-side.vip/orders/OUT-2026-48291?token=oat_safe_1234567890',
      });
      expect(kesRendered.text).toContain('(Free)');
      expect(kesRendered.text).toContain('KES');
      expect(kesRendered.text).not.toContain('$0.00');

      const eurRendered = renderOrderConfirmationEmail({
        to: 'buyer@example.com',
        snapshot: makeSampleSnapshot({
          totalInCents: 0,
          currency: 'EUR',
          items: [
            {
              tierName: 'RSVP Pass',
              quantity: 1,
              unitPriceInCents: 0,
              subtotalInCents: 0,
              currency: 'EUR',
              validityStartAtIso: null,
              validityEndAtIso: null,
            },
          ],
        }),
        ticketAccessUrl: 'https://out-side.vip/orders/OUT-2026-48291?token=oat_safe_1234567890',
      });
      expect(eurRendered.text).toContain('€0.00 (Free)');
      expect(eurRendered.text).not.toContain('$0.00');

      const usdRendered = renderOrderConfirmationEmail({
        to: 'buyer@example.com',
        snapshot: makeSampleSnapshot({
          totalInCents: 0,
          currency: 'USD',
          items: [
            {
              tierName: 'Complimentary Pass',
              quantity: 1,
              unitPriceInCents: 0,
              subtotalInCents: 0,
              currency: 'USD',
              validityStartAtIso: null,
              validityEndAtIso: null,
            },
          ],
        }),
        ticketAccessUrl: 'https://out-side.vip/orders/OUT-2026-48291?token=oat_safe_1234567890',
      });
      expect(usdRendered.text).toContain('$0.00 (Free)');
    });
  });

  describe('3. Resend Transport, Idempotency Key & Error Classification', () => {
    const fakeApiKey = 're_test_order_confirm_key_999';
    const orderToken = 'oat_super_secret_token_9876543210';
    const accessUrl = `https://out-side.vip/orders/OUT-2026-48291?token=${orderToken}`;

    it('sends deterministic Idempotency-Key without replyTo and returns provider message ID on 200', async () => {
      process.env.RESEND_API_KEY = fakeApiKey;
      process.env.EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';
      setEmailServiceTestOptions({ useResendInTest: true });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 're_order_msg_001' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await sendOrderConfirmationEmail({
        to: 'buyer@example.com',
        snapshot: makeSampleSnapshot(),
        ticketAccessUrl: accessUrl,
        orderAccessToken: orderToken,
        idempotencyKey: 'order-confirmation:ord_abc123',
      });

      expect(res.sent).toBe(true);
      expect(res.provider).toBe('resend');
      expect(res.messageId).toBe('re_order_msg_001');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toBe('https://api.resend.com/emails');
      const headers = new Headers(init?.headers);
      expect(headers.get('idempotency-key')).toBe('order-confirmation:ord_abc123');

      const body = JSON.parse(String(init?.body));
      expect(body.from).toBe('Outside.vip <no-reply@out-side.vip>');
      expect(body.to).toEqual(['buyer@example.com']);
      expect(body.reply_to).toBeUndefined();
      expect(body.replyTo).toBeUndefined();
    });

    it('classifies HTTP 429, 503, timeout, network, and 409 concurrent as RETRY', async () => {
      process.env.RESEND_API_KEY = fakeApiKey;
      setEmailServiceTestOptions({ useResendInTest: true, timeoutMs: 40 });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // 429 rate limit
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_429',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err, [orderToken]);
        return cls.disposition === 'RETRY' && cls.code === 'EMAIL_PROVIDER_RATE_LIMITED';
      });

      // 503 server error
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 503, name: 'application_error', message: 'Service unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_503',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err, [orderToken]);
        return cls.disposition === 'RETRY' && cls.code === 'EMAIL_PROVIDER_UNAVAILABLE';
      });

      // 409 concurrent identical request
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: 409,
            name: 'concurrent_idempotent_requests',
            message: 'Another request with the same idempotency key is currently in progress',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_409c',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err, [orderToken]);
        return cls.disposition === 'RETRY' && cls.code === 'EMAIL_IDEMPOTENCY_CONCURRENT';
      });

      // Network rejection
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_net',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err, [orderToken]);
        return cls.disposition === 'RETRY' && cls.code === 'EMAIL_NETWORK_ERROR';
      });

      // Timeout
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          })
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_timeout',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err, [orderToken]);
        return cls.disposition === 'RETRY' && cls.code === 'EMAIL_DELIVERY_TIMEOUT';
      });

      // Confirm bearer token and API key never appeared in any error log
      const logged = errorSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain(orderToken);
      expect(logged).not.toContain(fakeApiKey);
    });

    it('distinguishes 409 payload conflict, 400/422 permanent rejection, and 401/403/missing key config failures', async () => {
      process.env.RESEND_API_KEY = fakeApiKey;
      setEmailServiceTestOptions({ useResendInTest: true });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // 409 payload mismatch
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: 409,
            name: 'invalid_idempotent_request',
            message: 'Idempotency key already used with a different payload',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_409p',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err);
        return (
          cls.disposition === 'PAYLOAD_CONFLICT' &&
          cls.code === 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT'
        );
      });

      // 422 validation error
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: 422,
            name: 'validation_error',
            message: 'Invalid recipient email address',
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'bad-address@invalid',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_422',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err);
        return cls.disposition === 'PERMANENT' && cls.code === 'EMAIL_DELIVERY_REJECTED';
      });

      // 401 auth config failure
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_401',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err);
        return cls.disposition === 'CONFIG_FAILURE' && cls.code === 'EMAIL_PROVIDER_AUTH_FAILED';
      });

      // Missing RESEND_API_KEY
      process.env.RESEND_API_KEY = '';
      await expect(
        sendOrderConfirmationEmail({
          to: 'buyer@example.com',
          snapshot: makeSampleSnapshot(),
          ticketAccessUrl: accessUrl,
          orderAccessToken: orderToken,
          idempotencyKey: 'order-confirmation:ord_missing_key',
        })
      ).rejects.toSatisfy((err: unknown) => {
        const cls = classifyOutboxFailure(err);
        return cls.disposition === 'CONFIG_FAILURE' && cls.code === 'EMAIL_SERVICE_UNCONFIGURED';
      });
    });

    it('classifies HTTP 400 EmailDeliveryError as PERMANENT', () => {
      const err = new EmailDeliveryError('Bad request', {
        code: 'EMAIL_DELIVERY_REJECTED',
        providerStatusCode: 400,
        retryable: false,
      });
      const cls = classifyOutboxFailure(err);
      expect(cls.disposition).toBe('PERMANENT');
      expect(cls.code).toBe('EMAIL_DELIVERY_REJECTED');
    });
  });
});

