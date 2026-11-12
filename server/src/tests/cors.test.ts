import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { normalizeOrigin, isOriginAllowed, getAllAllowedOrigins } from '../config/cors.js';

describe('CORS Configuration and Middleware', () => {
  describe('Origin normalization and validation unit tests', () => {
    it('normalizes origins with whitespace, trailing slashes, and quotes', () => {
      expect(normalizeOrigin('https://outside-vip.vercel.app/')).toBe('https://outside-vip.vercel.app');
      expect(normalizeOrigin('  https://outside-vip.vercel.app///  ')).toBe('https://outside-vip.vercel.app');
      expect(normalizeOrigin('"https://outside-vip.vercel.app/"')).toBe('https://outside-vip.vercel.app');
      expect(normalizeOrigin("'http://localhost:5173/'")).toBe('http://localhost:5173');
      expect(normalizeOrigin('HTTP://LOCALHOST:5173')).toBe('http://localhost:5173');
      expect(normalizeOrigin('')).toBe('');
    });

    it('identifies production custom domain (out-side.vip and outside.vip), www variants, Vercel, preview, and local origins as allowed', () => {
      const allowed = getAllAllowedOrigins();

      // Primary hyphenated custom domain (apex and www)
      expect(allowed.has('https://out-side.vip')).toBe(true);
      expect(allowed.has('https://www.out-side.vip')).toBe(true);
      expect(isOriginAllowed('https://out-side.vip', allowed)).toBe(true);
      expect(isOriginAllowed('https://out-side.vip/', allowed)).toBe(true);
      expect(isOriginAllowed('https://www.out-side.vip', allowed)).toBe(true);
      expect(isOriginAllowed('https://www.out-side.vip/', allowed)).toBe(true);

      // Legacy custom domain (apex and www)
      expect(isOriginAllowed('https://outside.vip', allowed)).toBe(true);
      expect(isOriginAllowed('https://outside.vip/', allowed)).toBe(true);
      expect(isOriginAllowed('https://www.outside.vip', allowed)).toBe(true);
      expect(isOriginAllowed('https://www.outside.vip/', allowed)).toBe(true);
      // Production Vercel origin
      expect(isOriginAllowed('https://outside-vip.vercel.app', allowed)).toBe(true);
      // Normalized trailing slash
      expect(isOriginAllowed('https://outside-vip.vercel.app/', allowed)).toBe(true);
      // Vercel preview deployment (allowed in non-production)
      expect(isOriginAllowed('https://outside-vip-git-feat-test.vercel.app', allowed)).toBe(true);
      // Local dev
      expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:5173', allowed)).toBe(true);
    });

    it('automatically pairs apex and www variants for custom domains configured in CLIENT_URL or FRONTEND_URL', () => {
      const prevClientUrl = process.env.CLIENT_URL;
      const prevFrontendUrl = process.env.FRONTEND_URL;
      try {
        process.env.CLIENT_URL = 'https://out-side.vip';
        const allowedFromApex = getAllAllowedOrigins();
        expect(allowedFromApex.has('https://out-side.vip')).toBe(true);
        expect(allowedFromApex.has('https://www.out-side.vip')).toBe(true);

        process.env.CLIENT_URL = 'https://www.out-side.vip';
        const allowedFromWww = getAllAllowedOrigins();
        expect(allowedFromWww.has('https://out-side.vip')).toBe(true);
        expect(allowedFromWww.has('https://www.out-side.vip')).toBe(true);

        delete process.env.CLIENT_URL;
        process.env.FRONTEND_URL = 'https://custom-partner.example';
        const allowedFromFrontendEnv = getAllAllowedOrigins();
        expect(allowedFromFrontendEnv.has('https://custom-partner.example')).toBe(true);
        expect(allowedFromFrontendEnv.has('https://www.custom-partner.example')).toBe(true);
      } finally {
        if (prevClientUrl === undefined) {
          delete process.env.CLIENT_URL;
        } else {
          process.env.CLIENT_URL = prevClientUrl;
        }
        if (prevFrontendUrl === undefined) {
          delete process.env.FRONTEND_URL;
        } else {
          process.env.FRONTEND_URL = prevFrontendUrl;
        }
      }
    });

    it('accepts https://out-side.vip and https://www.out-side.vip in production while rejecting Vercel preview and wildcard origins', () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevAllowPreview = process.env.ALLOW_VERCEL_PREVIEW_ORIGINS;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_VERCEL_PREVIEW_ORIGINS = 'false';

        const allowed = getAllAllowedOrigins();
        expect(isOriginAllowed('https://out-side.vip', allowed)).toBe(true);
        expect(isOriginAllowed('https://www.out-side.vip', allowed)).toBe(true);
        expect(isOriginAllowed('https://outside-vip.vercel.app', allowed)).toBe(true);

        // Vercel preview deployments must NOT be trusted in production by default
        expect(isOriginAllowed('https://outside-vip-git-feat-test.vercel.app', allowed)).toBe(false);
        expect(isOriginAllowed('https://outside-vip-pr-99.vercel.app', allowed)).toBe(false);
        expect(isOriginAllowed('https://arbitrary-project.vercel.app', allowed)).toBe(false);
        expect(isOriginAllowed('https://*.vercel.app', allowed)).toBe(false);
        expect(isOriginAllowed('*', allowed)).toBe(false);
      } finally {
        if (prevNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = prevNodeEnv;
        }
        if (prevAllowPreview === undefined) {
          delete process.env.ALLOW_VERCEL_PREVIEW_ORIGINS;
        } else {
          process.env.ALLOW_VERCEL_PREVIEW_ORIGINS = prevAllowPreview;
        }
      }
    });

    it('rejects unauthorized, arbitrary subdomain, port-mismatched, or malformed origins', () => {
      const allowed = getAllAllowedOrigins();

      expect(isOriginAllowed('https://malicious-site.com', allowed)).toBe(false);
      expect(isOriginAllowed('https://evil-out-side.vip', allowed)).toBe(false);
      expect(isOriginAllowed('https://sub.out-side.vip', allowed)).toBe(false);
      expect(isOriginAllowed('https://admin.out-side.vip', allowed)).toBe(false);
      expect(isOriginAllowed('https://sub.outside.vip', allowed)).toBe(false);
      expect(isOriginAllowed('https://out-side.vip:8443', allowed)).toBe(false);
      expect(isOriginAllowed('https://out-side.vip.attacker.com', allowed)).toBe(false);
      expect(isOriginAllowed('http://out-side.vip', allowed)).toBe(false);
      expect(isOriginAllowed('http://www.out-side.vip', allowed)).toBe(false);
      expect(isOriginAllowed('https://attacker-outside-vip.vercel.app.fake.com', allowed)).toBe(false);
      expect(isOriginAllowed('https://unrelated-app.vercel.app', allowed)).toBe(false);
      expect(isOriginAllowed('http://evil-localhost:5173', allowed)).toBe(false);
      expect(isOriginAllowed('not-a-valid-origin', allowed)).toBe(false);
      expect(isOriginAllowed('null', allowed)).toBe(false);
      expect(isOriginAllowed('javascript:alert(1)', allowed)).toBe(false);
      expect(isOriginAllowed('*', allowed)).toBe(false);
      expect(isOriginAllowed('', allowed)).toBe(false);
    });
  });

  describe('HTTP Endpoints & Preflight Requests', { timeout: 20000 }, () => {
    const PRIMARY_APEX_ORIGIN = 'https://out-side.vip';
    const PRIMARY_WWW_ORIGIN = 'https://www.out-side.vip';
    const CUSTOM_DOMAIN_ORIGIN = 'https://outside.vip';
    const CUSTOM_DOMAIN_WWW_ORIGIN = 'https://www.outside.vip';
    const PRODUCTION_ORIGIN = 'https://outside-vip.vercel.app';
    const LOCAL_ORIGIN = 'http://localhost:5173';
    const DISALLOWED_ORIGIN = 'https://malicious-site.com';

    it('handles OPTIONS preflight and credentialed requests for https://out-side.vip, https://www.out-side.vip, https://outside.vip, and https://www.outside.vip', async () => {
      for (const origin of [
        PRIMARY_APEX_ORIGIN,
        PRIMARY_WWW_ORIGIN,
        CUSTOM_DOMAIN_ORIGIN,
        CUSTOM_DOMAIN_WWW_ORIGIN,
      ]) {
        const preflightRes = await request(app)
          .options('/api/events')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

        expect(preflightRes.status).toBe(204);
        expect(preflightRes.headers['access-control-allow-origin']).toBe(origin);
        expect(preflightRes.headers['access-control-allow-credentials']).toBe('true');
        expect(preflightRes.headers['access-control-allow-headers']).toContain('X-CSRF-Token');

        const getRes = await request(app)
          .get('/api/events')
          .set('Origin', origin);

        expect(getRes.status).toBe(200);
        expect(getRes.headers['access-control-allow-origin']).toBe(origin);
        expect(getRes.headers['access-control-allow-credentials']).toBe('true');
      }
    });

    it('allows state-changing POST requests from https://out-side.vip and https://www.out-side.vip in production while rejecting untrusted and preview origins with 403 CSRF_ORIGIN_MISMATCH', async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevAllowPreview = process.env.ALLOW_VERCEL_PREVIEW_ORIGINS;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_VERCEL_PREVIEW_ORIGINS = 'false';

        // 1. Both https://out-side.vip and https://www.out-side.vip pass CSRF Origin validation
        // (reaching schema validation 400 rather than 403 CSRF_ORIGIN_MISMATCH)
        for (const trustedOrigin of [PRIMARY_APEX_ORIGIN, PRIMARY_WWW_ORIGIN]) {
          const res = await request(app)
            .post('/api/auth/register')
            .set('Origin', trustedOrigin)
            .send({ email: 'not-an-email', password: 'short', name: '' });

          expect(res.status).toBe(400);
          expect(res.body.error?.code).not.toBe('CSRF_ORIGIN_MISMATCH');
          expect(res.headers['access-control-allow-origin']).toBe(trustedOrigin);
          expect(res.headers['access-control-allow-credentials']).toBe('true');
        }

        // 2. Untrusted origins, arbitrary subdomains, malformed Origin headers, and Vercel preview domains
        // are blocked by CSRF Origin validation in production
        for (const untrustedOrigin of [
          DISALLOWED_ORIGIN,
          'https://evil-out-side.vip',
          'https://sub.out-side.vip',
          'https://admin.outside.vip',
          'https://out-side.vip.evil.com',
          'https://out-side.vip:8443',
          'https://outside-vip-git-preview-branch.vercel.app',
          'not-a-valid-url',
          'null',
        ]) {
          const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const blockedRes = await request(app)
            .post('/api/auth/register')
            .set('Origin', untrustedOrigin)
            .send({
              email: 'test@out-side.vip',
              password: 'OutsidePassword2026!',
              name: 'Test User',
            });
          warnSpy.mockRestore();

          expect(blockedRes.status).toBe(403);
          expect(blockedRes.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
          expect(blockedRes.body.error.message).toBe(
            `Request origin "${untrustedOrigin}" is not trusted for state-changing operations.`
          );
          expect(blockedRes.headers['access-control-allow-origin']).toBeUndefined();
        }

        // 3. Missing Origin header on non-cross-site state-changing request follows existing policy
        // (permitted to reach request validation when Sec-Fetch-Site is not cross-site)
        const noOriginRes = await request(app)
          .post('/api/auth/register')
          .send({ email: 'not-an-email', password: 'short', name: '' });
        expect(noOriginRes.status).toBe(400);
        expect(noOriginRes.body.error?.code).not.toBe('CSRF_ORIGIN_MISMATCH');
      } finally {
        if (prevNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = prevNodeEnv;
        }
        if (prevAllowPreview === undefined) {
          delete process.env.ALLOW_VERCEL_PREVIEW_ORIGINS;
        } else {
          process.env.ALLOW_VERCEL_PREVIEW_ORIGINS = prevAllowPreview;
        }
      }
    });

    it('handles OPTIONS preflight for production origin https://outside-vip.vercel.app', async () => {
      const res = await request(app)
        .options('/api/events')
        .set('Origin', PRODUCTION_ORIGIN)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,content-type,x-order-token');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(PRODUCTION_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
      expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
      expect(res.headers['access-control-allow-headers']).toBeDefined();
    });

    it('returns CORS headers for GET request from production origin', async () => {
      const res = await request(app)
        .get('/api/events')
        .set('Origin', PRODUCTION_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(PRODUCTION_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('handles OPTIONS preflight for allowed local development origin', async () => {
      const res = await request(app)
        .options('/api/events')
        .set('Origin', LOCAL_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(LOCAL_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not return Access-Control-Allow-Origin for unauthorized origin preflight', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(app)
        .options('/api/events')
        .set('Origin', DISALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');

      // The preflight should NOT grant Access-Control-Allow-Origin
      expect(res.headers['access-control-allow-origin']).toBeUndefined();

      // Diagnostic logging should have fired
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[CORS] Blocked request from unauthorized origin: "${DISALLOWED_ORIGIN}"`)
      );

      warnSpy.mockRestore();
    });

    it('does not return Access-Control-Allow-Origin for unauthorized origin GET request', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(app)
        .get('/api/events')
        .set('Origin', DISALLOWED_ORIGIN);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();

      warnSpy.mockRestore();
    });

    it('allows requests without an Origin header (e.g., server-to-server health check)', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
