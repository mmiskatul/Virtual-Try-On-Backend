import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';
import { checkExtras, effectivePermissions, generateTemporaryPassword } from '../src/modules/team/team_access.js';
import { validateStrongPassword } from '../src/routes/auth/auth.service.js';

const app = createApp('all');
const json = (res: { body: string }) => JSON.parse(res.body);
let ipCounter = 10;
const nextIp = () => `10.50.0.${ipCounter++}`;

type Headers = { Authorization: string };
async function login(email: string, password: string): Promise<{ status: number; headers?: Headers; body: any }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: nextIp(), payload: { email, password } });
  const body = json(res);
  return { status: res.statusCode, headers: body.token ? { Authorization: `Bearer ${body.token}` } : undefined, body };
}

describe('Team: add people with a password, and give one person extra access', () => {
  let owner: Headers;
  let otherOwner: Headers;

  const create = (headers: Headers, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/brand/team/members', headers, payload });
  const patch = (headers: Headers, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/brand/team/members/${id}`, headers, payload });
  const team = async (headers: Headers) => json(await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers }));
  const salesReport = (headers: Headers) => app.inject({ method: 'GET', url: '/api/v1/brand/reports/sales', headers });

  beforeAll(async () => {
    seedTestUsers();
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner_22', tenantId: 'tenant_vogue', name: 'Marcus Vogue', email: 'marcus22@voguenova.com',
      passwordHash: db.hashPassword('Test-Brand-Pass-2'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now,
    });
    owner = (await login('elena@auraatelier.com', 'Test-Brand-Pass-1')).headers!;
    otherOwner = (await login('marcus22@voguenova.com', 'Test-Brand-Pass-2')).headers!;
  });

  describe('helpers', () => {
    it('makes readable temporary passwords that pass the password rules', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 25; i += 1) {
        const pw = generateTemporaryPassword();
        expect(validateStrongPassword(pw)).toBeNull();
        expect(pw).toHaveLength(12);
        seen.add(pw);
      }
      expect(seen.size).toBe(25);
    });

    it('extras only add to a role, and only real, allowed ones count', () => {
      const ownerCtx = { role: 'SUPPORT_AGENT', granterPermissions: new Set<string>(), granterIsOwner: true };
      // The role already includes orders:read, so it is not an extra.
      expect(checkExtras(['brand:orders:read', 'brand:analytics:read'], ownerCtx).extras).toEqual(['brand:analytics:read']);
      expect(checkExtras(['brand:made:up'], ownerCtx).ok).toBe(false);
      expect(checkExtras('nope', ownerCtx).ok).toBe(false);
      // A non-owner cannot give billing or team access, or access they do not have.
      const adminCtx = { role: 'SUPPORT_AGENT', granterPermissions: new Set(['brand:analytics:read']), granterIsOwner: false };
      expect(checkExtras(['brand:billing:manage'], adminCtx).ok).toBe(false);
      expect(checkExtras(['brand:products:write'], adminCtx).ok).toBe(false);
      expect(checkExtras(['brand:analytics:read'], adminCtx).ok).toBe(true);
      expect(effectivePermissions('SUPPORT_AGENT', ['brand:analytics:read']).has('brand:analytics:read')).toBe(true);
      expect(effectivePermissions('SUPPORT_AGENT', []).has('brand:analytics:read')).toBe(false);
    });
  });

  describe('adding a person with an email and a password', () => {
    it('lets them sign in, asks them to choose their own password first, then they work as their role', async () => {
      const res = await create(owner, { name: 'Nadia Order', email: 'nadia.orders@auraatelier.com', role: 'ORDER_MANAGER', password: 'Temp-Pass-1234' });
      expect(res.statusCode).toBe(201);
      const body = json(res);
      expect(body.member.role).toBe('ORDER_MANAGER');
      expect(body.member.mustChangePassword).toBe(true);
      expect(body.temporaryPassword).toBeUndefined(); // a password you typed is never sent back

      const first = await login('nadia.orders@auraatelier.com', 'Temp-Pass-1234');
      expect(first.status).toBe(200);

      // Until they choose their own password, only the password page works.
      const blocked = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: first.headers });
      expect([403]).toContain(blocked.statusCode);
      const brandOrders = await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: first.headers });
      expect(brandOrders.statusCode).toBe(403);
      expect(json(brandOrders).error).toBe('PasswordChangeRequired');
      const me = await app.inject({ method: 'GET', url: '/api/v1/auth/rbac/me', headers: first.headers });
      expect(me.statusCode).toBe(200);

      const changed = await app.inject({
        method: 'POST', url: '/api/v1/auth/change-password', headers: first.headers,
        payload: { currentPassword: 'Temp-Pass-1234', newPassword: 'My-Own-Pass-77' },
      });
      expect(changed.statusCode).toBe(200);

      const again = await login('nadia.orders@auraatelier.com', 'My-Own-Pass-77');
      const ok = await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: again.headers });
      expect(ok.statusCode).toBe(200);
      const members = (await team(owner)).members;
      expect(members.find((m: any) => m.email === 'nadia.orders@auraatelier.com').mustChangePassword).toBe(false);
    });

    it('makes a temporary password when none is given, and shows it only once', async () => {
      const res = await create(owner, { name: 'Tariq Catalog', email: 'tariq.catalog@auraatelier.com', role: 'CATALOG_MANAGER' });
      expect(res.statusCode).toBe(201);
      const pw = json(res).temporaryPassword;
      expect(typeof pw).toBe('string');
      expect((await login('tariq.catalog@auraatelier.com', pw)).status).toBe(200);
      const listed = JSON.stringify(await team(owner));
      expect(listed).not.toContain(pw);
      expect(listed).not.toContain('passwordHash');
    });

    it('can skip the forced password change when the owner chooses to', async () => {
      const res = await create(owner, { name: 'Sara Stock', email: 'sara.stock@auraatelier.com', role: 'INVENTORY_MANAGER', password: 'Stock-Pass-2024', mustChangePassword: false });
      expect(json(res).member.mustChangePassword).toBe(false);
      const ses = await login('sara.stock@auraatelier.com', 'Stock-Pass-2024');
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: ses.headers })).statusCode).toBe(403); // inventory managers cannot see orders
      expect((await app.inject({ method: 'GET', url: '/api/v1/auth/rbac/me', headers: ses.headers })).statusCode).toBe(200);
    });

    it('refuses weak passwords, used emails, the owner role, and unknown fields', async () => {
      expect((await create(owner, { name: 'Weak One', email: 'weak@auraatelier.com', role: 'SUPPORT_AGENT', password: 'abc' })).statusCode).toBe(400);
      expect((await create(owner, { name: 'Dup', email: 'nadia.orders@auraatelier.com', role: 'SUPPORT_AGENT' })).statusCode).toBe(409);
      expect((await create(owner, { name: 'Boss', email: 'boss@auraatelier.com', role: 'BRAND_OWNER' })).statusCode).toBe(400);
      expect((await create(owner, { name: 'Odd', email: 'odd@auraatelier.com', role: 'SUPPORT_AGENT', admin: true })).statusCode).toBe(400);
      expect((await create(owner, { name: 'Bad Mail', email: 'not-an-email', role: 'SUPPORT_AGENT' })).statusCode).toBe(400);
      expect((await create({ Authorization: 'Bearer nope' }, { name: 'No Login', email: 'nologin@auraatelier.com', role: 'SUPPORT_AGENT' })).statusCode).toBe(401);
    });
  });

  describe('extra access for one person', () => {
    let supportId = '';
    let supportHeaders: Headers;

    beforeAll(async () => {
      const res = await create(owner, { name: 'Support Sam', email: 'sam.support@auraatelier.com', role: 'SUPPORT_AGENT', password: 'Support-Pass-55', mustChangePassword: false });
      expect(res.statusCode).toBe(201);
      supportId = json(res).member.id;
      supportHeaders = (await login('sam.support@auraatelier.com', 'Support-Pass-55')).headers!;
    });

    it('a role gives its fixed default access, and nothing more', async () => {
      expect((await salesReport(supportHeaders)).statusCode).toBe(403);
    });

    it('the owner can add reports access for this person, and take it away again', async () => {
      const added = await patch(owner, supportId, { extraPermissions: ['brand:analytics:read'] });
      expect(added.statusCode).toBe(200);
      expect(json(added).member.extraPermissions).toEqual(['brand:analytics:read']);
      expect(json(added).member.effectivePermissions).toContain('brand:analytics:read');

      // Takes effect straight away, with the same sign-in.
      expect((await salesReport(supportHeaders)).statusCode).toBe(200);
      const me = json(await app.inject({ method: 'GET', url: '/api/v1/auth/rbac/me', headers: supportHeaders }));
      expect(me.data.permissions).toContain('brand:analytics:read');

      const removed = await patch(owner, supportId, { extraPermissions: [] });
      expect(json(removed).member.extraPermissions).toEqual([]);
      expect((await salesReport(supportHeaders)).statusCode).toBe(403);
    });

    it('only real extras count, and what the role already has is not stored as an extra', async () => {
      expect((await patch(owner, supportId, { extraPermissions: ['brand:made:up'] })).statusCode).toBe(403);
      const res = await patch(owner, supportId, { extraPermissions: ['brand:orders:read', 'brand:products:write'] });
      expect(json(res).member.extraPermissions).toEqual(['brand:products:write']);
      await patch(owner, supportId, { extraPermissions: [] });
    });

    it('changing the role keeps extras that still apply and drops the ones the new role already includes', async () => {
      await patch(owner, supportId, { extraPermissions: ['brand:analytics:read', 'brand:products:write'] });
      const res = await patch(owner, supportId, { role: 'CATALOG_MANAGER' }); // already includes products:write
      expect(res.statusCode).toBe(200);
      expect(json(res).member.role).toBe('CATALOG_MANAGER');
      expect(json(res).member.extraPermissions).toEqual(['brand:analytics:read']);
      await patch(owner, supportId, { role: 'SUPPORT_AGENT', extraPermissions: [] });
    });
  });

  describe('keeping it safe', () => {
    let adminId = '';
    let adminHeaders: Headers;
    let agentId = '';

    beforeAll(async () => {
      const a = await create(owner, { name: 'Admin Amir', email: 'amir.admin@auraatelier.com', role: 'BRAND_ADMIN', password: 'Admin-Pass-8899', mustChangePassword: false });
      expect(a.statusCode).toBe(201);
      adminId = json(a).member.id;
      adminHeaders = (await login('amir.admin@auraatelier.com', 'Admin-Pass-8899')).headers!;
      const s = await create(owner, { name: 'Agent Ali', email: 'ali.agent@auraatelier.com', role: 'SUPPORT_AGENT', password: 'Agent-Pass-1122', mustChangePassword: false });
      agentId = json(s).member.id;
    });

    it('only the owner can add or change an admin', async () => {
      expect((await create(adminHeaders, { name: 'Peer', email: 'peer@auraatelier.com', role: 'BRAND_ADMIN' })).statusCode).toBe(403);
      expect((await patch(adminHeaders, agentId, { role: 'BRAND_ADMIN' })).statusCode).toBe(403);
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/brand/team/members/${adminId}`, headers: adminHeaders });
      expect(del.statusCode).toBe(403);
    });

    it('an admin can add other roles, but cannot give billing or team access', async () => {
      expect((await create(adminHeaders, { name: 'By Admin', email: 'by.admin@auraatelier.com', role: 'ORDER_MANAGER', password: 'ByAdmin-Pass-31' })).statusCode).toBe(201);
      expect((await patch(adminHeaders, agentId, { extraPermissions: ['brand:billing:manage'] })).statusCode).toBe(403);
      expect((await patch(adminHeaders, agentId, { extraPermissions: ['brand:staff:manage'] })).statusCode).toBe(403);
      // The owner can.
      expect((await patch(owner, agentId, { extraPermissions: ['brand:billing:manage'] })).statusCode).toBe(200);
      await patch(owner, agentId, { extraPermissions: [] });
    });

    it('the owner role is fixed, and nobody changes their own access', async () => {
      const ownerId = (await team(owner)).members.find((m: any) => m.isOwner).id;
      expect((await patch(adminHeaders, ownerId, { role: 'ORDER_MANAGER' })).statusCode).toBe(403);
      expect((await patch(owner, ownerId, { extraPermissions: ['brand:analytics:read'] })).statusCode).toBe(403);
      expect((await patch(adminHeaders, adminId, { extraPermissions: [] })).statusCode).toBe(403);
    });

    it('people from another brand cannot touch this team', async () => {
      expect((await patch(otherOwner, agentId, { extraPermissions: ['brand:analytics:read'] })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/v1/brand/team/members/${agentId}/reset-password`, headers: otherOwner, payload: {} })).statusCode).toBe(404);
      const theirs = await team(otherOwner);
      expect(theirs.members.some((m: any) => m.email === 'ali.agent@auraatelier.com')).toBe(false);
    });

    it('switching someone off blocks them straight away, and switching on lets them back', async () => {
      const agent = await login('ali.agent@auraatelier.com', 'Agent-Pass-1122');
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: agent.headers })).statusCode).toBe(200);

      const off = await patch(owner, agentId, { disabled: true });
      expect(json(off).member.disabled).toBe(true);
      const after = await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: agent.headers });
      expect(after.statusCode).toBe(401); // their sessions were ended
      const tryLogin = await login('ali.agent@auraatelier.com', 'Agent-Pass-1122');
      expect(tryLogin.status).toBe(403);
      expect(tryLogin.body.error).toBe('AccountDisabled');

      await patch(owner, agentId, { disabled: false });
      const back = await login('ali.agent@auraatelier.com', 'Agent-Pass-1122');
      expect(back.status).toBe(200);
    });

    it('resetting a password ends their sessions and asks them to choose a new one', async () => {
      const agent = await login('ali.agent@auraatelier.com', 'Agent-Pass-1122');
      const res = await app.inject({ method: 'POST', url: `/api/v1/brand/team/members/${agentId}/reset-password`, headers: owner, payload: {} });
      expect(res.statusCode).toBe(200);
      const temp = json(res).temporaryPassword;
      expect(temp).toBeTruthy();
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: agent.headers })).statusCode).toBe(401);
      expect((await login('ali.agent@auraatelier.com', 'Agent-Pass-1122')).status).toBe(401);
      const fresh = await login('ali.agent@auraatelier.com', temp);
      expect(fresh.status).toBe(200);
      expect(json(await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: fresh.headers })).error).toBe('PasswordChangeRequired');
    });

    it('lists what can be given, and who may give it', async () => {
      const mine = await team(owner);
      expect(mine.canGrantOwnerOnly).toBe(true);
      expect(mine.grantable.length).toBeGreaterThanOrEqual(8);
      expect(mine.grantable.filter((g: any) => g.ownerOnly).map((g: any) => g.key).sort()).toEqual(['brand:billing:manage', 'brand:staff:manage']);
      expect(mine.roles.find((r: any) => r.code === 'BRAND_OWNER').fixed).toBe(true);
      const byAdmin = await team(adminHeaders);
      expect(byAdmin.canGrantOwnerOnly).toBe(false);
    });
  });
});
