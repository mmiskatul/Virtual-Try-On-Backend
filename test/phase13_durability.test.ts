import './setup_env.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { redisAdapter } from '../src/infrastructure/redis.js';
import { seedTestUsers } from './helpers.js';

const app = createApp('all');

function cookiesFrom(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const jar: Record<string, string> = {};
  for (const c of list) {
    const [k, ...v] = c.split(';')[0].split('=');
    jar[k] = v.join('=');
  }
  return jar;
}
const header = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

describe('Phase 13: staying signed in across a restart', () => {
  it('rebuilds refresh state after a restart when Redis is not used, and still rotates tokens', async () => {
    seedTestUsers();
    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.40.0.1',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(login.statusCode).toBe(200);
    const jar = cookiesFrom(login);
    expect(jar.vtry_brand_refresh).toBeTruthy();

    // simulate the restart: the in-memory rotation state is gone, the session itself is still valid
    await redisAdapter.del(`auth:refresh:sid:${jar.vtry_brand_sid}`);

    const refreshed = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: '10.40.0.2',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie', cookie: header(jar) },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const next = { ...jar, ...cookiesFrom(refreshed) };
    expect(next.vtry_brand_refresh).not.toBe(jar.vtry_brand_refresh);

    // normal rotation protection is back in force: the old refresh token is now refused
    const replay = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: '10.40.0.3',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie', cookie: header(jar) },
      payload: {},
    });
    expect(replay.statusCode).toBe(401);

    // a revoked session cannot be revived by the rebuild
    await redisAdapter.del(`auth:refresh:sid:${jar.vtry_brand_sid}`);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { 'x-auth-portal': 'brand', cookie: header(next) }, payload: {} });
    await redisAdapter.del(`auth:refresh:sid:${jar.vtry_brand_sid}`);
    const afterLogout = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: '10.40.0.4',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie', cookie: header(next) },
      payload: {},
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
