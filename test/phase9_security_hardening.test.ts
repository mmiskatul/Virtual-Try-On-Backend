import './setup_env.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

/** Test defaults switch both protections off; these tests turn the production behaviour on. */
function enableProductionProtections() {
  process.env.RATE_LIMIT_DISABLED = 'false';
  process.env.ALLOW_BEARER_WITHOUT_SESSION = 'false';
}

describe('Phase 9: session binding, portal isolation, throttling and public info', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  afterEach(() => {
    process.env.RATE_LIMIT_DISABLED = 'true';
    process.env.ALLOW_BEARER_WITHOUT_SESSION = 'true';
    process.env.NODE_ENV = 'test';
  });

  it('rejects a Bearer access token that is not accompanied by its session id', async () => {
    const app = createApp('all');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.9.0.1',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(login.statusCode).toBe(200);
    const { token, sessionId } = JSON.parse(login.body);
    expect(token).toBeTruthy();
    expect(sessionId).toBeTruthy();

    enableProductionProtections();

    const tokenOnly = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/orders',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tokenOnly.statusCode).toBe(401);
    expect(JSON.parse(tokenOnly.body).error).toBe('SessionMissing');

    const wrongSession = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/orders',
      headers: { Authorization: `Bearer ${token}`, 'X-Session-Id': '00000000-0000-0000-0000-000000000000' },
    });
    expect(wrongSession.statusCode).toBe(401);
    expect(JSON.parse(wrongSession.body).error).toBe('SessionMismatch');

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/orders',
      headers: { Authorization: `Bearer ${token}`, 'X-Session-Id': sessionId },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('keeps brand tokens out of shopper endpoints and shopper tokens out of brand endpoints', async () => {
    const app = createApp('all');
    const brand = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          remoteAddress: '10.9.0.2',
          payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
        })
      ).body,
    ).token;
    const shopper = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/marketplace/auth/login',
          remoteAddress: '10.9.0.3',
          payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
        })
      ).body,
    ).token;

    for (const url of ['/api/v1/cart', '/api/v1/orders', '/api/v1/favorites', '/api/v1/marketplace/auth/me']) {
      const res = await app.inject({ method: 'GET', url, headers: { Authorization: `Bearer ${brand}` } });
      expect(res.statusCode, `brand token on ${url}`).toBe(403);
      expect(JSON.parse(res.body).error).toBe('WrongPortal');
      const mine = await app.inject({ method: 'GET', url, headers: { Authorization: `Bearer ${shopper}` } });
      expect(mine.statusCode, `shopper token on ${url}`).toBe(200);
    }

    const shopperOnBrand = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/orders',
      headers: { Authorization: `Bearer ${shopper}` },
    });
    expect([401, 403]).toContain(shopperOnBrand.statusCode);
  });

  it('locks an account after 5 failed sign-ins, even for the correct password', async () => {
    enableProductionProtections();
    const app = createApp('all');
    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.9.1.1',
        payload: { email: 'lockout.target@example.com', password },
      });
    // register nothing: unknown accounts are throttled exactly like real ones (no enumeration)
    for (let i = 0; i < 5; i++) {
      expect((await attempt(`wrong-${i}`)).statusCode).toBe(401);
    }
    const locked = await attempt('anything');
    expect(locked.statusCode).toBe(429);
    expect(JSON.parse(locked.body).code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits authentication requests per IP', async () => {
    enableProductionProtections();
    const app = createApp('all');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.9.2.1',
        payload: { email: `ip.limit.${i}@example.com`, password: 'x' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('locks one-time-code guessing per email even when the attacker rotates IPs', async () => {
    enableProductionProtections();
    const app = createApp('all');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        remoteAddress: `10.9.3.${i + 1}`,
        payload: { email: 'otp.target@example.com', code: String(100000 + i) },
      });
      statuses.push(res.statusCode);
    }
    // the auth service invalidates the code after a handful of wrong guesses, across all IPs
    expect(statuses[0]).not.toBe(429);
    expect(statuses).toContain(429);
  });

  it('keeps infrastructure details out of public responses', async () => {
    const app = createApp('all');

    const provider = await app.inject({ method: 'GET', url: '/api/v1/try-on/provider' });
    expect(provider.statusCode).toBe(200);
    expect(JSON.parse(provider.body)).not.toHaveProperty('engineUrl');

    process.env.NODE_ENV = 'production';
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(health.body)).sort()).toEqual(['status', 'timestamp']);
  });
});
