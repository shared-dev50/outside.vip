import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('Outside.vip Server API Endpoints', () => {
  it('GET /api/health should return ok and connected database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('outside.vip-api');
    expect(res.body.database.status).toBe('connected');
    expect(typeof res.body.database.latencyMs).toBe('number');
  });

  it('GET /api/events should return published events with tiers', async () => {
    const res = await request(app).get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.events.length).toBeGreaterThan(0);
    expect(res.body.data.pagination).toHaveProperty('total');

    const firstEvent = res.body.data.events[0];
    expect(firstEvent).toHaveProperty('title');
    expect(firstEvent).toHaveProperty('slug');
    expect(firstEvent).toHaveProperty('minPriceInCents');
    expect(firstEvent).toHaveProperty('currency');
  });

  it('GET /api/events/:slug should return individual event with ticket tiers and availability', async () => {
    const res = await request(app).get('/api/events/sol-fest-baobab-edition-2026');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.slug).toBe('sol-fest-baobab-edition-2026');
    expect(Array.isArray(res.body.data.event.ticketTiers)).toBe(true);
    expect(res.body.data.event.ticketTiers.length).toBeGreaterThanOrEqual(1);

    const firstTier = res.body.data.event.ticketTiers[0];
    expect(firstTier).toHaveProperty('remainingCapacity');
    expect(firstTier).toHaveProperty('isAvailable');
  });

  it('GET /api/events/:slug should return 404 for nonexistent event', async () => {
    const res = await request(app).get('/api/events/non-existent-event-slug-xyz');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.statusCode).toBe(404);
  });

  it('POST /api/auth/login should authenticate seeded user and return JWT', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data.user.email).toBe('sol@outside.vip');
    expect(res.body.data.user.role).toBe('ORGANIZER');
  });

  it('POST /api/auth/login should reject incorrect credentials with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'sol@outside.vip',
        password: 'wrong_password_test',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/auth/register should validate schema and reject bad email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'invalid-email-address',
        password: '123',
        name: '',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe('Validation failed');
  });
});
