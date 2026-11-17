import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

const app = createApp('all');

async function loginBrand(email: string, password: string, ip: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password } });
  expect(res.statusCode, `login ${email}`).toBe(200);
  const body = JSON.parse(res.body);
  return { token: body.token as string, sessionId: body.sessionId as string, headers: { Authorization: `Bearer ${body.token}` } };
}

describe('Phase 10: try-on settings, reviews inbox, notifications and change-password', () => {
  let aura: Awaited<ReturnType<typeof loginBrand>>;
  let vogue: Awaited<ReturnType<typeof loginBrand>>;
  let shopper: { headers: { Authorization: string } };

  beforeAll(async () => {
    seedTestUsers();
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner', tenantId: 'tenant_vogue', name: 'Marcus Sterling', email: 'marcus@voguenova.com',
      passwordHash: db.hashPassword('Test-Brand-Pass-2'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now,
    });
    aura = await loginBrand('elena@auraatelier.com', 'Test-Brand-Pass-1', '10.10.0.1');
    vogue = await loginBrand('marcus@voguenova.com', 'Test-Brand-Pass-2', '10.10.0.2');
    const c = await app.inject({
      method: 'POST', url: '/api/v1/marketplace/auth/login', remoteAddress: '10.10.0.3',
      payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
    });
    shopper = { headers: { Authorization: `Bearer ${JSON.parse(c.body).token}` } };
  });

  describe('try-on settings', () => {
    it('returns full defaults for a brand that never saved anything', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/brand/try-on-config', headers: vogue.headers });
      expect(res.statusCode).toBe(200);
      const { config } = JSON.parse(res.body);
      expect(config.enabled).toBe(true);
      expect(config.appearance.primaryBtnText).toBeTruthy();
    });

    it('saves settings per brand and keeps them when other storefront settings change', async () => {
      const put = await app.inject({
        method: 'PUT', url: '/api/v1/brand/try-on-config', headers: aura.headers,
        payload: { appearance: { pageTitle: 'Aura Fitting Room', accentColor: '#112233' }, retentionDays: 14 },
      });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body).config.appearance.pageTitle).toBe('Aura Fitting Room');

      // saving something else on the storefront must not wipe the try-on settings
      await app.inject({ method: 'PUT', url: '/api/v1/brand/storefront-settings', headers: aura.headers, payload: { announcement: 'Hello' } });

      const get = await app.inject({ method: 'GET', url: '/api/v1/brand/try-on-config', headers: aura.headers });
      const config = JSON.parse(get.body).config;
      expect(config.appearance.pageTitle).toBe('Aura Fitting Room');
      expect(config.appearance.accentColor).toBe('#112233');
      expect(config.retentionDays).toBe(14);
      // partial update kept untouched fields
      expect(config.appearance.uploadBtnText).toBeTruthy();

      // another brand is unaffected
      const other = await app.inject({ method: 'GET', url: '/api/v1/brand/try-on-config', headers: vogue.headers });
      expect(JSON.parse(other.body).config.appearance.pageTitle).not.toBe('Aura Fitting Room');
    });

    it('rejects invalid values and unknown fields', async () => {
      const bad = [
        { appearance: { accentColor: 'red' } },
        { appearance: { pageTitle: 'x'.repeat(200) } },
        { retentionDays: 9999 },
        { privacyPolicyUrl: 'javascript:alert(1)' },
        { privacyPolicyUrl: 'http://insecure.example.com' },
        { isAdmin: true },
        { appearance: { unknownKey: 1 } },
      ];
      for (const payload of bad) {
        const res = await app.inject({ method: 'PUT', url: '/api/v1/brand/try-on-config', headers: aura.headers, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('keeps shoppers out of the brand endpoints and serves a public read by slug', async () => {
      const asShopper = await app.inject({ method: 'PUT', url: '/api/v1/brand/try-on-config', headers: shopper.headers, payload: { enabled: false } });
      expect([401, 403]).toContain(asShopper.statusCode);
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/brand/try-on-config' });
      expect(anonymous.statusCode).toBe(401);

      const pub = await app.inject({ method: 'GET', url: '/api/v1/brands/aura-atelier/try-on-config' });
      expect(pub.statusCode).toBe(200);
      expect(JSON.parse(pub.body).config.appearance.pageTitle).toBe('Aura Fitting Room');
      const missing = await app.inject({ method: 'GET', url: '/api/v1/brands/no-such-brand/try-on-config' });
      expect(missing.statusCode).toBe(404);
    });

    it('stops try-ons for a brand that turned the feature off', async () => {
      const prod = await app.inject({
        method: 'POST', url: '/api/v1/products', headers: aura.headers,
        payload: { name: 'Try-On Switch Test', category: 'Dresses', price: 99, sku: `SW-${Date.now()}`, marketplacePublished: true, brandStorefrontPublished: true, isTryOnEligible: true },
      });
      const productId = JSON.parse(prod.body).product.id;
      await app.inject({ method: 'PUT', url: '/api/v1/brand/try-on-config', headers: aura.headers, payload: { enabled: false } });
      const res = await app.inject({
        method: 'POST', url: '/api/v1/try-on/direct', remoteAddress: '10.10.0.9',
        payload: { productId, personImage: 'data:image/png;base64,AAAA', garmentImage: 'data:image/png;base64,AAAA' },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('TryOnDisabled');
      await app.inject({ method: 'PUT', url: '/api/v1/brand/try-on-config', headers: aura.headers, payload: { enabled: true } });
    });
  });

  describe('reviews inbox and notifications', () => {
    it('lets a brand see and answer its own reviews, and notifies the owner of new ones', async () => {
      const prod = await app.inject({
        method: 'POST', url: '/api/v1/products', headers: aura.headers,
        payload: { name: 'Review Target Coat', category: 'Outerwear', price: 150, sku: `RV-${Date.now()}`, marketplacePublished: true, brandStorefrontPublished: true },
      });
      const productId = JSON.parse(prod.body).product.id;

      const review = await app.inject({
        method: 'POST', url: `/api/v1/products/${productId}/reviews`, headers: shopper.headers,
        payload: { rating: 5, comment: 'Beautiful fit' },
      });
      expect(review.statusCode).toBe(201);
      const reviewId = JSON.parse(review.body).data.review.id;

      const inbox = await app.inject({ method: 'GET', url: '/api/v1/brand/reviews', headers: aura.headers });
      expect(inbox.statusCode).toBe(200);
      const mine = JSON.parse(inbox.body).data.reviews.find((r: any) => r.id === reviewId);
      expect(mine.productName).toBe('Review Target Coat');

      // a different brand cannot see it, and customers cannot open the inbox
      const otherInbox = await app.inject({ method: 'GET', url: '/api/v1/brand/reviews', headers: vogue.headers });
      expect(JSON.parse(otherInbox.body).data.reviews.some((r: any) => r.id === reviewId)).toBe(false);
      const asShopper = await app.inject({ method: 'GET', url: '/api/v1/brand/reviews', headers: shopper.headers });
      expect([401, 403]).toContain(asShopper.statusCode);

      const wrongBrandReply = await app.inject({ method: 'POST', url: `/api/v1/reviews/${reviewId}/reply`, headers: vogue.headers, payload: { reply: 'nope' } });
      expect(wrongBrandReply.statusCode).toBe(403);
      const reply = await app.inject({ method: 'POST', url: `/api/v1/reviews/${reviewId}/reply`, headers: aura.headers, payload: { reply: 'Thank you!' } });
      expect(reply.statusCode).toBe(200);

      const notes = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: aura.headers });
      const list = JSON.parse(notes.body).data.notifications as Array<{ id: string; title: string }>;
      const note = list.find((n) => n.title === 'New product review');
      expect(note).toBeTruthy();
      const read = await app.inject({ method: 'POST', url: `/api/v1/notifications/${note!.id}/read`, headers: aura.headers });
      expect(read.statusCode).toBe(200);
    });
  });

  describe('change password', () => {
    it('verifies the current password, enforces the policy and signs out other devices', async () => {
      const first = await loginBrand('marcus@voguenova.com', 'Test-Brand-Pass-2', '10.10.1.1');
      const second = await loginBrand('marcus@voguenova.com', 'Test-Brand-Pass-2', '10.10.1.2');
      const url = '/api/v1/auth/change-password';

      const wrongCurrent = await app.inject({ method: 'POST', url, headers: first.headers, payload: { currentPassword: 'not-it', newPassword: 'Brand-New-Pass-9' } });
      expect(wrongCurrent.statusCode).toBe(400);
      const weak = await app.inject({ method: 'POST', url, headers: first.headers, payload: { currentPassword: 'Test-Brand-Pass-2', newPassword: 'short' } });
      expect(weak.statusCode).toBe(400);
      const unauth = await app.inject({ method: 'POST', url, payload: { currentPassword: 'a', newPassword: 'b' } });
      expect(unauth.statusCode).toBe(401);

      const ok = await app.inject({ method: 'POST', url, headers: first.headers, payload: { currentPassword: 'Test-Brand-Pass-2', newPassword: 'Brand-New-Pass-9' } });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body).data.revokedOtherSessions).toBeGreaterThanOrEqual(1);

      // this device stays signed in, the other one is signed out
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: first.headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: second.headers })).statusCode).toBe(401);

      // old password is dead, new one works
      const oldLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.10.1.3', payload: { email: 'marcus@voguenova.com', password: 'Test-Brand-Pass-2' } });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.10.1.4', payload: { email: 'marcus@voguenova.com', password: 'Brand-New-Pass-9' } });
      expect(newLogin.statusCode).toBe(200);
    });
  });
});
