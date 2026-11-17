import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import { API_SCOPES, type ApiKeyRecord, type ApiScope, type Tenant } from '../../domain/types.js';

export const MAX_ACTIVE_KEYS = 10;
const KEY_PREFIX = 'vtry_live_';
const hashSecret = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

export const ApiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(3, 'Give the key a name of at least 3 characters.').max(60),
    scopes: z.array(z.enum(API_SCOPES as [ApiScope, ...ApiScope[]])).min(1, 'Choose at least one permission.').max(API_SCOPES.length),
    expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .strict();

function save(tenant: Tenant, apiKeys: ApiKeyRecord[]) {
  return db.updateTenant(tenant.id, { storefrontSettings: { ...(tenant.storefrontSettings || {}), apiKeys } });
}

export function publicKeyView(k: ApiKeyRecord) {
  const { hash: _hash, ...rest } = k;
  const expired = k.status === 'ACTIVE' && k.expiresAt !== null && Date.now() > k.expiresAt;
  return { ...rest, status: expired ? 'EXPIRED' : k.status, display: `${KEY_PREFIX}\u2022\u2022\u2022\u2022${k.last4}` };
}

export function listApiKeys(tenant: Tenant) {
  return [...(tenant.storefrontSettings?.apiKeys || [])].sort((a, b) => b.createdAt - a.createdAt).map(publicKeyView);
}

export function createApiKey(tenant: Tenant, input: z.infer<typeof ApiKeyCreateSchema>, createdBy: string):
  | { ok: true; key: string; record: ApiKeyRecord }
  | { ok: false; status: number; error: string; message: string } {
  const existing = tenant.storefrontSettings?.apiKeys || [];
  if (existing.filter((k) => k.status === 'ACTIVE').length >= MAX_ACTIVE_KEYS) {
    return { ok: false, status: 400, error: 'LimitReached', message: `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use.` };
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `${KEY_PREFIX}${Buffer.from(tenant.id).toString('base64url')}.${secret}`;
  const now = Date.now();
  const record: ApiKeyRecord = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    name: input.name,
    last4: secret.slice(-4),
    hash: hashSecret(secret),
    scopes: Array.from(new Set(input.scopes)),
    createdAt: now,
    createdBy,
    expiresAt: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null,
    lastUsedAt: null,
    status: 'ACTIVE',
  };
  save(tenant, [...existing, record]);
  return { ok: true, key, record };
}

export function revokeApiKey(tenant: Tenant, id: string): boolean {
  const existing = tenant.storefrontSettings?.apiKeys || [];
  if (!existing.some((k) => k.id === id && k.status === 'ACTIVE')) return false;
  save(tenant, existing.map((k) => (k.id === id ? { ...k, status: 'REVOKED' as const, revokedAt: Date.now() } : k)));
  return true;
}

export type KeyCheck =
  | { ok: true; tenant: Tenant; key: ApiKeyRecord }
  | { ok: false; reason: 'MISSING' | 'INVALID' | 'REVOKED' | 'EXPIRED' | 'TENANT_INACTIVE' };

/** Resolves a raw key to its brand without scanning other brands, comparing hashes in constant time. */
export function verifyApiKey(raw: unknown): KeyCheck {
  if (typeof raw !== 'string' || !raw.startsWith(KEY_PREFIX) || raw.length > 200) return { ok: false, reason: raw ? 'INVALID' : 'MISSING' };
  const body = raw.slice(KEY_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 1) return { ok: false, reason: 'INVALID' };
  let tenantId = '';
  try {
    tenantId = Buffer.from(body.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'INVALID' };
  }
  const tenant = db.getTenantById(tenantId);
  const given = Buffer.from(hashSecret(body.slice(dot + 1)), 'hex');
  const key = (tenant?.storefrontSettings?.apiKeys || []).find((k) => {
    const stored = Buffer.from(k.hash, 'hex');
    return stored.length === given.length && crypto.timingSafeEqual(stored, given);
  });
  if (!tenant || !key) return { ok: false, reason: 'INVALID' };
  if (key.status !== 'ACTIVE') return { ok: false, reason: 'REVOKED' };
  if (key.expiresAt !== null && Date.now() > key.expiresAt) return { ok: false, reason: 'EXPIRED' };
  if (tenant.status !== 'ACTIVE') return { ok: false, reason: 'TENANT_INACTIVE' };
  return { ok: true, tenant, key };
}

/** Remembers when a key was last used, at most once a minute so reads do not become writes. */
export function touchApiKey(tenantId: string, keyId: string) {
  const tenant = db.getTenantById(tenantId);
  const keys = tenant?.storefrontSettings?.apiKeys;
  const current = keys?.find((k) => k.id === keyId);
  if (!tenant || !keys || !current) return;
  if (current.lastUsedAt && Date.now() - current.lastUsedAt < 60_000) return;
  save(tenant, keys.map((k) => (k.id === keyId ? { ...k, lastUsedAt: Date.now() } : k)));
}
