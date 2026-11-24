import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  StoreSettingsInputSchema,
  mergeStoreSettings,
  resolveStoreSettings,
} from '../../modules/commerce/store_settings.js';
import { requireTenantContext } from './profile.service.js';

const readGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const writeGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

export async function brandStoreSettingsRoutes(app: FastifyInstance) {
  // Read the store settings (open/closed, delivery charges, search and sharing text)
  app.get('/api/v1/brand/store-settings', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { settings: resolveStoreSettings(tenant) };
  });

  // Save them. Only the brand's owner or an admin can change them.
  app.put('/api/v1/brand/store-settings', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(StoreSettingsInputSchema, request.body ?? {});
    const merged = mergeStoreSettings(resolveStoreSettings(tenant), input);
    const updated = db.updateTenant(tenant.id, {
      storefrontSettings: { ...(tenant.storefrontSettings || {}), store: merged },
    });
    if (!updated) throw new NotFoundException('Brand tenant not found.');
    await recordAudit({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      tenantId: tenant.id,
      action: 'BRAND_STORE_SETTINGS_UPDATED',
      entity: 'StoreSettings',
      entityId: tenant.id,
      correlationId: request.correlationId,
      details: {
        open: merged.open,
        defaultFee: merged.shipping.defaultFee,
        freeOver: merged.shipping.freeOver,
        audience: merged.audience,
        returnWindowDays: merged.returns.windowDays,
      },
    });
    return { message: 'Store settings saved.', settings: resolveStoreSettings(updated) };
  });
}
