import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import { domainEvents } from '../../infrastructure/domain_events.js';
import { WEBHOOK_EVENTS, type Tenant, type WebhookEndpointRecord, type WebhookEventType } from '../../domain/types.js';
import { decryptSecret, encryptSecret } from './secrets.js';

export const MAX_ENDPOINTS = 5;
const MAX_CONSECUTIVE_FAILURES = 10;
const DELIVERY_TIMEOUT_MS = 5000;

const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === 'true';
const retryDelays = (): number[] =>
  (process.env.WEBHOOK_RETRY_DELAYS_MS || '30000,300000').split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0);

// ---------------------------------------------------------------- URL safety (SSRF)
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  return true;
}

/** Checks the address as typed. The destination is checked again, after DNS, every time we send. */
export function checkWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'Enter a full address such as https://example.com/hooks.' };
  }
  if (url.username || url.password) return { ok: false, message: 'Remove the username and password from the address.' };
  if (allowPrivate()) return { ok: true, url };
  if (url.protocol !== 'https:') return { ok: false, message: 'The address must start with https://' };
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, message: 'That address points inside a private network and cannot be used.' };
  }
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && isPrivateIp(host.replace(/^\[|\]$/g, ''))) {
    return { ok: false, message: 'That address points inside a private network and cannot be used.' };
  }
  return { ok: true, url };
}

async function assertPublicDestination(url: URL): Promise<void> {
  if (allowPrivate()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('Destination resolves to a private network address.');
  }
}

// ---------------------------------------------------------------- management
export const WebhookCreateSchema = z
  .object({
    url: z.string().trim().max(500),
    events: z.array(z.enum(WEBHOOK_EVENTS as [string, ...string[]])).min(1, 'Choose at least one event.'),
    description: z.string().trim().max(120).optional(),
  })
  .strict();
export const WebhookUpdateSchema = z
  .object({
    url: z.string().trim().max(500),
    events: z.array(z.enum(WEBHOOK_EVENTS as [string, ...string[]])).min(1),
    description: z.string().trim().max(120),
    active: z.boolean(),
  })
  .partial()
  .strict();

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

export function publicEndpointView(e: WebhookEndpointRecord) {
  const { secretEnc: _secret, ...rest } = e;
  return rest;
}

function saveEndpoints(tenantId: string, mutate: (list: WebhookEndpointRecord[]) => WebhookEndpointRecord[]) {
  // always start from the latest stored copy so concurrent changes are not overwritten
  const tenant = db.getTenantById(tenantId);
  if (!tenant) return;
  const next = mutate(tenant.storefrontSettings?.webhooks || []);
  db.updateTenant(tenantId, { storefrontSettings: { ...(tenant.storefrontSettings || {}), webhooks: next } });
}

export const listEndpoints = (tenant: Tenant) => (tenant.storefrontSettings?.webhooks || []).map(publicEndpointView);

export function createEndpoint(tenant: Tenant, input: z.infer<typeof WebhookCreateSchema>):
  | { ok: true; endpoint: WebhookEndpointRecord; secret: string }
  | { ok: false; status: number; error: string; message: string } {
  const existing = tenant.storefrontSettings?.webhooks || [];
  if (existing.length >= MAX_ENDPOINTS) {
    return { ok: false, status: 400, error: 'LimitReached', message: `You can have up to ${MAX_ENDPOINTS} webhook addresses.` };
  }
  const check = checkWebhookUrl(input.url);
  if (!check.ok) return { ok: false, status: 400, error: 'InvalidUrl', message: check.message };
  const secret = newSecret();
  const endpoint: WebhookEndpointRecord = {
    id: `whk_${crypto.randomBytes(6).toString('hex')}`,
    url: check.url.toString(),
    description: input.description || undefined,
    events: Array.from(new Set(input.events)) as WebhookEndpointRecord['events'],
    secretEnc: encryptSecret(secret),
    active: true,
    createdAt: Date.now(),
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    lastStatus: null,
  };
  saveEndpoints(tenant.id, (list) => [...list, endpoint]);
  return { ok: true, endpoint, secret };
}

