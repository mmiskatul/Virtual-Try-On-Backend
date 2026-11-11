import './setup_env.js';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';
import { hasPermission, ROLE_DEFINITIONS } from '../src/modules/rbac/rbac.catalog.js';
import { maskIpAddress } from '../src/modules/audit/audit.service.js';
import { verifySupabaseJwt } from '../src/modules/auth/jwt.verifier.js';

function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

describe('Phase 2: Identity, Dual JWT/Supabase, RBAC, Tenant Scope, View-As & Audit', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('defines all 10 platform admin roles, 7 brand roles, plus STORE_MANAGER and CUSTOMER', () => {
    expect(ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(19);
    expect(hasPermission(['SUPER_ADMIN'], 'ai:manage')).toBe(true);
    expect(hasPermission(['FINANCE_BILLING_ADMIN'], 'billing:refund')).toBe(true);
    expect(hasPermission(['FINANCE_BILLING_ADMIN'], 'ai:manage')).toBe(false);
    expect(hasPermission(['ANALYTICS_VIEWER'], 'brand:products:write')).toBe(false);
    expect(hasPermission(['CATALOG_MANAGER'], 'brand:products:write')).toBe(true);
  });

  it('verifies Supabase Auth HS256 JWT tokens when SUPABASE_JWT_SECRET is configured', async () => {
    const prev = process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_SECRET = 'super_secret_supabase_hs256_key_for_vitest';
    try {
      const token = signHs256Jwt(
        {
          sub: 'auth_uid_999',
          email: 'customer@demo.com',
          exp: Math.floor(Date.now() / 1000) + 300,
          app_metadata: { role: 'CUSTOMER' },
        },
        process.env.SUPABASE_JWT_SECRET
      );
      const claims = await verifySupabaseJwt(token);
      expect(claims).not.toBeNull();
      expect(claims?.authSource).toBe('supabase_jwt');
      expect(claims?.sub).toBe('auth_uid_999');
      expect(claims?.email).toBe('customer@demo.com');

      const badToken = signHs256Jwt({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 300 }, 'wrong_secret');
      expect(await verifySupabaseJwt(badToken)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
      else process.env.SUPABASE_JWT_SECRET = prev;
    }
  });

  it('tracks login sessions and blocks revoked JWTs immediately', async () => {
    const app = createApp('all');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token, sessionId } = JSON.parse(loginRes.body);
    expect(token).toBeTruthy();
    expect(sessionId).toBeTruthy();

    // Active session succeeds
    const me1 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me1.statusCode).toBe(200);
    const sessionsPayload = JSON.parse(me1.body);
    expect(sessionsPayload.success).toBe(true);
    expect(sessionsPayload.data.currentSessionId).toBe(sessionId);

    // Revoke the session
    const revRes = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/sessions/${sessionId}/revoke`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revRes.statusCode).toBe(200);

    // Revoked session is rejected with 401 SessionRevoked
    const me2 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me2.statusCode).toBe(401);
    expect(JSON.parse(me2.body).error).toBe('SessionRevoked');

    await app.close();
  });

  it('enforces RBAC on admin endpoints and supports audited READ_ONLY View-As sessions', async () => {
    const app = createApp('all');

    // Brand owner cannot inspect platform RBAC roles
    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    const brandToken = JSON.parse(brandLogin.body).token;

    const deniedRbac = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/rbac/roles',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(deniedRbac.statusCode).toBe(403);

    // Super admin starts READ_ONLY View-As session for first tenant
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = JSON.parse(adminLogin.body).token;
    const tenants = db.getTenants();
    const targetTenantId = tenants[0].id;

    // Reason < 5 chars rejected
    const badReason = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${targetTenantId}/view-as`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { mode: 'READ_ONLY', reason: 'hi' },
    });
    expect(badReason.statusCode).toBe(400);

    const startRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${targetTenantId}/view-as`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { mode: 'READ_ONLY', reason: 'Investigating ticket #402 garment upload timeout' },
    });
    expect(startRes.statusCode).toBe(200);
    const viewAsSessionId = JSON.parse(startRes.body).data.session.id;

    // Using X-View-As-Session scopes request to target tenant
    const activeCheck = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/rbac/me',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'X-View-As-Session': viewAsSessionId,
      },
    });
    expect(activeCheck.statusCode).toBe(200);
    expect(JSON.parse(activeCheck.body).data.viewAs.tenantId).toBe(targetTenantId);

    // Super Admin in READ_ONLY View-As can read products...
    const viewAsReadProds = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'X-View-As-Session': viewAsSessionId,
      },
    });
    expect(viewAsReadProds.statusCode).toBe(200);

    // ...but mutating via View-As READ_ONLY is rejected 403 ViewAsReadOnly
    const viewAsWriteBlocked = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'X-View-As-Session': viewAsSessionId,
      },
      payload: { name: 'Blocked', category: 'Tops', price: 10, sku: 'BLK-1' },
    });
    expect(viewAsWriteBlocked.statusCode).toBe(403);
    expect(JSON.parse(viewAsWriteBlocked.body).error).toBe('ViewAsReadOnly');

    // Brand owner sending spoofed client tenantId is rejected 403 TenantScopeViolation
    const spoofTenantBody = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { tenantId: 'tenant_other_brand', name: 'Spoof', category: 'Tops', price: 10, sku: 'SPF-1' },
    });
    expect(spoofTenantBody.statusCode).toBe(403);
    expect(JSON.parse(spoofTenantBody.body).error).toBe('TenantScopeViolation');

    // Brand owner sending X-View-As-Session header is rejected 403
    const spoofHeader = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/rbac/me',
      headers: {
        Authorization: `Bearer ${brandToken}`,
        'X-View-As-Session': viewAsSessionId,
      },
    });
    expect(spoofHeader.statusCode).toBe(403);

    // End View-As session
    const endRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/view-as/${viewAsSessionId}/end`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(endRes.statusCode).toBe(200);

    // Mask IP helper
    expect(maskIpAddress('192.168.10.42')).toBe('192.168.10.xxx');

    await app.close();
  });
});
