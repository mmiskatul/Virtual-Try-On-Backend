import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { tryonOrchestrator } from '../src/modules/tryon/tryon.orchestrator.js';
import { seedTestUsers } from './helpers.js';

const app = createApp('all');
const json = (res: { body: string }) => JSON.parse(res.body);

describe('Phase 13: privacy and hardening', () => {
  let brand: { Authorization: string };
  let support: { Authorization: string };
  let viewer: { Authorization: string };

  beforeAll(async () => {
    seedTestUsers();
    const now = Date.now();
    const mk = (id: string, email: string, role: any) =>
      db.createUser({ id, tenantId: 'tenant_aura', name: id, email, passwordHash: db.hashPassword('Test-Brand-Pass-9'), role, emailVerified: true, emailVerifiedAt: now, createdAt: now });
    mk('user_support_13', 'support13@auraatelier.com', 'SUPPORT_AGENT');
    mk('user_viewer_13', 'viewer13@auraatelier.com', 'ANALYTICS_VIEWER');
    const login = async (email: string, password: string, ip: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password } });
      expect(r.statusCode).toBe(200);
      return { Authorization: `Bearer ${json(r).token}` };
    };
    brand = await login('elena@auraatelier.com', 'Test-Brand-Pass-1', '10.40.0.1');
    support = await login('support13@auraatelier.com', 'Test-Brand-Pass-9', '10.40.0.2');
    viewer = await login('viewer13@auraatelier.com', 'Test-Brand-Pass-9', '10.40.0.3');
  });

  it('adds browser security headers to responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('refuses a try-on job when the shopper did not consent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/jobs',
      payload: { productId: 'prod_aura_dress_01', personImageUrl: 'https://example.com/p.jpg', consentGiven: false },
    });
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('ConsentRequired');
  });

  it('refuses a try-on job whose upload was made without consent', async () => {
    const intent = await app.inject({ method: 'POST', url: '/api/v1/try-on/upload-url', payload: { contentType: 'image/jpeg', sizeBytes: 1024 } });
    expect(intent.statusCode).toBe(201);
    const { bucket, objectKey } = json(intent).data;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/jobs',
      payload: { productId: 'prod_aura_dress_01', personUpload: { bucket, objectKey } },
    });
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('ConsentRequired');
  });

  it('deletes shopper photos once they are past retention', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/try-on/upload-url', payload: { contentType: 'image/jpeg', sizeBytes: 1024, consentGiven: true } });
    expect(await tryonOrchestrator.purgeExpiredUploads()).toBe(0);
    expect(await tryonOrchestrator.purgeExpiredUploads(Date.now() + 40 * 86_400_000)).toBeGreaterThan(0);
  });

  it('only lets roles with the review permission reply', async () => {
    const asViewer = await app.inject({ method: 'POST', url: '/api/v1/reviews/rev_x/reply', headers: viewer, payload: { reply: 'Thanks!' } });
    expect(asViewer.statusCode).toBe(403);
    const asSupport = await app.inject({ method: 'POST', url: '/api/v1/reviews/rev_x/reply', headers: support, payload: { reply: 'Thanks!' } });
    expect(asSupport.statusCode).not.toBe(403); // allowed through the permission check (review itself is not found)
  });

  it('pages long lists only when asked', async () => {
    const all = json(await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: brand }));
    expect(all.page).toBeUndefined();
    const paged = json(await app.inject({ method: 'GET', url: '/api/v1/brand/orders?limit=1&offset=0', headers: brand }));
    expect(paged.orders.length).toBeLessThanOrEqual(1);
    expect(paged.page).toMatchObject({ limit: 1, offset: 0, total: all.orders.length });
    const products = json(await app.inject({ method: 'GET', url: '/api/v1/brand/products?limit=1', headers: brand }));
    expect(products.products.length).toBeLessThanOrEqual(1);
    expect(products.page.limit).toBe(1);
  });

  it('rejects oversized registration fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: '10.40.0.9',
      payload: { brandName: 'x'.repeat(200), email: 'a@b.co', password: 'Str0ng!Passw0rd', ownerName: 'Owner' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps angle brackets in saved text', async () => {
    const { sanitizeObject } = await import('../src/infrastructure/sanitization.js');
    expect(sanitizeObject({ name: 'Tom <Kids>\u0007' }).name).toBe('Tom <Kids>');
  });
});
