import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

const STAFF = [
  ['analyst20', 'DATA_ANALYTICS_VIEWER'], // tenants/billing/ai read
  ['ops20', 'PLATFORM_OPERATIONS_ADMIN'], // tenants write+suspend, no billing
  ['finance20', 'FINANCE_BILLING_ADMIN'], // billing write, no tenant suspend
  ['aiops20', 'AI_INFRASTRUCTURE_ADMIN'], // ai manage
  ['officer20', 'SECURITY_COMPLIANCE_OFFICER'], // audit, security, users
] as const;

describe('Phase 20: admin routes check permissions instead of the Super Admin role', () => {
  beforeAll(() => {
    seedTestUsers();
    const now = Date.now();
    for (const [name, role] of STAFF) {
      db.createUser({ id: `user_${name}`, name, email: `${name}@vton-platform.io`, passwordHash: db.hashPassword('Test-Staff-Pass-20'), role, emailVerified: true, emailVerifiedAt: now, createdAt: now });
    }
  });

  it('opens each route to exactly the roles whose permissions cover it', async () => {
    const app = createApp('all');
    const as = async (email: string, password: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email, password } });
      expect(res.statusCode, email).toBe(200);
      return { Authorization: `Bearer ${JSON.parse(res.body).token}` };
    };
    const admin = await as('admin@vton-platform.io', 'Test-Admin-Pass-1');
    const [analyst, ops, finance, aiops, officer] = await Promise.all(STAFF.map(([n]) => as(`${n}@vton-platform.io`, 'Test-Staff-Pass-20')));
    const status = async (method: any, url: string, headers: any, payload?: any) => (await app.inject({ method, url, headers, payload })).statusCode;

    const tenantId = 'tenant_aura';

    // Read routes: analytics, tenants, usage, generations, telemetry
    for (const [url, allowed, denied] of [
      ['/api/v1/admin/analytics/overview', [analyst, ops, finance, aiops, admin], [officer]],
      ['/api/v1/admin/analytics/series?months=3', [analyst, ops, finance, aiops, admin], [officer]],
      ['/api/v1/admin/tenants', [analyst, ops, finance, aiops, admin], [officer]],
      ['/api/v1/admin/usage', [analyst, ops, finance, aiops, admin], [officer]],
      // ai:read is held by analyst, ops, finance and aiops (not the security officer)
      ['/api/v1/admin/generations', [analyst, ops, finance, aiops, admin], [officer]],
      ['/api/v1/admin/ai/telemetry', [analyst, ops, finance, aiops, admin], [officer]],
      // audit:read is held by everyone except the analytics viewer
      ['/api/v1/admin/audit-logs', [officer, ops, finance, aiops, admin], [analyst]],
    ] as const) {
      for (const h of allowed) expect(await status('GET', url, h), `${url} allowed`).toBe(200);
      for (const h of denied) expect(await status('GET', url, h), `${url} denied`).toBe(403);
    }

    // Write routes
    expect(await status('PATCH', `/api/v1/admin/tenants/${tenantId}/status`, analyst, { status: 'ACTIVE' })).toBe(403);
    expect(await status('PATCH', `/api/v1/admin/tenants/${tenantId}/status`, finance, { status: 'ACTIVE' })).toBe(403);
    expect(await status('PATCH', `/api/v1/admin/tenants/${tenantId}/status`, ops, { status: 'ACTIVE' })).toBe(200);
    expect(await status('PATCH', `/api/v1/admin/tenants/${tenantId}/plan`, ops, { plan: 'PRO' })).toBe(403);
    expect(await status('PATCH', `/api/v1/admin/tenants/${tenantId}/plan`, finance, { plan: 'PRO' })).toBe(200);

    // AI engine secrets need ai:manage
    expect(await status('GET', '/api/v1/admin/ai-engine/config', analyst)).toBe(403);
    expect(await status('GET', '/api/v1/admin/ai-engine/config', aiops)).toBe(200);
    expect(await status('GET', '/api/v1/admin/ai-engine/config', admin)).toBe(200);

    // Database / email infrastructure stays Super Admin only
    for (const h of [analyst, ops, finance, aiops, officer]) {
      expect(await status('GET', '/api/v1/admin/infrastructure/config', h)).toBe(403);
    }
    expect(await status('GET', '/api/v1/admin/infrastructure/config', admin)).toBe(200);

    // Not signed in
    expect(await status('GET', '/api/v1/admin/tenants', {})).toBe(401);

    await app.close();
  });
});
