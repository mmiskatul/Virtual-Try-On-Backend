import { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../infrastructure/logger.js';

export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  scope: 'PLATFORM' | 'TENANT' | 'CUSTOMER';
  isSystem: boolean;
  mfaRequired: boolean;
  permissions: string[];
}

export const PERMISSION_DEFINITIONS: Array<{ module: string; action: string; description: string }> = [
  { module: '*', action: '*', description: 'Full unrestricted platform access' },
  { module: 'tenants', action: 'read', description: 'View tenant/brand records and quotas' },
  { module: 'tenants', action: 'write', description: 'Create or update tenant/brand details' },
  { module: 'tenants', action: 'suspend', description: 'Suspend, reinstate, or approve tenants' },
  { module: 'tenants', action: 'view_as', description: 'Start audited View-As tenant inspection sessions' },
  { module: 'users', action: 'read', description: 'View platform customer and merchant user accounts' },
  { module: 'users', action: 'write', description: 'Update user status or reset credentials' },
  { module: 'users', action: 'suspend', description: 'Suspend users and revoke active sessions' },
  { module: 'staff', action: 'manage', description: 'Manage platform admin staff and RBAC assignments' },
  { module: 'plans', action: 'read', description: 'View subscription plans and entitlements' },
  { module: 'plans', action: 'write', description: 'Create or edit subscription plans and limits' },
  { module: 'billing', action: 'read', description: 'View invoices, payments, and ledgers' },
  { module: 'billing', action: 'write', description: 'Modify subscriptions and manual credit adjustments' },
  { module: 'billing', action: 'refund', description: 'Issue refunds on transactions' },
  { module: 'ai', action: 'read', description: 'Monitor AI providers, models, queues, and costs' },
  { module: 'ai', action: 'manage', description: 'Configure AI routing, model weights, and concurrency' },
  { module: 'moderation', action: 'read', description: 'Review flagged products and moderation queues' },
  { module: 'moderation', action: 'action', description: 'Approve, reject, or hide marketplace listings' },
  { module: 'cms', action: 'manage', description: 'Publish banners, CMS blocks, and promotions' },
  { module: 'support', action: 'read', description: 'Read support tickets and customer messages' },
  { module: 'support', action: 'manage', description: 'Reply to and resolve support tickets' },
  { module: 'audit', action: 'read', description: 'Inspect immutable platform audit trails' },
  { module: 'security', action: 'manage', description: 'Configure security settings, webhooks, and governance' },
  // Brand Tenant-scoped permissions
  { module: 'brand:products', action: 'read', description: 'View brand products and collections' },
  { module: 'brand:products', action: 'write', description: 'Create, edit, and publish brand products' },
  { module: 'brand:orders', action: 'read', description: 'View brand orders and customer shipments' },
  { module: 'brand:orders', action: 'write', description: 'Update fulfillment and order statuses' },
  { module: 'brand:analytics', action: 'read', description: 'View brand revenue and try-on conversion analytics' },
  { module: 'brand:staff', action: 'manage', description: 'Invite and assign brand team members' },
  { module: 'brand:billing', action: 'manage', description: 'Manage brand subscription and try-on credits' },
  { module: 'brand:tryon', action: 'use', description: 'Configure and run dedicated brand virtual try-on' },
];

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  // 10 Platform Admin Roles
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Full platform root administrator across all tenants, AI, billing, and security controls.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: true,
    permissions: ['*:*'],
  },
  {
    code: 'PLATFORM_OPERATIONS_ADMIN',
    name: 'Platform Operations Admin',
    description: 'Manages brand onboarding, lifecycle, support escalations, and operational health.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: true,
    permissions: ['tenants:read', 'tenants:write', 'tenants:suspend', 'tenants:view_as', 'users:read', 'users:write', 'support:read', 'support:manage', 'audit:read', 'ai:read'],
  },
  {
    code: 'FINANCE_BILLING_ADMIN',
    name: 'Finance & Billing Admin',
    description: 'Controls subscription plans, invoicing, refunds, payouts, and AI cost reconciliation.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: true,
    permissions: ['tenants:read', 'plans:read', 'plans:write', 'billing:read', 'billing:write', 'billing:refund', 'ai:read', 'audit:read'],
  },
  {
    code: 'AI_INFRASTRUCTURE_ADMIN',
    name: 'AI Infrastructure Admin',
    description: 'Manages AI providers, model versions, routing rules, GPU queues, and retries.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: true,
    permissions: ['ai:read', 'ai:manage', 'tenants:read', 'audit:read'],
  },
  {
    code: 'TRUST_SAFETY_MODERATOR',
    name: 'Trust & Safety Moderator',
    description: 'Moderates uploaded garments, generated imagery, policy abuse, and user suspensions.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: false,
    permissions: ['moderation:read', 'moderation:action', 'users:read', 'users:suspend', 'tenants:read', 'audit:read'],
  },
  {
    code: 'MARKETPLACE_MANAGER',
    name: 'Marketplace Manager',
    description: 'Curates marketplace featured collections, CMS blocks, categories, and promotions.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: false,
    permissions: ['cms:manage', 'moderation:read', 'moderation:action', 'tenants:read'],
  },
  {
    code: 'CUSTOMER_SUPPORT_AGENT',
    name: 'Customer Support Agent',
    description: 'Responds to customer and brand support tickets and inspects read-only tenant context.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: false,
    permissions: ['support:read', 'support:manage', 'users:read', 'tenants:read', 'tenants:view_as', 'billing:read'],
  },
  {
    code: 'SECURITY_COMPLIANCE_OFFICER',
    name: 'Security & Compliance Officer',
    description: 'Audits access logs, session revocations, data governance requests, and security webhooks.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: true,
    permissions: ['audit:read', 'security:manage', 'users:read', 'users:suspend', 'staff:manage'],
  },
  {
    code: 'DATA_ANALYTICS_VIEWER',
    name: 'Data & Analytics Viewer',
    description: 'Read-only access to platform growth, revenue, and AI usage telemetry.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: false,
    permissions: ['tenants:read', 'billing:read', 'ai:read'],
  },
  {
    code: 'PLATFORM_READ_ONLY_AUDITOR',
    name: 'Platform Read-Only Auditor',
    description: 'Compliance auditor with non-mutating visibility across tenants, users, and audit logs.',
    scope: 'PLATFORM',
    isSystem: true,
    mfaRequired: false,
    permissions: ['tenants:read', 'users:read', 'plans:read', 'billing:read', 'ai:read', 'moderation:read', 'support:read', 'audit:read'],
  },

  // 7 Brand Tenant Roles + Legacy STORE_MANAGER alias
  {
    code: 'BRAND_OWNER',
    name: 'Brand Owner',
    description: 'Primary owner of a tenant brand with full storefront, staff, billing, and catalog control.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:products:read', 'brand:products:write', 'brand:orders:read', 'brand:orders:write', 'brand:analytics:read', 'brand:staff:manage', 'brand:billing:manage', 'brand:tryon:use'],
  },
  {
    code: 'BRAND_ADMIN',
    name: 'Brand Admin',
    description: 'Delegated brand administrator managing products, orders, staff, and try-on settings.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:products:read', 'brand:products:write', 'brand:orders:read', 'brand:orders:write', 'brand:analytics:read', 'brand:staff:manage', 'brand:tryon:use'],
  },
  {
    code: 'CATALOG_MANAGER',
    name: 'Catalog Manager',
    description: 'Creates products, manages variants, uploads garments, and publishes to marketplace.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:products:read', 'brand:products:write', 'brand:tryon:use'],
  },
  {
    code: 'INVENTORY_MANAGER',
    name: 'Inventory Manager',
    description: 'Maintains SKU stock levels and product availability.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:products:read', 'brand:products:write'],
  },
  {
    code: 'ORDER_MANAGER',
    name: 'Order Manager',
    description: 'Processes customer orders, fulfillment statuses, and shipments.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:orders:read', 'brand:orders:write', 'brand:products:read'],
  },
  {
    code: 'SUPPORT_AGENT',
    name: 'Brand Support Agent',
    description: 'Assists brand shoppers with order inquiries and sizing.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:orders:read', 'brand:products:read'],
  },
  {
    code: 'ANALYTICS_VIEWER',
    name: 'Brand Analytics Viewer',
    description: 'Read-only visibility into brand sales and try-on performance.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:analytics:read', 'brand:products:read', 'brand:orders:read'],
  },
  {
    code: 'STORE_MANAGER',
    name: 'Store Manager (Legacy Alias)',
    description: 'Backward-compatible store manager role covering catalog, inventory, and orders.',
    scope: 'TENANT',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:products:read', 'brand:products:write', 'brand:orders:read', 'brand:orders:write', 'brand:analytics:read', 'brand:tryon:use'],
  },
  {
    code: 'CUSTOMER',
    name: 'Marketplace Customer',
    description: 'Authenticated shopper allowed to browse, favorite, purchase, and run virtual try-on.',
    scope: 'CUSTOMER',
    isSystem: true,
    mfaRequired: false,
    permissions: ['brand:tryon:use'],
  },
];

