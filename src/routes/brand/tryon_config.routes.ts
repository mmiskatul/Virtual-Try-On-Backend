import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  TryOnSettingsInputSchema,
  mergeTryOnSettings,
  resolveTryOnSettings,
} from '../../modules/tryon/tryon_settings.js';
import { requireTenantContext } from './profile.service.js';

const readGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const ownerGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

export async function brandTryOnConfigRoutes(app: FastifyInstance) {
  // Brand: read the saved try-on experience settings
  app.get('/api/v1/brand/try-on-config', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { config: resolveTryOnSettings(tenant) };
  });

  // Brand owner: save the try-on experience settings
  app.put('/api/v1/brand/try-on-config', { preHandler: ownerGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(TryOnSettingsInputSchema, request.body ?? {});
    const merged = mergeTryOnSettings(resolveTryOnSettings(tenant), input);
    const updated = db.updateTenant(tenant.id, {
      storefrontSettings: { ...(tenant.storefrontSettings || {}), tryOn: merged },
    });
    if (!updated) throw new NotFoundException('Brand tenant not found.');
    await recordAudit({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      tenantId: tenant.id,
      action: 'BRAND_TRYON_CONFIG_UPDATED',
      entity: 'TryOnSettings',
      entityId: tenant.id,
      correlationId: request.correlationId,
    });
    return { message: 'Try-on settings saved.', config: resolveTryOnSettings(updated) };
  });

  // Public: what the shopper-facing try-on page needs (nothing private lives in these settings)
  app.get('/api/v1/brands/:slug/try-on-config', async (request: FastifyRequest) => {
    const { slug } = request.params as { slug: string };
    const tenant = db.getTenantBySlug(String(slug || '').toLowerCase());
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException('Brand not found.');
    }
    return { config: resolveTryOnSettings(tenant) };
  });
}
