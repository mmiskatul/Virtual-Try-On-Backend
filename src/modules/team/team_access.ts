import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { resolvePermissionsForRoles } from '../rbac/rbac.catalog.js';
import type { Tenant, TeamAccessRecord } from '../../domain/types.js';

/**
 * Extra access for one team member, on top of what their role already allows.
 *
 * A role (Order Manager, Catalog Manager, ...) always gives its fixed, default set of access. A brand owner can
 * also give one person a few extras, for example a Support Agent who may also see reports. Extras can only ADD
 * to a role, never take away from it, and the Brand Owner role itself is fixed.
 */

export interface GrantableAccess {
  key: string;
  label: string;
  help: string;
  /** Only the brand owner may give this one out. */
  ownerOnly?: boolean;
}

export const GRANTABLE_ACCESS: GrantableAccess[] = [
  { key: 'brand:products:read', label: 'See products and stock', help: 'View the catalog, stock levels and collections.' },
  { key: 'brand:products:write', label: 'Add and edit products', help: 'Create and change products, prices and stock.' },
  { key: 'brand:orders:read', label: 'See orders and customers', help: 'View orders, customers and delivery details.' },
  { key: 'brand:orders:write', label: 'Process orders', help: 'Pack, ship and cancel orders.' },
  { key: 'brand:analytics:read', label: 'See reports', help: 'View sales, product and try-on reports.' },
  { key: 'brand:tryon:use', label: 'Use virtual try-on', help: 'Set up and manage virtual try-on.' },
  { key: 'brand:billing:manage', label: 'Manage billing', help: 'See the plan and credits, and ask for plan changes.', ownerOnly: true },
  { key: 'brand:staff:manage', label: 'Manage the team', help: 'Add people and change their access.', ownerOnly: true },
];

const GRANTABLE_KEYS = new Set(GRANTABLE_ACCESS.map((g) => g.key));
const OWNER_ONLY_KEYS = new Set(GRANTABLE_ACCESS.filter((g) => g.ownerOnly).map((g) => g.key));
const MAX_PASSWORD_AGE_NOTE = 'A temporary password must be changed at first sign-in.';
export { MAX_PASSWORD_AGE_NOTE };

export const isGrantable = (key: string) => GRANTABLE_KEYS.has(key);

/** What is stored for a person, or an empty record. */
export function getTeamAccess(tenant: Tenant | undefined | null, userId: string): TeamAccessRecord {
  const raw = tenant?.storefrontSettings?.teamAccess?.[userId];
  return {
    extraPermissions: Array.isArray(raw?.extraPermissions) ? raw!.extraPermissions.filter(isGrantable) : [],
    mustChangePassword: Boolean(raw?.mustChangePassword),
    disabled: Boolean(raw?.disabled),
  };
}

/** Save changes to one person's record. Keeps everyone else's untouched. */
export function saveTeamAccess(tenant: Tenant, userId: string, patch: Partial<TeamAccessRecord>): Tenant | undefined {
  const current = getTeamAccess(tenant, userId);
  const next: TeamAccessRecord = {
    extraPermissions: patch.extraPermissions ?? current.extraPermissions,
    mustChangePassword: patch.mustChangePassword ?? current.mustChangePassword,
    disabled: patch.disabled ?? current.disabled,
  };
  const all = { ...(tenant.storefrontSettings?.teamAccess || {}) };
  all[userId] = next;
  return db.updateTenant(tenant.id, { storefrontSettings: { ...(tenant.storefrontSettings || {}), teamAccess: all } });
}

export function removeTeamAccess(tenant: Tenant, userId: string): void {
  const all = { ...(tenant.storefrontSettings?.teamAccess || {}) };
  if (!(userId in all)) return;
  delete all[userId];
  db.updateTenant(tenant.id, { storefrontSettings: { ...(tenant.storefrontSettings || {}), teamAccess: all } });
}

/** Everything a person can do: their role's fixed access plus their extras. */
export function effectivePermissions(role: string, extras: string[]): Set<string> {
  const set = resolvePermissionsForRoles([role]);
  for (const key of extras) if (isGrantable(key)) set.add(key);
  return set;
}

export interface ExtrasCheck {
  ok: boolean;
  extras: string[];
  message?: string;
}

/**
 * Check a list of extras someone wants to give, and keep only real extras:
 *  - every key must be a known one,
 *  - the person giving them must hold that access themselves,
 *  - billing and team access can only be given by the brand owner,
 *  - anything the role already includes is dropped, because it is not an "extra".
 */
export function checkExtras(input: unknown, opts: { role: string; granterPermissions: Set<string>; granterIsOwner: boolean }): ExtrasCheck {
  if (input === undefined) return { ok: true, extras: [] };
  if (!Array.isArray(input) || input.some((k) => typeof k !== 'string')) {
    return { ok: false, extras: [], message: 'Extra access must be a list.' };
  }
  const roleHas = resolvePermissionsForRoles([opts.role]);
  const extras: string[] = [];
  for (const key of Array.from(new Set(input as string[]))) {
    if (!isGrantable(key)) return { ok: false, extras: [], message: `"${key}" is not an access that can be given.` };
    if (OWNER_ONLY_KEYS.has(key) && !opts.granterIsOwner) {
      return { ok: false, extras: [], message: 'Only the brand owner can give billing or team access.' };
    }
    if (!opts.granterIsOwner && !opts.granterPermissions.has(key)) {
      return { ok: false, extras: [], message: 'You can only give access that you have yourself.' };
    }
    if (!roleHas.has(key)) extras.push(key);
  }
  return { ok: true, extras };
}

/** A readable temporary password that passes the password rules (letters and numbers, no look-alikes). */
export function generateTemporaryPassword(): string {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  const raw = (pick(letters, 6) + pick(digits, 3) + pick(letters, 3)).split('');
  for (let i = raw.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [raw[i], raw[j]] = [raw[j], raw[i]];
  }
  return raw.join('');
}
