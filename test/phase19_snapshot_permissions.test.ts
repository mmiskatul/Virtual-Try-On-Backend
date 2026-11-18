import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 19: control-plane snapshot and audit logs follow role permissions', () => {
  beforeAll(() => {
    seedTestUsers();
    const now = Date.now();
    for (const [id, email, role] of [
      ['user_officer_19', 'officer19@vton-platform.io', 'SECURITY_COMPLIANCE_OFFICER'],
      ['user_analyst_19', 'analyst19@vton-platform.io', 'DATA_ANALYTICS_VIEWER'],
    ] as const) {
      db.createUser({ id, name: role, email, passwordHash: db.hashPassword('Test-Staff-Pass-19'), role, emailVerified: true, emailVerifiedAt: now, createdAt: now });
    }
  });

  const login = async (app: ReturnType<typeof createApp>, email: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email, password } });
    expect(res.statusCode, `login ${email}`).toBe(200);
    return { Authorization: `Bearer ${JSON.parse(res.body).token}` };
  };

  it('gives each role only the snapshot sections it can read, and lets the officer read the audit log', async () => {
    const app = createApp('all');
    const admin = await login(app, 'admin@vton-platform.io', 'Test-Admin-Pass-1');
    const officer = await login(app, 'officer19@vton-platform.io', 'Test-Staff-Pass-19');
    const analyst = await login(app, 'analyst19@vton-platform.io', 'Test-Staff-Pass-19');
    const snap = async (headers: any) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/control-plane/snapshot', headers });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).data;
    };

    // Super Admin: everything
    const all = await snap(admin);
    for (const section of ['users', 'plans', 'invoices', 'aiModels', 'featureFlags', 'settings', 'tickets', 'moderationProducts']) {
      expect(all[section], section).toBeDefined();
    }

    // Security & Compliance Officer: users + security sections, but no billing, AI, moderation or support data
    const o = await snap(officer);
    for (const section of ['users', 'featureFlags', 'webhooks', 'governanceRequests', 'settings']) expect(o[section], section).toBeDefined();
    for (const section of ['invoices', 'orders', 'refunds', 'creditLedger', 'aiModels', 'moderationProducts', 'tickets', 'plans', 'cmsPages']) {
      expect(o[section], section).toBeUndefined();
    }

    // Analytics viewer: billing + AI, but no users or security sections
    const a = await snap(analyst);
    for (const section of ['plans', 'invoices', 'orders', 'aiModels']) expect(a[section], section).toBeDefined();
    for (const section of ['users', 'featureFlags', 'settings', 'tickets', 'webhooks']) expect(a[section], section).toBeUndefined();

    // Audit log: officer (audit:read) yes, analyst (no audit:read) no
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: officer })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: analyst })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: admin })).statusCode).toBe(200);

    // The officer is still kept out of things their role does not cover
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/tenants', headers: officer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/finance', headers: officer })).statusCode).toBe(403);

    await app.close();
  });
});
