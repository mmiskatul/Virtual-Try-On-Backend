import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { Tenant } from '../../domain/types.js';

export async function brandStorefrontRoutes(app: FastifyInstance) {
  // Brand Profile & Storefront Customization
  app.get('/api/v1/brand/profile', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return { tenant: request.tenant };
  });

  app.put('/api/v1/brand/profile', { preHandler: [authenticateToken, requireRole('BRAND_OWNER')] }, async (request: FastifyRequest) => {
    const body = request.body as Partial<Tenant>;
    const updated = db.updateTenant(request.tenant!.id, {
      name: body.name || request.tenant!.name,
      description: body.description,
      logoUrl: body.logoUrl,
      bannerUrl: body.bannerUrl,
      contactEmail: body.contactEmail || request.tenant!.contactEmail,
      storefrontSettings: {
        ...request.tenant!.storefrontSettings,
        ...(body.storefrontSettings || {})
      }
    });
    return { message: 'Brand profile updated successfully', tenant: updated };
  });

  // Dedicated storefront settings update
  app.put('/api/v1/brand/storefront-settings', { preHandler: [authenticateToken, requireRole('BRAND_OWNER')] }, async (request: FastifyRequest) => {
    const settings = request.body as any;
    const updated = db.updateTenant(request.tenant!.id, {
      storefrontSettings: {
        ...request.tenant!.storefrontSettings,
        ...settings
      }
    });
    return { message: 'Storefront settings updated successfully', tenant: updated };
  });

  // Brand Analytics
  app.get('/api/v1/brand/analytics', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const tenantId = request.tenant!.id;
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

    return {
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
    };
  });

  // Public/Internal Storefront Discovery
  app.get('/api/v1/internal/storefront/:brandSlug', async (request: FastifyRequest, reply: FastifyReply) => {
    const { brandSlug } = request.params as { brandSlug: string };
    const tenant = db.getTenantBySlug(brandSlug);
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(404).send({ error: 'NotFound', message: 'Storefront not found or inactive.' });
    }
    const products = db.getStorefrontProducts(tenant.id);
    return { tenant, products };
  });

  app.get('/api/v1/internal/tenants', async () => {
    return { tenants: db.getTenants() };
  });
}
