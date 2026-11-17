import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

const app = createApp('all');
const ITEM = { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 };
const ADDRESS = { fullName: 'Jane Doe', street: '123 Market St', city: 'Dhaka', zipCode: '1213', country: 'BD' };

type Session = { headers: { Authorization: string } };
const json = (res: { body: string }) => JSON.parse(res.body);

async function login(email: string, password: string, ip: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password } });
  expect(res.statusCode, `login ${email}`).toBe(200);
  return { headers: { Authorization: `Bearer ${json(res).token}` } };
}

const validate = (couponCode?: string) =>
  app.inject({ method: 'POST', url: '/api/v1/checkout/validate', payload: { items: [ITEM], couponCode } });
const order = (couponCode: string | undefined, email: string) =>
  app.inject({ method: 'POST', url: '/api/v1/checkout', remoteAddress: '10.20.0.50', payload: { items: [ITEM], customerEmail: email, shippingAddress: ADDRESS, couponCode } });

describe('Phase 11: customers, discounts and team', () => {
  let aura: Session;
  let vogue: Session;
  let shopper: Session;

  beforeAll(async () => {
    seedTestUsers();
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner_11', tenantId: 'tenant_vogue', name: 'Marcus Sterling', email: 'marcus11@voguenova.com',
      passwordHash: db.hashPassword('Test-Brand-Pass-2'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now,
    });
    aura = await login('elena@auraatelier.com', 'Test-Brand-Pass-1', '10.20.0.1');
    vogue = await login('marcus11@voguenova.com', 'Test-Brand-Pass-2', '10.20.0.2');
    const c = await app.inject({ method: 'POST', url: '/api/v1/marketplace/auth/login', remoteAddress: '10.20.0.3', payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' } });
    shopper = { headers: { Authorization: `Bearer ${json(c).token}` } };
  });

  describe('discounts', () => {
    it('lets the owner create codes, validates input, and keeps brands apart', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/brand/discounts', headers: aura.headers,
        payload: { code: 'welcome10', type: 'PERCENT', value: 10, description: 'Welcome offer' },
      });
      expect(create.statusCode).toBe(201);
      expect(json(create).discount.code).toBe('WELCOME10');

      expect((await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: aura.headers, payload: { code: 'WELCOME10', type: 'PERCENT', value: 5 } })).statusCode).toBe(409);

      for (const bad of [
        { code: 'x', type: 'PERCENT', value: 10 },
        { code: 'BIG', type: 'PERCENT', value: 150 },
        { code: 'NEG', type: 'FIXED', value: -5 },
        { code: 'DATES', type: 'FIXED', value: 5, startsAt: '2030-02-01', endsAt: '2030-01-01' },
        { code: 'EXTRA', type: 'FIXED', value: 5, admin: true },
      ]) {
        const res = await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: aura.headers, payload: bad });
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }

      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/discounts' })).statusCode).toBe(401);
      expect([401, 403]).toContain((await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: shopper.headers, payload: { code: 'HACK', type: 'FIXED', value: 1 } })).statusCode);

      const mine = json(await app.inject({ method: 'GET', url: '/api/v1/brand/discounts', headers: aura.headers })).discounts;
      expect(mine.some((d: any) => d.code === 'WELCOME10')).toBe(true);
      const theirs = json(await app.inject({ method: 'GET', url: '/api/v1/brand/discounts', headers: vogue.headers })).discounts;
      expect(theirs.some((d: any) => d.code === 'WELCOME10')).toBe(false);
      const id = mine.find((d: any) => d.code === 'WELCOME10').id;
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/brand/discounts/${id}`, headers: vogue.headers, payload: { active: false } })).statusCode).toBe(404);
    });

    it('takes the discount off what the shopper really pays, and counts each use', async () => {
      const base = json(await validate());
      const expected = Number((base.subtotal * 0.1).toFixed(2));

      const withCode = json(await validate('welcome10'));
      expect(withCode.discountAmount).toBe(expected);
      expect(withCode.total).toBe(Number((base.subtotal - expected + base.shippingFee).toFixed(2)));

      const placed = await order('WELCOME10', 'discount.buyer@example.com');
      expect(placed.statusCode).toBe(201);
      const stored = db.getOrders().find((o) => o.id === json(placed).orderId)!;
      expect(stored.totalAmount).toBe(withCode.total);
      expect(stored.couponCode).toBe('WELCOME10');

      const list = json(await app.inject({ method: 'GET', url: '/api/v1/brand/discounts', headers: aura.headers })).discounts;
      expect(list.find((d: any) => d.code === 'WELCOME10').usedCount).toBe(1);
    });

    it('rejects unknown, switched-off, expired, used-up and under-minimum codes', async () => {
      const mk = async (payload: any) => json(await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: aura.headers, payload })).discount;
      const base = json(await validate());

      expect((await validate('NOPE')).statusCode).toBe(400);
      expect((await order('NOPE', 'nope@example.com')).statusCode).toBe(400);

      const off = await mk({ code: 'SWITCHEDOFF', type: 'FIXED', value: 5, active: false });
      expect((await validate('SWITCHEDOFF')).statusCode).toBe(400);
      await app.inject({ method: 'PATCH', url: `/api/v1/brand/discounts/${off.id}`, headers: aura.headers, payload: { active: true } });
      expect((await validate('SWITCHEDOFF')).statusCode).toBe(200);

      await mk({ code: 'EXPIRED', type: 'FIXED', value: 5, endsAt: '2000-01-01' });
      expect((await validate('EXPIRED')).statusCode).toBe(400);
      await mk({ code: 'FUTURE', type: 'FIXED', value: 5, startsAt: '2999-01-01' });
      expect((await validate('FUTURE')).statusCode).toBe(400);
      await mk({ code: 'BIGSPEND', type: 'FIXED', value: 5, minOrder: base.subtotal + 1000 });
      expect((await validate('BIGSPEND')).statusCode).toBe(400);

      await mk({ code: 'ONCEONLY', type: 'FIXED', value: 1, maxUses: 1 });
      expect((await order('ONCEONLY', 'once.a@example.com')).statusCode).toBe(201);
      const second = await order('ONCEONLY', 'once.b@example.com');
      expect(second.statusCode).toBe(400);
      expect(json(second).message).toMatch(/used up/i);

      // a fixed discount can never take more than the items cost
      await mk({ code: 'HUGE', type: 'FIXED', value: 999999 });
      const huge = json(await validate('HUGE'));
      expect(huge.discountAmount).toBe(base.subtotal);
      expect(huge.total).toBe(base.shippingFee);
    });

    it('deletes codes', async () => {
      const created = json(await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: aura.headers, payload: { code: 'TEMPCODE', type: 'FIXED', value: 2 } })).discount;
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/discounts/${created.id}`, headers: aura.headers })).statusCode).toBe(200);
      expect((await validate('TEMPCODE')).statusCode).toBe(400);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/discounts/${created.id}`, headers: aura.headers })).statusCode).toBe(404);
    });
  });

  describe('customers', () => {
    it('derives each brand\'s customers from its own orders', async () => {
      await order(undefined, 'repeat.buyer@example.com');
      await order(undefined, 'Repeat.Buyer@example.com');
      const list = json(await app.inject({ method: 'GET', url: '/api/v1/brand/customers', headers: aura.headers }));
      const repeat = list.customers.find((c: any) => c.email === 'repeat.buyer@example.com');
      expect(repeat.orderCount).toBe(2);
      expect(repeat.group).toBe('RETURNING');
      expect(repeat.totalSpent).toBeGreaterThan(0);
      expect(repeat.name).toBe('Jane Doe');
      expect(list.totals.customers).toBe(list.customers.length);

      const detail = json(await app.inject({ method: 'GET', url: `/api/v1/brand/customers/${encodeURIComponent('repeat.buyer@example.com')}`, headers: aura.headers }));
      expect(detail.orders).toHaveLength(2);

      // another brand sees none of them
      const other = json(await app.inject({ method: 'GET', url: '/api/v1/brand/customers', headers: vogue.headers }));
      expect(other.customers.some((c: any) => c.email === 'repeat.buyer@example.com')).toBe(false);
      expect((await app.inject({ method: 'GET', url: `/api/v1/brand/customers/${encodeURIComponent('repeat.buyer@example.com')}`, headers: vogue.headers })).statusCode).toBe(404);

      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/customers' })).statusCode).toBe(401);
      expect([401, 403]).toContain((await app.inject({ method: 'GET', url: '/api/v1/brand/customers', headers: shopper.headers })).statusCode);
    });
  });

  describe('team', () => {
    let inviteUrl = '';
    let token = '';
    let memberId = '';

    it('invites someone, and only owners and admins can manage the team', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/brand/team/invites', headers: aura.headers, payload: { email: 'orders.person@example.com', role: 'ORDER_MANAGER' } });
      expect(res.statusCode).toBe(201);
      inviteUrl = json(res).inviteUrl;
      token = decodeURIComponent(inviteUrl.split('token=')[1]);
      expect(inviteUrl).toContain('/accept-invite?token=');
      // the stored invite never contains the token itself
      expect(JSON.stringify(db.getTenantById('tenant_aura')!.storefrontSettings)).not.toContain(token);

      const team = json(await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers: aura.headers }));
      expect(team.invites.some((i: any) => i.email === 'orders.person@example.com' && i.status === 'PENDING')).toBe(true);
      expect(team.members.some((m: any) => m.isOwner)).toBe(true);
      expect(team.roles.length).toBeGreaterThan(3);
      expect(team.invites[0]).not.toHaveProperty('tokenHash');

      for (const payload of [{ email: 'bad', role: 'ORDER_MANAGER' }, { email: 'x@example.com', role: 'BRAND_OWNER' }, { email: 'y@example.com', role: 'SUPER_ADMIN' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/v1/brand/team/invites', headers: aura.headers, payload })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'POST', url: '/api/v1/brand/team/invites', headers: aura.headers, payload: { email: 'sarah.miller@example.com', role: 'SUPPORT_AGENT' } })).statusCode).toBe(409);
      expect([401, 403]).toContain((await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers: shopper.headers })).statusCode);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/team' })).statusCode).toBe(401);
      expect((json(await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers: vogue.headers })).invites)).toHaveLength(0);
    });

    it('accepts an invitation once, with a strong password, and rejects forged or reused tokens', async () => {
      const accept = (body: any, ip: string) => app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', remoteAddress: ip, payload: body });
      expect((await accept({ token: 'not-a-real-token-at-all-123', name: 'X Y', password: 'Strong-Pass-9' }, '10.20.1.1')).statusCode).toBe(400);
      const forged = `${token.split('.')[0]}.${'A'.repeat(32)}`;
      expect((await accept({ token: forged, name: 'X Y', password: 'Strong-Pass-9' }, '10.20.1.2')).statusCode).toBe(400);
      expect((await accept({ token, name: 'Orders Person', password: 'weak' }, '10.20.1.3')).statusCode).toBe(400);

      const ok = await accept({ token, name: 'Orders Person', password: 'Strong-Pass-9' }, '10.20.1.4');
      expect(ok.statusCode).toBe(201);
      expect((await accept({ token, name: 'Orders Person', password: 'Strong-Pass-9' }, '10.20.1.5')).statusCode).toBe(400);
    });

    it('gives the new member only the permissions of their role', async () => {
      const member = await login('orders.person@example.com', 'Strong-Pass-9', '10.20.1.6');
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: member.headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/customers', headers: member.headers })).statusCode).toBe(200);
      // an order manager cannot edit the catalog, manage the team, or create discounts
      expect((await app.inject({ method: 'POST', url: '/api/v1/products', headers: member.headers, payload: { name: 'Nope', category: 'Tops', price: 10, sku: `NP-${Date.now()}` } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers: member.headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/brand/discounts', headers: member.headers, payload: { code: 'SNEAKY', type: 'FIXED', value: 1 } })).statusCode).toBe(403);

      const team = json(await app.inject({ method: 'GET', url: '/api/v1/brand/team', headers: aura.headers }));
      const row = team.members.find((m: any) => m.email === 'orders.person@example.com');
      expect(row.role).toBe('ORDER_MANAGER');
      memberId = row.id;
      expect(team.invites.some((i: any) => i.email === 'orders.person@example.com')).toBe(false);
    });

    it('changes roles immediately and protects the owner and yourself', async () => {
      const promote = await app.inject({ method: 'PATCH', url: `/api/v1/brand/team/members/${memberId}`, headers: aura.headers, payload: { role: 'CATALOG_MANAGER' } });
      expect(promote.statusCode).toBe(200);
      const member = await login('orders.person@example.com', 'Strong-Pass-9', '10.20.1.7');
      expect((await app.inject({ method: 'POST', url: '/api/v1/products', headers: member.headers, payload: { name: 'Allowed Now', category: 'Tops', price: 10, sku: `AN-${Date.now()}` } })).statusCode).toBe(201);

      const owner = db.getUserById('user_aura_owner')!;
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/brand/team/members/${owner.id}`, headers: aura.headers, payload: { role: 'SUPPORT_AGENT' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/team/members/${owner.id}`, headers: aura.headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/brand/team/members/${memberId}`, headers: aura.headers, payload: { role: 'BRAND_OWNER' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/brand/team/members/${memberId}`, headers: vogue.headers, payload: { role: 'SUPPORT_AGENT' } })).statusCode).toBe(404);
    });

    it('removes a member, ending their access straight away', async () => {
      const member = await login('orders.person@example.com', 'Strong-Pass-9', '10.20.1.8');
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/team/members/${memberId}`, headers: vogue.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/team/members/${memberId}`, headers: aura.headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: member.headers })).statusCode).toBe(401);
      const relogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.20.1.9', payload: { email: 'orders.person@example.com', password: 'Strong-Pass-9' } });
      expect(relogin.statusCode).toBe(401);
    });

    it('revokes pending invitations', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/brand/team/invites', headers: aura.headers, payload: { email: 'revoked.person@example.com', role: 'SUPPORT_AGENT' } });
      const invite = json(res).invite;
      const tok = decodeURIComponent(json(res).inviteUrl.split('token=')[1]);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/team/invites/${invite.id}`, headers: aura.headers })).statusCode).toBe(200);
      const accept = await app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', remoteAddress: '10.20.1.10', payload: { token: tok, name: 'Rev Oked', password: 'Strong-Pass-9' } });
      expect(accept.statusCode).toBe(400);
    });
  });
});
