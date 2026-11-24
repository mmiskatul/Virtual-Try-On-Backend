import './setup_env.js';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { decryptSecret } from '../src/modules/developer/secrets.js';
import { isPrivateIp, signPayload } from '../src/modules/developer/webhooks.js';
import { seedTestUsers } from './helpers.js';

const app = createApp('all');
const json = (res: { body: string }) => JSON.parse(res.body);
const ITEM = { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 };
const ADDRESS = { fullName: 'Hook Tester', street: '1 Test Road', city: 'Dhaka', zipCode: '1213', country: 'BD' };

type Session = { headers: { Authorization: string } };
async function login(email: string, password: string, ip: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password } });
  expect(res.statusCode, `login ${email}`).toBe(200);
  return { headers: { Authorization: `Bearer ${json(res).token}` } };
}
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

// ---- a local server that records every webhook it receives
interface Received { headers: http.IncomingHttpHeaders; body: string }
function startReceiver(respond: (n: number) => { status: number; headers?: Record<string, string> } = () => ({ status: 200 })) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      const r = respond(received.length);
      res.writeHead(r.status, r.headers);
      res.end('ok');
    });
  });
  return new Promise<{ url: string; received: Received[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/hook`, received, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('Phase 12: API keys and webhooks', () => {
  let aura: Session;
  let vogue: Session;
  let shopper: Session;
  let manager: Session;
  const receivers: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    seedTestUsers();
    const now = Date.now();
    db.createUser({ id: 'user_vogue_owner_12', tenantId: 'tenant_vogue', name: 'Marcus', email: 'marcus12@voguenova.com', passwordHash: db.hashPassword('Test-Brand-Pass-2'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now });
    db.createUser({ id: 'user_aura_orders_12', tenantId: 'tenant_aura', name: 'Olga Orders', email: 'olga12@auraatelier.com', passwordHash: db.hashPassword('Test-Brand-Pass-3'), role: 'ORDER_MANAGER', emailVerified: true, emailVerifiedAt: now, createdAt: now });
    aura = await login('elena@auraatelier.com', 'Test-Brand-Pass-1', '10.30.0.1');
    vogue = await login('marcus12@voguenova.com', 'Test-Brand-Pass-2', '10.30.0.2');
    manager = await login('olga12@auraatelier.com', 'Test-Brand-Pass-3', '10.30.0.4');
    const c = await app.inject({ method: 'POST', url: '/api/v1/marketplace/auth/login', remoteAddress: '10.30.0.3', payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' } });
    shopper = { headers: { Authorization: `Bearer ${json(c).token}` } };
  });

  afterAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
    await Promise.all(receivers.map((r) => r.close()));
  });

  const createKey = async (session: Session, payload: any) => app.inject({ method: 'POST', url: '/api/v1/brand/api-keys', headers: session.headers, payload });
  const call = (method: any, url: string, key?: string, payload?: any) =>
    app.inject({ method, url, headers: key ? { 'x-api-key': key } : {}, payload, remoteAddress: '10.30.5.1' });

  describe('API keys', () => {
    let readKey = '';
    let readKeyId = '';

    it('only owners and admins can manage keys, and input is validated', async () => {
      expect((await createKey(manager, { name: 'Sneaky', scopes: ['orders:read'] })).statusCode).toBe(403);
      expect([401, 403]).toContain((await createKey(shopper, { name: 'Shopper key', scopes: ['orders:read'] })).statusCode);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/api-keys' })).statusCode).toBe(401);
      for (const bad of [{ name: 'x', scopes: ['orders:read'] }, { name: 'No scopes', scopes: [] }, { name: 'Bad scope', scopes: ['admin:everything'] }, { name: 'Extra', scopes: ['orders:read'], role: 'owner' }]) {
        expect((await createKey(aura, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it('shows the key exactly once and never stores it', async () => {
      const res = await createKey(aura, { name: 'Read-only reporting', scopes: ['products:read', 'orders:read'] });
      expect(res.statusCode).toBe(201);
      readKey = json(res).key;
      readKeyId = json(res).record.id;
      expect(readKey).toMatch(/^vtry_live_/);
      expect(res.headers['cache-control']).toBe('no-store');

      const secret = readKey.split('.')[1];
      expect(JSON.stringify(db.getTenantById('tenant_aura')!.storefrontSettings)).not.toContain(secret);

      const list = json(await app.inject({ method: 'GET', url: '/api/v1/brand/api-keys', headers: aura.headers }));
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(list.keys[0]).not.toHaveProperty('hash');
      expect(list.keys.find((k: any) => k.id === readKeyId).display).toMatch(/••••/);
      expect(json(await app.inject({ method: 'GET', url: '/api/v1/brand/api-keys', headers: vogue.headers })).keys).toHaveLength(0);
    });

    it('authenticates the public API and keeps every key inside its own brand', async () => {
      const mine = await call('GET', '/api/v1/public/products', readKey);
      expect(mine.statusCode).toBe(200);
      const ids = json(mine).products.map((p: any) => p.id);
      expect(ids).toContain('prod_aura_dress_01');
      expect(ids).not.toContain('prod_vogue_jacket_01');
      expect((await call('GET', '/api/v1/public/products/prod_vogue_jacket_01', readKey)).statusCode).toBe(404);
      expect(json(await call('GET', '/api/v1/public/me', readKey)).brand.slug).toBe('aura-atelier');

      for (const bad of [undefined, 'garbage', `${readKey}x`, readKey.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'vtry_live_abc.def']) {
        expect((await call('GET', '/api/v1/public/products', bad)).statusCode, String(bad)).toBe(401);
      }
    });

    it('enforces permissions per key', async () => {
      expect((await call('PATCH', '/api/v1/public/orders/any/status', readKey, { status: 'SHIPPED' })).statusCode).toBe(403);
      expect((await call('POST', '/api/v1/public/inventory/adjust', readKey, { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', change: 1 })).statusCode).toBe(403);

      const writeKey = json(await createKey(aura, { name: 'Fulfilment bot', scopes: ['orders:read', 'orders:write', 'products:write'] })).key;
      const placed = await app.inject({ method: 'POST', url: '/api/v1/checkout', remoteAddress: '10.30.5.9', payload: { items: [ITEM], customerEmail: 'apikey.buyer@example.com', shippingAddress: ADDRESS } });
      const orderId = json(placed).orderId;
      expect((await call('GET', `/api/v1/public/orders/${orderId}`, writeKey)).statusCode).toBe(200);
      const ship = await call('PATCH', `/api/v1/public/orders/${orderId}/status`, writeKey, { status: 'SHIPPED' });
      expect(ship.statusCode).toBe(200);
      expect(db.getOrderById(orderId)!.status).toBe('SHIPPED');
      expect((await call('PATCH', `/api/v1/public/orders/${orderId}/status`, writeKey, { status: 'TELEPORTED' })).statusCode).toBe(400);
      expect((await call('POST', '/api/v1/public/inventory/adjust', writeKey, { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', change: 2, reason: 'recount' })).statusCode).toBe(200);
      // another brand's order is invisible even with a valid key
      expect((await call('GET', '/api/v1/public/orders/anything-from-another-brand', writeKey)).statusCode).toBe(404);
    });

    it('cannot be used anywhere else', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: { 'x-api-key': readKey } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/v1/brand/orders', headers: { Authorization: `Bearer ${readKey}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/brand/api-keys', headers: { 'x-api-key': readKey }, payload: { name: 'Self made', scopes: ['orders:write'] } })).statusCode).toBe(401);
    });

    it('stops working when revoked or expired, and limits how many are active', async () => {
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/api-keys/${readKeyId}`, headers: vogue.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/brand/api-keys/${readKeyId}`, headers: aura.headers })).statusCode).toBe(200);
      const revoked = await call('GET', '/api/v1/public/products', readKey);
      expect(revoked.statusCode).toBe(401);
      expect(json(revoked).code).toBe('API_KEY_REVOKED');

      const temp = json(await createKey(aura, { name: 'Short lived', scopes: ['products:read'], expiresInDays: 1 }));
      expect((await call('GET', '/api/v1/public/products', temp.key)).statusCode).toBe(200);
      const t = db.getTenantById('tenant_aura')!;
      db.updateTenant('tenant_aura', { storefrontSettings: { ...t.storefrontSettings, apiKeys: t.storefrontSettings!.apiKeys!.map((k) => (k.id === temp.record.id ? { ...k, expiresAt: Date.now() - 1000 } : k)) } });
      const expired = await call('GET', '/api/v1/public/products', temp.key);
      expect(json(expired).code).toBe('API_KEY_EXPIRED');

      let created = 0;
      for (let i = 0; i < 12; i++) {
        const r = await createKey(aura, { name: `Bulk key ${i}`, scopes: ['products:read'] });
        if (r.statusCode === 201) created++;
      }
      expect(created).toBeLessThanOrEqual(10);
      expect((await createKey(aura, { name: 'One too many', scopes: ['products:read'] })).statusCode).toBe(400);
    });

    it('rate limits public API calls per client address, not per key', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      try {
        const key = json(await createKey(vogue, { name: 'Busy integration', scopes: ['products:read'] })).key;
        const codes: number[] = [];
        for (let i = 0; i < 305; i++) codes.push((await call('GET', '/api/v1/public/me', key)).statusCode);
        expect(codes.slice(0, 300).every((c) => c === 200)).toBe(true);
        expect(codes.slice(300)).toContain(429);
        // Rotating to a made-up key must not give a fresh allowance.
        expect((await call('GET', '/api/v1/public/me', 'vtry_fake_rotated_key')).statusCode).toBe(429);
      } finally {
        process.env.RATE_LIMIT_DISABLED = 'true';
      }
    });
  });

  describe('webhooks', () => {
    const create = (session: Session, payload: any) => app.inject({ method: 'POST', url: '/api/v1/brand/webhooks', headers: session.headers, payload });

    it('rejects unsafe addresses before anything is stored', async () => {
      process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
      try {
        for (const url of ['http://example.com/hook', 'https://localhost/hook', 'https://10.0.0.5/hook', 'https://169.254.169.254/latest/meta-data', 'https://192.168.1.10/x', 'https://user:pass@example.com/hook', 'ftp://example.com', 'not a url', 'https://printer.local/x']) {
          expect((await create(aura, { url, events: ['order.created'] })).statusCode, url).toBe(400);
        }
        expect((await create(aura, { url: 'https://example.com/hook', events: [] })).statusCode).toBe(400);
        expect((await create(aura, { url: 'https://example.com/hook', events: ['order.exploded'] })).statusCode).toBe(400);
        const ok = await create(aura, { url: 'https://example.com/hook', events: ['order.created'] });
        expect(ok.statusCode).toBe(201);
        await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${json(ok).webhook.id}`, headers: aura.headers });
      } finally {
        process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
      }
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('172.20.1.1')).toBe(true);
      expect(isPrivateIp('::1')).toBe(true);
      expect(isPrivateIp('fd00::1')).toBe(true);
      expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
    });

    it('only owners and admins manage webhooks, and brands cannot see each other', async () => {
      expect((await create(manager, { url: 'http://127.0.0.1:9/h', events: ['order.created'] })).statusCode).toBe(403);
      expect([401, 403]).toContain((await create(shopper, { url: 'http://127.0.0.1:9/h', events: ['order.created'] })).statusCode);
      const mine = await create(aura, { url: 'http://127.0.0.1:9/h', events: ['order.created'], description: 'Isolation check' });
      const id = json(mine).webhook.id;
      expect(json(await app.inject({ method: 'GET', url: '/api/v1/brand/webhooks', headers: vogue.headers })).webhooks).toHaveLength(0);
      for (const [method, url] of [['PATCH', `/api/v1/brand/webhooks/${id}`], ['DELETE', `/api/v1/brand/webhooks/${id}`], ['POST', `/api/v1/brand/webhooks/${id}/test`], ['GET', `/api/v1/brand/webhooks/${id}/deliveries`], ['POST', `/api/v1/brand/webhooks/${id}/rotate-secret`]] as const) {
        const res = await app.inject({ method, url, headers: vogue.headers, payload: method === 'PATCH' ? { active: false } : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${id}`, headers: aura.headers });
    });

    it('keeps the signing secret hidden after creation and encrypted at rest', async () => {
      const res = await create(aura, { url: 'http://127.0.0.1:9/h', events: ['order.created'] });
      const { webhook, secret } = json(res);
      expect(secret).toMatch(/^whsec_/);
      expect(webhook).not.toHaveProperty('secretEnc');
      const list = await app.inject({ method: 'GET', url: '/api/v1/brand/webhooks', headers: aura.headers });
      expect(list.body).not.toContain(secret);
      expect(list.body).not.toContain('secretEnc');
      const stored = db.getTenantById('tenant_aura')!.storefrontSettings!.webhooks!.find((w) => w.id === webhook.id)!;
      expect(stored.secretEnc).not.toContain(secret);
      expect(decryptSecret(stored.secretEnc)).toBe(secret);
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${webhook.id}`, headers: aura.headers });
    });

    it('delivers signed order and stock events that the receiver can verify', async () => {
      const rx = await startReceiver();
      receivers.push(rx);
      const created = json(await create(aura, { url: rx.url, events: ['order.created', 'order.status_changed', 'inventory.low_stock'] }));
      const secret: string = created.secret;
      const bodyOf = (type: string) => rx.received.map((r) => ({ r, b: JSON.parse(r.body) })).find((x) => x.b.type === type);

      const placed = await app.inject({ method: 'POST', url: '/api/v1/checkout', remoteAddress: '10.30.6.1', payload: { items: [ITEM], customerEmail: 'hook.buyer@example.com', shippingAddress: ADDRESS } });
      const orderId = json(placed).orderId;
      expect(await waitFor(() => Boolean(bodyOf('order.created')))).toBe(true);

      const evt = bodyOf('order.created')!;
      expect(evt.b.data.id).toBe(orderId);
      expect(evt.b.data.customerEmail).toBe('hook.buyer@example.com');
      expect(evt.r.headers['x-vtry-event']).toBe('order.created');
      // verify the signature exactly as a receiver would
      const m = String(evt.r.headers['x-vtry-signature']).match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
      expect(m).toBeTruthy();
      expect(signPayload(secret, Number(m[1]), evt.r.body)).toBe(m[2]);
      expect(signPayload('whsec_wrong', Number(m[1]), evt.r.body)).not.toBe(m[2]);
      expect(Math.abs(Date.now() / 1000 - Number(m[1]))).toBeLessThan(30);

      await app.inject({ method: 'PATCH', url: `/api/v1/brand/orders/${orderId}/status`, headers: aura.headers, payload: { status: 'SHIPPED' } });
      expect(await waitFor(() => Boolean(bodyOf('order.status_changed')))).toBe(true);
      expect(bodyOf('order.status_changed')!.b.data).toMatchObject({ id: orderId, status: 'SHIPPED', previousStatus: expect.any(String) });

      const stock = db.getProductById('prod_aura_dress_01')!.variants.find((v) => v.sku === 'AUR-DRS-001-S')!.stockQuantity;
      await app.inject({ method: 'POST', url: '/api/v1/inventory/adjust', headers: aura.headers, payload: { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', change: 5 - stock, reason: 'webhook test' } });
      expect(await waitFor(() => Boolean(bodyOf('inventory.low_stock')))).toBe(true);
      expect(bodyOf('inventory.low_stock')!.b.data).toMatchObject({ variantSku: 'AUR-DRS-001-S', stock: 5 });

      // another brand's order never reaches this address
      const before = rx.received.length;
      await app.inject({ method: 'POST', url: '/api/v1/checkout', remoteAddress: '10.30.6.2', payload: { items: [{ productId: 'prod_vogue_jacket_01', variantSku: 'VOG-BLZ-092-M', quantity: 1 }], customerEmail: 'vogue.buyer@example.com', shippingAddress: ADDRESS } });
      await new Promise((r) => setTimeout(r, 300));
      expect(rx.received.length).toBe(before);

      const log = json(await app.inject({ method: 'GET', url: `/api/v1/brand/webhooks/${created.webhook.id}/deliveries`, headers: aura.headers })).deliveries;
      expect(log.length).toBeGreaterThanOrEqual(3);
      expect(log.every((d: any) => d.ok)).toBe(true);
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${created.webhook.id}`, headers: aura.headers });
    });

    it('answers the test button with a real signed delivery', async () => {
      const rx = await startReceiver();
      receivers.push(rx);
      const created = json(await create(aura, { url: rx.url, events: ['order.created'] }));
      const res = json(await app.inject({ method: 'POST', url: `/api/v1/brand/webhooks/${created.webhook.id}/test`, headers: aura.headers }));
      expect(res.delivery.ok).toBe(true);
      expect(res.delivery.httpStatus).toBe(200);
      expect(rx.received[0].headers['x-vtry-event']).toBe('ping');
      const after = json(await app.inject({ method: 'GET', url: '/api/v1/brand/webhooks', headers: aura.headers })).webhooks.find((w: any) => w.id === created.webhook.id);
      expect(after.lastStatus).toBe('SUCCESS');
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${created.webhook.id}`, headers: aura.headers });
    });

    it('retries failed deliveries, and switches an address off after repeated failures', async () => {
      const flaky = await startReceiver((n) => ({ status: n < 3 ? 500 : 200 }));
      receivers.push(flaky);
      const a = json(await create(aura, { url: flaky.url, events: ['order.created'] }));
      await app.inject({ method: 'POST', url: '/api/v1/checkout', remoteAddress: '10.30.6.3', payload: { items: [ITEM], customerEmail: 'retry.buyer@example.com', shippingAddress: ADDRESS } });
      expect(await waitFor(() => flaky.received.length >= 3)).toBe(true);
      expect(await waitFor(() => json({ body: JSON.stringify({}) }) && db.getTenantById('tenant_aura')!.storefrontSettings!.webhooks!.find((w) => w.id === a.webhook.id)!.lastStatus === 'SUCCESS')).toBe(true);
      expect(new Set(flaky.received.map((r) => r.headers['x-vtry-delivery'])).size).toBe(3); // one id per attempt
      expect(new Set(flaky.received.map((r) => JSON.parse(r.body).id)).size).toBe(1); // same event every time
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${a.webhook.id}`, headers: aura.headers });

      const broken = await startReceiver(() => ({ status: 500 }));
      receivers.push(broken);
      const b = json(await create(aura, { url: broken.url, events: ['order.created'] }));
      for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: `/api/v1/brand/webhooks/${b.webhook.id}/test`, headers: aura.headers });
      const off = json(await app.inject({ method: 'GET', url: '/api/v1/brand/webhooks', headers: aura.headers })).webhooks.find((w: any) => w.id === b.webhook.id);
      expect(off.active).toBe(false);
      expect(off.disabledReason).toMatch(/10 failed/);
      const back = json(await app.inject({ method: 'PATCH', url: `/api/v1/brand/webhooks/${b.webhook.id}`, headers: aura.headers, payload: { active: true } })).webhook;
      expect(back.active).toBe(true);
      expect(back.consecutiveFailures).toBe(0);
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${b.webhook.id}`, headers: aura.headers });
    });

    it('never follows a redirect, and rotating the secret changes the signature', async () => {
      const redirecting = await startReceiver(() => ({ status: 302, headers: { Location: 'http://127.0.0.1:9/internal' } }));
      receivers.push(redirecting);
      const w = json(await create(aura, { url: redirecting.url, events: ['order.created'] }));
      const res = json(await app.inject({ method: 'POST', url: `/api/v1/brand/webhooks/${w.webhook.id}/test`, headers: aura.headers }));
      expect(res.delivery.ok).toBe(false);
      expect(res.delivery.httpStatus).toBe(302);
      expect(redirecting.received).toHaveLength(1);

      const rx = await startReceiver();
      receivers.push(rx);
      const r = json(await create(aura, { url: rx.url, events: ['order.created'] }));
      const rotated = json(await app.inject({ method: 'POST', url: `/api/v1/brand/webhooks/${r.webhook.id}/rotate-secret`, headers: aura.headers }));
      expect(rotated.secret).not.toBe(r.secret);
      await app.inject({ method: 'POST', url: `/api/v1/brand/webhooks/${r.webhook.id}/test`, headers: aura.headers });
      const m = String(rx.received[0].headers['x-vtry-signature']).match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
      expect(signPayload(rotated.secret, Number(m[1]), rx.received[0].body)).toBe(m[2]);
      expect(signPayload(r.secret, Number(m[1]), rx.received[0].body)).not.toBe(m[2]);
      for (const id of [w.webhook.id, r.webhook.id]) await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${id}`, headers: aura.headers });
    });

    it('limits how many addresses a brand can have', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await create(vogue, { url: `http://127.0.0.1:9/h${i}`, events: ['order.created'] });
        if (res.statusCode === 201) ids.push(json(res).webhook.id);
      }
      expect(ids).toHaveLength(5);
      for (const id of ids) await app.inject({ method: 'DELETE', url: `/api/v1/brand/webhooks/${id}`, headers: vogue.headers });
    });
  });
});