const ROLE_PERMISSION_LOOKUP = new Map<string, Set<string>>(
  ROLE_DEFINITIONS.map((r) => [r.code, new Set(r.permissions)])
);

export const PLATFORM_ADMIN_ROLE_CODES = new Set(
  ROLE_DEFINITIONS.filter((r) => r.scope === 'PLATFORM').map((r) => r.code)
);

export const BRAND_MEMBER_ROLE_CODES = new Set(
  ROLE_DEFINITIONS.filter((r) => r.scope === 'TENANT').map((r) => r.code)
);

export function resolvePermissionsForRoles(roleCodes: string[]): Set<string> {
  const perms = new Set<string>();
  for (const code of roleCodes) {
    const defPerms = ROLE_PERMISSION_LOOKUP.get(code);
    if (defPerms) {
      for (const p of defPerms) perms.add(p);
    }
  }
  return perms;
}

export function hasPermission(roleCodes: string[], permissionKey: string, extraPermissions?: Set<string>): boolean {
  const perms = extraPermissions ?? resolvePermissionsForRoles(roleCodes);
  if (perms.has('*:*') || perms.has(permissionKey)) return true;
  const [mod] = permissionKey.split(':');
  if (mod && perms.has(`${mod}:*`)) return true;
  return false;
}

/**
 * Idempotently seeds all default RBAC roles, permissions, and mappings into PostgreSQL.
 */
