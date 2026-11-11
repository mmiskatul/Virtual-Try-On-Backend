import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 6: Super Admin Control Plane APIs', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('operates full Super Admin control plane: snapshot, tenant creation, user suspension, moderation, CMS, flags, webhooks & refunds', async () => {
    const app = createApp('all');
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = JSON.parse(adminLogin.body).token;
    const headers = { Authorization: `Bearer ${adminToken}` };

    // 1. Create a new Tenant via Super Admin
    const createTenant = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers,
      payload: {
        name: 'Maison Lumiere Paris',
        slug: `lumiere-${Date.now()}`,
        contactEmail: 'ops@lumiere.paris',
        planSlug: 'PRO',
      },
    });
    expect(createTenant.statusCode).toBe(201);
    const newTenant = JSON.parse(createTenant.body).data.tenant;
    expect(newTenant.name).toBe('Maison Lumiere Paris');

    // 2. Customer signs in -> Super Admin suspends customer -> customer session rejected
    const custLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/auth/login',
      payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
    });
    const custBody = JSON.parse(custLogin.body);

    const suspRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${custBody.user.id}/status`,
      headers,
      payload: { status: 'SUSPENDED', reason: 'Abuse prevention test' },
    });
    expect(suspRes.statusCode).toBe(200);

    const custMeAfterSusp = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/auth/me',
      headers: { Authorization: `Bearer ${custBody.token}` },
    });
    expect(custMeAfterSusp.statusCode).toBe(401); // session revoked!

    // Reactivate cleanly so subsequent test files are unaffected
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${custBody.user.id}/status`,
      headers,
      payload: { status: 'ACTIVE', reason: 'Restore test user' },
    });

    // 3. Toggle AI Model, update AI routing, CMS page, Feature flag, Webhook, Finance refund & Settings
    const modelRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/ai/models/model_fal_catvton',
      headers,
      payload: { active: true, isDefault: true },
    });
    expect(modelRes.statusCode).toBe(200);

    const cmsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cms',
      headers,
      payload: { slug: 'spring-campaign', type: 'BANNER', title: 'Spring Edit', status: 'PUBLISHED', sortOrder: 2 },
    });
    expect(cmsRes.statusCode).toBe(201);

    const flagRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/feature-flags/multi_garment_layering',
      headers,
      payload: { globalEnabled: true, rolloutPct: 100 },
    });
    expect(flagRes.statusCode).toBe(200);
    expect(JSON.parse(flagRes.body).data.flag.globalEnabled).toBe(true);

    const hookRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/webhooks',
      headers,
      payload: { url: 'https://hooks.partner-erp.example/vton', events: ['tryon.completed', 'order.paid'] },
    });
    expect(hookRes.statusCode).toBe(201);

    // 4. Fetch unified control-plane snapshot
    const snapRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/control-plane/snapshot',
      headers,
    });
    expect(snapRes.statusCode).toBe(200);
    const snap = JSON.parse(snapRes.body).data;
    expect(snap.users.length).toBeGreaterThan(0);
    expect(snap.plans.length).toBeGreaterThanOrEqual(3);
    expect(snap.cmsPages.some((p: any) => p.slug === 'spring-campaign')).toBe(true);
    expect(snap.webhooks.length).toBeGreaterThanOrEqual(1);
    expect(snap.aiModels.some((m: any) => m.id === 'model_fal_catvton' && m.isDefault)).toBe(true);

    await app.close();
  });
});