export function updateEndpoint(tenant: Tenant, id: string, patch: z.infer<typeof WebhookUpdateSchema>):
  | { ok: true; endpoint: WebhookEndpointRecord }
  | { ok: false; status: number; error: string; message: string } {
  const current = (tenant.storefrontSettings?.webhooks || []).find((e) => e.id === id);
  if (!current) return { ok: false, status: 404, error: 'NotFound', message: 'Webhook address not found.' };
  let url = current.url;
  if (patch.url !== undefined) {
    const check = checkWebhookUrl(patch.url);
    if (!check.ok) return { ok: false, status: 400, error: 'InvalidUrl', message: check.message };
    url = check.url.toString();
  }
  const next: WebhookEndpointRecord = {
    ...current,
    url,
    ...(patch.events ? { events: Array.from(new Set(patch.events)) as WebhookEndpointRecord['events'] } : {}),
    ...(patch.description !== undefined ? { description: patch.description || undefined } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  if (patch.active === true) {
    next.consecutiveFailures = 0;
    next.disabledReason = undefined;
  }
  saveEndpoints(tenant.id, (list) => list.map((e) => (e.id === id ? next : e)));
  return { ok: true, endpoint: next };
}

export function deleteEndpoint(tenant: Tenant, id: string): boolean {
  if (!(tenant.storefrontSettings?.webhooks || []).some((e) => e.id === id)) return false;
  saveEndpoints(tenant.id, (list) => list.filter((e) => e.id !== id));
  deliveryLog.delete(id);
  return true;
}

export function rotateSecret(tenant: Tenant, id: string): { secret: string } | null {
  if (!(tenant.storefrontSettings?.webhooks || []).some((e) => e.id === id)) return null;
  const secret = newSecret();
  saveEndpoints(tenant.id, (list) => list.map((e) => (e.id === id ? { ...e, secretEnc: encryptSecret(secret) } : e)));
  return { secret };
}

// ---------------------------------------------------------------- delivery
export interface DeliveryAttempt {
  id: string;
  endpointId: string;
  eventId: string;
  type: WebhookEventType;
  attempt: number;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error?: string;
  at: number;
}
const deliveryLog = new Map<string, DeliveryAttempt[]>();
export const recentDeliveries = (endpointId: string) => deliveryLog.get(endpointId) || [];

function logAttempt(a: DeliveryAttempt) {
  const list = deliveryLog.get(a.endpointId) || [];
  deliveryLog.set(a.endpointId, [a, ...list].slice(0, 50));
}

/** The signature a receiver recomputes: HMAC-SHA256 over "<timestamp>.<raw body>" with the endpoint secret. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function sendOnce(endpoint: WebhookEndpointRecord, eventId: string, type: WebhookEventType, body: string, attempt: number): Promise<DeliveryAttempt> {
  const started = Date.now();
  const base: DeliveryAttempt = { id: `dlv_${crypto.randomBytes(5).toString('hex')}`, endpointId: endpoint.id, eventId, type, attempt, ok: false, httpStatus: null, durationMs: 0, at: started };
  try {
    const url = new URL(endpoint.url);
    await assertPublicDestination(url);
    const timestamp = Math.floor(started / 1000);
    const secret = decryptSecret(endpoint.secretEnc);
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual', // never follow a redirect into somewhere we did not check
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VTRY-Webhooks/1.0',
        'X-VTRY-Event': type,
        'X-VTRY-Delivery': base.id,
        'X-VTRY-Signature': `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`,
      },
      body,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ...base, ok, httpStatus: res.status, durationMs: Date.now() - started, error: ok ? undefined : `Your server answered ${res.status}` };
  } catch (err: any) {
    const message = err?.name === 'TimeoutError' ? 'Timed out after 5 seconds' : String(err?.message || 'Could not connect');
    return { ...base, durationMs: Date.now() - started, error: message.slice(0, 200) };
  }
}

function recordOutcome(tenantId: string, endpointId: string, success: boolean) {
  saveEndpoints(tenantId, (list) =>
    list.map((e) => {
      if (e.id !== endpointId) return e;
      const failures = success ? 0 : e.consecutiveFailures + 1;
      const disable = !success && failures >= MAX_CONSECUTIVE_FAILURES;
      return {
        ...e,
        consecutiveFailures: failures,
        lastDeliveryAt: Date.now(),
        lastStatus: success ? 'SUCCESS' : 'FAILED',
        active: disable ? false : e.active,
        disabledReason: disable ? `Switched off after ${MAX_CONSECUTIVE_FAILURES} failed deliveries in a row.` : e.disabledReason,
      };
    }),
  );
}

async function deliverWithRetries(tenantId: string, endpointId: string, eventId: string, type: WebhookEventType, body: string) {
  const delays = [0, ...retryDelays()];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise<void>((r) => setTimeout(r, delays[i]).unref?.());
    const endpoint = (db.getTenantById(tenantId)?.storefrontSettings?.webhooks || []).find((e) => e.id === endpointId);
    if (!endpoint || !endpoint.active) return; // removed or switched off while waiting
    const result = await sendOnce(endpoint, eventId, type, body, i + 1);
    logAttempt(result);
    if (result.ok) return recordOutcome(tenantId, endpointId, true);
  }
  recordOutcome(tenantId, endpointId, false);
}

/** Sends one event to every active address that listens to it. Never throws and never blocks the caller. */
export function dispatchEvent(tenantId: string, type: Exclude<WebhookEventType, 'ping'>, data: unknown): void {
  const endpoints = (db.getTenantById(tenantId)?.storefrontSettings?.webhooks || []).filter((e) => e.active && e.events.includes(type));
  if (endpoints.length === 0) return;
  const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const body = JSON.stringify({ id: eventId, type, createdAt: new Date().toISOString(), data });
  for (const e of endpoints) {
    void deliverWithRetries(tenantId, e.id, eventId, type, body).catch(() => undefined);
  }
}

/** Test button: one real signed delivery, answered immediately. */
export async function sendTestEvent(tenant: Tenant, id: string): Promise<DeliveryAttempt | null> {
  const endpoint = (tenant.storefrontSettings?.webhooks || []).find((e) => e.id === id);
  if (!endpoint) return null;
  const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const body = JSON.stringify({ id: eventId, type: 'ping', createdAt: new Date().toISOString(), data: { message: 'Test event from V-TRY Studio' } });
  const result = await sendOnce(endpoint, eventId, 'ping', body, 1);
  logAttempt(result);
  recordOutcome(tenant.id, id, result.ok);
  return result;
}

// ---------------------------------------------------------------- wire the events
const orderView = (o: any) => ({
  id: o.id,
  status: o.status,
  paymentStatus: o.paymentStatus,
  customerEmail: o.customerEmail,
  shippingAddress: o.shippingAddress,
  items: o.items,
  subtotal: o.subtotal,
  shippingFee: o.shippingFee,
  discountAmount: o.discountAmount ?? 0,
  couponCode: o.couponCode ?? null,
  totalAmount: o.totalAmount,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

let wired = false;
export function wireWebhookEvents() {
  if (wired) return;
  wired = true;
  domainEvents.on('order.created', (order) => dispatchEvent(order.tenantId, 'order.created', orderView(order)));
  domainEvents.on('order.status_changed', ({ order, previousStatus }) =>
    dispatchEvent(order.tenantId, 'order.status_changed', { ...orderView(order), previousStatus }),
  );
  domainEvents.on('inventory.low_stock', (p) =>
    dispatchEvent(p.tenantId, 'inventory.low_stock', { productId: p.productId, productName: p.productName, variantSku: p.variantSku, stock: p.stock }),
  );
}
