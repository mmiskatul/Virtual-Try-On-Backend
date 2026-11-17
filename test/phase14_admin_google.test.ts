import './setup_env.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';
import { resetEnvCache } from '../src/infrastructure/env.schema.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const OWNER_EMAIL = 'owner.admin@gmail.com';
const app = createApp('all');

/** Pretend to be Google: tokeninfo answers for these fake id tokens. */
function mockGoogle(tokens: Record<string, Record<string, unknown>>) {
  vi.stubGlobal('fetch', async (url: string) => {
    const token = new URL(String(url)).searchParams.get('id_token') || '';
    const info = tokens[token];
    if (!info) return new Response('{}', { status: 400 });
    return new Response(JSON.stringify(info), { status: 200 });
  });
}

const ok = (email: string, extra: Record<string, unknown> = {}) => ({
  aud: CLIENT_ID, email, email_verified: 'true', name: 'Platform Owner', ...extra,
});

function signIn(idToken: string, ip: string) {
  return app.inject({
    method: 'POST', url: '/api/v1/admin/auth/oauth-google', remoteAddress: ip,
    headers: { 'x-auth-portal': 'admin', 'x-auth-transport': 'cookie' },
    payload: { idToken },
  });
}

beforeAll(() => {
  seedTestUsers();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.SEED_ADMIN_EMAIL = OWNER_EMAIL;
  resetEnvCache();
  // the owner's account as the seed would create it from SEED_ADMIN_EMAIL
  const admin = db.getUserById('user_admin');
  if (admin) db.updateUser('user_admin', { email: OWNER_EMAIL });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Phase 14: super admin signs in with Google', () => {
  it('offers Google sign-in with the public client id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/google-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, googleClientId: CLIENT_ID });
  });

  it('lets the email from .env in and opens a real admin session', async () => {
    mockGoogle({ good: ok(OWNER_EMAIL) });
    const res = await signIn('good', '10.50.0.1');
    expect(res.statusCode).toBe(200);
    expect(res.json().admin.role).toBe('SUPER_ADMIN');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] as any).join(';');
    expect(cookies).toContain('vtry_admin_access=');
    expect(cookies).toContain('vtry_admin_refresh=');
    expect(cookies).toContain('vtry_admin_sid=');

    const access = /vtry_admin_access=([^;]+)/.exec(cookies)![1];
    const sid = /vtry_admin_sid=([^;]+)/.exec(cookies)![1];
    const me = await app.inject({
      method: 'GET', url: '/api/v1/admin/auth/me', remoteAddress: '10.50.0.1',
      headers: { 'x-auth-portal': 'admin', 'x-auth-transport': 'cookie', cookie: `vtry_admin_access=${access}; vtry_admin_sid=${sid}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().admin.email).toBe(OWNER_EMAIL);
  });

  it('refuses any other Google account, even a verified one', async () => {
    mockGoogle({ stranger: ok('someone.else@gmail.com') });
    const res = await signIn('stranger', '10.50.0.2');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_AN_ADMIN');
  });

  it('refuses a brand owner even if their email were allowed to sign in elsewhere', async () => {
    mockGoogle({ brand: ok('elena@auraatelier.com') });
    const res = await signIn('brand', '10.50.0.3');
    expect(res.statusCode).toBe(403);
  });

  it('refuses a token made for a different app (wrong audience)', async () => {
    mockGoogle({ other: ok(OWNER_EMAIL, { aud: 'some-other-app.apps.googleusercontent.com' }) });
    const res = await signIn('other', '10.50.0.4');
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unverified Google email and an invalid token', async () => {
    mockGoogle({ unverified: ok(OWNER_EMAIL, { email_verified: 'false' }) });
    expect((await signIn('unverified', '10.50.0.5')).statusCode).toBe(400);
    expect((await signIn('garbage', '10.50.0.5')).statusCode).toBe(401);
    expect((await signIn('', '10.50.0.5')).statusCode).toBe(401);
  });

  it('is switched off when the Google client id is not configured', async () => {
    process.env.GOOGLE_CLIENT_ID = '';
    resetEnvCache();
    try {
      mockGoogle({ good: ok(OWNER_EMAIL) });
      expect((await signIn('good', '10.50.0.6')).statusCode).toBe(503);
      const cfg = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/google-config' });
      expect(cfg.json().enabled).toBe(false);
    } finally {
      process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
      resetEnvCache();
    }
  });

  it('creates the admin account on first Google sign-in when none exists yet', async () => {
    process.env.SUPER_ADMIN_EMAILS = 'second.owner@gmail.com';
    mockGoogle({ second: ok('second.owner@gmail.com', { name: 'Second Owner' }) });
    try {
      const res = await signIn('second', '10.50.0.7');
      expect(res.statusCode).toBe(200);
      expect(db.getUserByEmail('second.owner@gmail.com')?.role).toBe('SUPER_ADMIN');
    } finally {
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });
});
