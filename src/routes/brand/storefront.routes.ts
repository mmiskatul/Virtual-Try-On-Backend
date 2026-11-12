import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import {
  createAdminMiddleware,
  createBrandMiddleware,
  requireRole,
} from '../../infrastructure/auth.guard.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  BrandAnalyticsResponseSchema,
  BrandProfileGetResponseSchema,
  BrandProfileMutationResponseSchema,
  BrandProfileUpdateInputSchema,
  BrandSlugParamsSchema,
  PublicStorefrontResponseSchema,
  StorefrontSettingsInputSchema,
  validateZodOutput,
} from './storefront.schemas.js';
import {
  applyBrandAggregateUpdate,
  normalizeTenantForOutput,
  requireTenantContext,
  sanitizeStorefrontSettings,
} from './profile.service.js';

const brandReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandAnalyticsGuards = createBrandMiddleware(requirePermission('brand:analytics', 'read'));
const brandOwnerGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));
const superAdminInternalGuards = createAdminMiddleware(requireRole('SUPER_ADMIN'));

export async function brandStorefrontRoutes(app: FastifyInstance) {
  // Brand Profile & Storefront Customization
  app.get('/api/v1/brand/profile', { preHandler: brandReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return validateZodOutput(
      BrandProfileGetResponseSchema,
      { tenant: normalizeTenantForOutput(tenant) },
      'GET /api/v1/brand/profile'
    );
  });

  app.put('/api/v1/brand/profile', { preHandler: brandOwnerGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const body = parseWithSchema(BrandProfileUpdateInputSchema, request.body ?? {});
    const updated = applyBrandAggregateUpdate(
      tenant,
      body,
      request.authUser ? { id: request.authUser.id, role: request.authUser.role } : undefined
    );
    return validateZodOutput(
      BrandProfileMutationResponseSchema,
      {
        message: 'Brand profile updated successfully',
        tenant: normalizeTenantForOutput(updated),
      },
      'PUT /api/v1/brand/profile'
    );
  });

  // Dedicated storefront settings update
  app.put('/api/v1/brand/storefront-settings', { preHandler: brandOwnerGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const parsedSettings = parseWithSchema(StorefrontSettingsInputSchema, request.body ?? {});
    const updated = db.updateTenant(tenant.id, {
      storefrontSettings: sanitizeStorefrontSettings(
        parsedSettings,
        tenant.storefrontSettings
      ),
    });
    if (!updated) {
      throw new NotFoundException('Brand tenant not found.');
    }
    return validateZodOutput(
      BrandProfileMutationResponseSchema,
      {
        message: 'Storefront settings updated successfully',
        tenant: normalizeTenantForOutput(updated),
      },
      'PUT /api/v1/brand/storefront-settings'
    );
  });

  // Brand Analytics
  app.get('/api/v1/brand/analytics', { preHandler: brandAnalyticsGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const tenantId = tenant.id;
    const products = db.getProductsByTenant(tenantId);
    const orders = db.getOrdersByTenant(tenantId);
    const subscription = db.getSubscription(tenantId);

    const totalRevenue = orders
      .filter(o => o.paymentStatus === 'PAID')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const lowStockVariants = products.flatMap(p =>
      p.variants.filter(v => v.stockQuantity < 5).map(v => ({
        productName: p.name,
        sku: v.sku,
        size: v.size,
        color: v.color,
        stock: v.stockQuantity
      }))
    );

    return validateZodOutput(
      BrandAnalyticsResponseSchema,
      {
        tenantId,
        totalProducts: products.length,
        storefrontPublishedCount: products.filter(p => p.brandStorefrontPublished).length,
        marketplacePublishedCount: products.filter(p => p.marketplacePublished).length,
        totalOrders: orders.length,
        totalRevenue,
        lowStockWarnings: lowStockVariants,
        tryOnUsage: {
          used: subscription?.tryOnUsed || 0,
          quota: subscription?.tryOnMonthlyQuota || 1000,
          plan: subscription?.plan || 'PRO'
        }
      },
      'GET /api/v1/brand/analytics'
    );
  });

  // Public Storefront Discovery (returns only public storefront fields, never private contactEmail)
  app.get('/api/v1/internal/storefront/:brandSlug', async (request: FastifyRequest) => {
    const { brandSlug } = parseWithSchema(BrandSlugParamsSchema, request.params);
    const tenant = db.getTenantBySlug(brandSlug);
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException('Storefront not found or inactive.');
    }
    const normalizedTenant = normalizeTenantForOutput(tenant);
    const products = db.getStorefrontProducts(tenant.id);
    return validateZodOutput(
      PublicStorefrontResponseSchema,
      {
        tenant: {
          id: normalizedTenant.id,
          name: normalizedTenant.name,
          slug: normalizedTenant.slug,
          status: normalizedTenant.status,
          logoUrl: normalizedTenant.logoUrl,
          bannerUrl: normalizedTenant.bannerUrl,
          description: normalizedTenant.description,
          storefrontSettings: normalizedTenant.storefrontSettings,
        },
        products,
      },
      'GET /api/v1/internal/storefront/:brandSlug'
    );
  });

  // Internal Tenants Directory (protected by SUPER_ADMIN bearer token)
  app.get(
    '/api/v1/internal/tenants',
    { preHandler: superAdminInternalGuards },
    async () => {
      return { tenants: db.getTenants() };
    }
  );
}
