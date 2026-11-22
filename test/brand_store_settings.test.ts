import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';
import {
  DEFAULT_STORE_SETTINGS,
  mergeStoreSettings,
  resolveStoreSettings,
  shippingFeeFor,
} from '../src/modules/commerce/store_settings.js';

const app = createApp('all');
const ITEM = { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 };
const json = (res: { body: string }) => JSON.parse(res.body);

describe('Store settings (open or closed, delivery charges, search text)', () => {
  let headers: { Authorization: string };

  const validate = () => app.inject({ method: 'POST', url: '/api/v1/checkout/validate', payload: { items: [ITEM] } });
  const save = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/v1/brand/store-settings', headers, payload: payload as object });

  beforeAll(async () => {
    seedTestUsers();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.30.0.1', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
    expect(login.statusCode).toBe(200);
    headers = { Authorization: `Bearer ${json(login).token}` };
  });

  it('shipping maths: free from the free-delivery amount, otherwise the standard fee', () => {
    expect(DEFAULT_STORE_SETTINGS.shipping).toEqual({ defaultFee: 15, freeOver: 150 });
    expect(shippingFeeFor(DEFAULT_STORE_SETTINGS, 149.99)).toBe(15);
    expect(shippingFeeFor(DEFAULT_STORE_SETTINGS, 150)).toBe(0);
    expect(shippingFeeFor({ ...DEFAULT_STORE_SETTINGS, shipping: { defaultFee: 60, freeOver: null } }, 99999)).toBe(60);
    expect(shippingFeeFor({ ...DEFAULT_STORE_SETTINGS, shipping: { defaultFee: 0, freeOver: 500 } }, 10)).toBe(0);
  });

  it('merging keeps what was not changed', () => {
    const merged = mergeStoreSettings(DEFAULT_STORE_SETTINGS, { shipping: { defaultFee: 40 }, seo: { title: 'Aura' } });
    expect(merged).toEqual({ open: true, shipping: { defaultFee: 40, freeOver: 150 }, seo: { title: 'Aura', description: '' } });
    expect(resolveStoreSettings(null)).toEqual(DEFAULT_STORE_SETTINGS);
  });

  it('a brand that never saved anything gets the defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/brand/store-settings', headers });
    expect(res.statusCode).toBe(200);
    expect(json(res).settings).toEqual(DEFAULT_STORE_SETTINGS);
  });

  it('needs a login to read or save', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/brand/store-settings' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/brand/store-settings', payload: { open: false } })).statusCode).toBe(401);
  });

  it('rejects bad values and unknown fields', async () => {
    for (const bad of [
      { shipping: { defaultFee: -1 } },
      { shipping: { freeOver: -5 } },
      { shipping: { defaultFee: 'free' } },
      { seo: { title: 'x'.repeat(71) } },
      { seo: { description: 'x'.repeat(161) } },
      { open: 'yes' },
      { admin: true },
      { shipping: { defaultFee: 10, extra: 1 } },
    ]) {
      const res = await save(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('checkout uses the saved delivery charges', async () => {
    const before = json(await validate());
    expect(before.shippingFee === 0 || before.shippingFee === 15).toBe(true); // the old rule, unchanged

    const saved = await save({ shipping: { defaultFee: 80, freeOver: null } });
    expect(saved.statusCode).toBe(200);
    expect(json(saved).settings.shipping).toEqual({ defaultFee: 80, freeOver: null });

    const after = json(await validate());
    expect(after.shippingFee).toBe(80);
    expect(after.total).toBe(Number((after.subtotal - after.discountAmount + 80).toFixed(2)));

    // Free delivery again from a low amount.
    await save({ shipping: { defaultFee: 80, freeOver: 1 } });
    expect(json(await validate()).shippingFee).toBe(0);
  });

  it('a closed store refuses orders, and opens again', async () => {
    expect((await save({ open: false })).statusCode).toBe(200);
    const closed = await validate();
    expect(closed.statusCode).toBe(403);
    expect(json(closed).error).toBe('StoreClosed');

    expect((await save({ open: true })).statusCode).toBe(200);
    expect((await validate()).statusCode).toBe(200);
  });

  it('saves the search and sharing text, and shows only the safe parts on the public store', async () => {
    await save({ seo: { title: 'Aura Atelier | Modern Dresses', description: 'Hand-finished dresses from Dhaka.' } });
    const read = json(await app.inject({ method: 'GET', url: '/api/v1/brand/store-settings', headers }));
    expect(read.settings.seo.title).toBe('Aura Atelier | Modern Dresses');

    const tenant = db.getTenantById('tenant_aura');
    const pub = json(await app.inject({ method: 'GET', url: `/api/v1/internal/storefront/${tenant!.slug}` }));
    expect(pub.tenant.storefrontSettings.store.seo.title).toBe('Aura Atelier | Modern Dresses');
    // Private things such as API keys never appear on the public store.
    expect(JSON.stringify(pub)).not.toContain('apiKeys');
    expect(JSON.stringify(pub)).not.toContain('tokenHash');
  });

  it('keeps brands apart', async () => {
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner_ss', tenantId: 'tenant_vogue', name: 'Marcus Sterling', email: 'marcus.ss@voguenova.com',
      passwordHash: db.hashPassword('Test-Brand-Pass-2'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now,
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.30.0.2', payload: { email: 'marcus.ss@voguenova.com', password: 'Test-Brand-Pass-2' } });
    const vogue = { Authorization: `Bearer ${json(login).token}` };
    const res = await app.inject({ method: 'GET', url: '/api/v1/brand/store-settings', headers: vogue });
    expect(json(res).settings).toEqual(DEFAULT_STORE_SETTINGS); // Aura's changes are not Vogue's
  });
});
