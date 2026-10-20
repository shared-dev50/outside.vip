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

    it('identifies production, preview, and local origins as allowed', () => {
      const allowed = getAllAllowedOrigins();

      // Production origin
      expect(isOriginAllowed('https://outside-vip.vercel.app', allowed)).toBe(true);
      // Normalized trailing slash
      expect(isOriginAllowed('https://outside-vip.vercel.app/', allowed)).toBe(true);
      // Vercel preview deployment
      expect(isOriginAllowed('https://outside-vip-git-feat-test.vercel.app', allowed)).toBe(true);
      // Local dev
      expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:5173', allowed)).toBe(true);
    });

    it('rejects unauthorized or malicious origins', () => {
      const allowed = getAllAllowedOrigins();

      expect(isOriginAllowed('https://malicious-site.com', allowed)).toBe(false);
      expect(isOriginAllowed('https://attacker-outside-vip.vercel.app.fake.com', allowed)).toBe(false);
      expect(isOriginAllowed('http://evil-localhost:5173', allowed)).toBe(false);
      expect(isOriginAllowed('', allowed)).toBe(false);
    });
  });

  describe('HTTP Endpoints & Preflight Requests', { timeout: 20000 }, () => {
    const PRODUCTION_ORIGIN = 'https://outside-vip.vercel.app';
    const LOCAL_ORIGIN = 'http://localhost:5173';
    const DISALLOWED_ORIGIN = 'https://malicious-site.com';

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
