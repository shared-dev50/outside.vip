import { describe, it, expect } from 'vitest';
import { api } from './lib/api';

describe('Outside.vip Client Library', () => {
  it('should define public API service routes', () => {
    expect(api.events).toBeDefined();
    expect(typeof api.events.list).toBe('function');
    expect(typeof api.events.bySlug).toBe('function');
    expect(typeof api.events.featured).toBe('function');
    expect(typeof api.events.cities).toBe('function');
    expect(api.auth).toBeDefined();
    expect(typeof api.auth.login).toBe('function');
    expect(typeof api.auth.register).toBe('function');
    expect(typeof api.auth.me).toBe('function');
  });
});