export async function seedDefaultRbac(prisma: any): Promise<{ rolesSeeded: number; permissionsSeeded: number }> {
  if (!prisma) return { rolesSeeded: 0, permissionsSeeded: 0 };

  let permissionsSeeded = 0;
  let rolesSeeded = 0;
  const permIdMap = new Map<string, string>();

  try {
    for (const p of PERMISSION_DEFINITIONS) {
      const row = await prisma.permission.upsert({
        where: { module_action: { module: p.module, action: p.action } },
        update: { description: p.description },
        create: { module: p.module, action: p.action, description: p.description },
      });
      permIdMap.set(`${p.module}:${p.action}`, row.id);
      permissionsSeeded++;
    }

    for (const r of ROLE_DEFINITIONS) {
      const roleRow = await prisma.role.upsert({
        where: { code: r.code },
        update: { name: r.name, description: r.description, isSystem: r.isSystem, mfaRequired: r.mfaRequired },
        create: {
          code: r.code,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          mfaRequired: r.mfaRequired,
        },
      });
      rolesSeeded++;

      for (const permKey of r.permissions) {
        const permId = permIdMap.get(permKey);
        if (!permId) continue;
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: roleRow.id, permissionId: permId } },
          update: {},
          create: { roleId: roleRow.id, permissionId: permId },
        });
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'rbac.seed.warning');
  }

  return { rolesSeeded, permissionsSeeded };
}

export function requirePermission(moduleName: string, action: string) {
  const required = `${moduleName}:${action}`;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required.' });
    }
    const roles = request.roleCodes || [request.authUser.role];
    if (!hasPermission(roles, required, request.permissions)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Missing required permission '${required}'.`,
        requiredPermission: required,
      });
    }
  };
}

