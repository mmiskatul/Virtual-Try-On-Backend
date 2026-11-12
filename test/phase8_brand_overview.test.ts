import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 8: Brand Overview Endpoints, Validation & Tenant Isolation', () => {
  const app = createApp('all');
  let auraToken = '';
  let vogueToken = '';

  beforeAll(async () => {
    db.reset();
    seedTestUsers();

    // Seed a second brand owner in tenant_vogue to verify strict tenant isolation
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner',
      tenantId: 'tenant_vogue',
      name: 'Marcus Vogue',
      email: 'marcus@voguehouse.io',
      passwordHash: db.hashPassword('Test-Brand-Pass-2'),
      role: 'BRAND_OWNER',
      emailVerified: true,
      emailVerifiedAt: now,
      createdAt: now,
    });

    const auraLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(auraLogin.statusCode).toBe(200);
    auraToken = JSON.parse(auraLogin.body).token;

    const vogueLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'marcus@voguehouse.io', password: 'Test-Brand-Pass-2' },
    });
    expect(vogueLogin.statusCode).toBe(200);
    vogueToken = JSON.parse(vogueLogin.body).token;
  });

  it('rejects unauthenticated requests to all overview endpoints with 401', async () => {
    const endpoints: Array<{ method: 'GET' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'GET', url: '/api/v1/brand/overview' },
      { method: 'GET', url: '/api/v1/brand/overview/timeseries?period=7d' },
      { method: 'GET', url: '/api/v1/brand/overview/activity' },
      { method: 'GET', url: '/api/v1/brand/overview/checklist' },
      { method: 'PUT', url: '/api/v1/brand/overview/checklist', payload: { toggleId: 'chk_logo' } },
    ];

    for (const ep of endpoints) {
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        ...(ep.payload ? { payload: ep.payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('returns Zod-validated tenant-scoped summary from GET /api/v1/brand/overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.currency).toBe('BDT');
    expect(body.workspace.id).toBe('tenant_aura');
    expect(body.workspace.name).toBeTruthy();
    expect(typeof body.kpis.totalRevenue).toBe('number');
    expect(typeof body.kpis.totalOrders).toBe('number');
    expect(typeof body.kpis.totalProducts).toBe('number');
    expect(body.kpis.totalProducts).toBeGreaterThanOrEqual(1);
    expect(typeof body.kpis.tryOnUsed).toBe('number');
    expect(typeof body.kpis.tryOnQuota).toBe('number');
    expect(Array.isArray(body.topProducts)).toBe(true);
    expect(Array.isArray(body.lowStockProducts)).toBe(true);
    expect(Array.isArray(body.recentOrders)).toBe(true);

    // Vogue product must never appear in Aura summary
    expect(body.topProducts.some((p: any) => p.id === 'prod_vogue_jacket_01')).toBe(false);
    expect(body.lowStockProducts.some((p: any) => p.id === 'prod_vogue_jacket_01')).toBe(false);
  });

  it('supports period and custom date filtering on GET /api/v1/brand/overview/timeseries and rejects bad inputs with 400', async () => {
    for (const period of ['today', '7d', '30d', '90d']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/brand/overview/timeseries?period=${period}`,
        headers: { Authorization: `Bearer ${auraToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.currency).toBe('BDT');
      expect(body.period).toBe(period);
      expect(Array.isArray(body.series)).toBe(true);
      expect(body.series.length).toBeGreaterThan(0);
    }

    const customOk = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/timeseries?period=custom&startDate=2026-10-01&endDate=2026-10-05',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(customOk.statusCode).toBe(200);
    const customBody = JSON.parse(customOk.body);
    expect(customBody.period).toBe('custom');
    expect(customBody.series.length).toBe(7);

    const customFallback = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/timeseries?period=custom',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(customFallback.statusCode).toBe(200);
    expect(JSON.parse(customFallback.body).series.length).toBe(6);

    const malformedDate = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/timeseries?period=custom&startDate=not-a-date&endDate=2026-10-05',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(malformedDate.statusCode).toBe(400);
    expect(JSON.parse(malformedDate.body).error).toBe('ValidationError');

    const reversedDates = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/timeseries?period=custom&startDate=2026-10-10&endDate=2026-10-01',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(reversedDates.statusCode).toBe(400);

    const invalidPeriod = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/timeseries?period=100y',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(invalidPeriod.statusCode).toBe(400);
  });

  it('returns merged activity timeline from GET /api/v1/brand/overview/activity and validates limit', async () => {
    // Trigger an inventory adjustment so at least one tenant-specific activity exists
    await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/adjust',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        productId: 'prod_aura_dress_01',
        variantSku: 'AUR-DRS-001-S',
        change: 2,
        reason: 'Overview activity test restock',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/activity?limit=10',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities.length).toBeGreaterThan(0);
    expect(body.activities.length).toBeLessThanOrEqual(10);
    for (const act of body.activities) {
      expect(act.entity).not.toBe('User');
      expect(act.details).not.toMatch(/ipMasked|sessionId|correlationId/i);
    }

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/activity?limit=200',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('persists checklist toggles via PUT /api/v1/brand/overview/checklist and isolates state per tenant', async () => {
    const getBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(getBefore.statusCode).toBe(200);
    const beforeBody = JSON.parse(getBefore.body);
    expect(beforeBody.totalCount).toBe(10);

    const toggleOn = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { toggleId: 'chk_cover' },
    });
    expect(toggleOn.statusCode).toBe(200);
    const toggledBody = JSON.parse(toggleOn.body);
    expect(toggledBody.manualCompletedIds).toContain('chk_cover');
    expect(toggledBody.completedIds).toContain('chk_cover');

    // Verify persistence on tenant object and isolation from tenant_vogue
    const vogueChecklist = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${vogueToken}` },
    });
    expect(vogueChecklist.statusCode).toBe(200);
    expect(JSON.parse(vogueChecklist.body).manualCompletedIds).not.toContain('chk_cover');

    // Toggle off
    const toggleOff = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { toggleId: 'chk_cover' },
    });
    expect(toggleOff.statusCode).toBe(200);
    expect(JSON.parse(toggleOff.body).manualCompletedIds).not.toContain('chk_cover');

    // Replace completedIds
    const replaceRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { completedIds: ['chk_profile', 'chk_cover'] },
    });
    expect(replaceRes.statusCode).toBe(200);
    expect(JSON.parse(replaceRes.body).manualCompletedIds).toEqual(['chk_profile', 'chk_cover']);

    // Invalid body / unknown ID returns 400
    const badId = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { toggleId: 'chk_does_not_exist' },
    });
    expect(badId.statusCode).toBe(400);

    const emptyPayload = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/overview/checklist',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {},
    });
    expect(emptyPayload.statusCode).toBe(400);
  });
});
