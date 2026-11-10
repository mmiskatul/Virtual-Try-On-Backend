import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { StorefrontSettings, Tenant } from '../../domain/types.js';

const brandReadGuards = [authenticateToken, requireRole('BRAND_OWNER', 'STORE_MANAGER')];
const brandOwnerGuards = [authenticateToken, requireRole('BRAND_OWNER')];

function isSafeHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function sanitizeStorefrontSettings(raw: any, existing?: StorefrontSettings): StorefrontSettings {
  const next: StorefrontSettings = { ...(existing || {}) };
  if (typeof raw?.primaryColor === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(raw.primaryColor.trim())) {
    next.primaryColor = raw.primaryColor.trim();
  }
  if (typeof raw?.accentColor === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(raw.accentColor.trim())) {
    next.accentColor = raw.accentColor.trim();
  }
  if (typeof raw?.announcement === 'string') {
    next.announcement = raw.announcement.slice(0, 200);
  }
  if (typeof raw?.aboutText === 'string') {
    next.aboutText = raw.aboutText.slice(0, 2000);
  }
  if (isSafeHttpUrl(raw?.bannerImage)) {
    next.bannerImage = raw.bannerImage.trim();
  }
  return next;
}

export async function brandStorefrontRoutes(app: FastifyInstance) {
  // Brand Profile & Storefront Customization
  app.get('/api/v1/brand/profile', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    return { tenant: request.tenant };
  });

  app.put('/api/v1/brand/profile', { preHandler: brandOwnerGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const body = (request.body as Partial<Tenant>) || {};
    const updates: Partial<Tenant> = {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : request.tenant.name,
      description: typeof body.description === 'string' ? body.description : request.tenant.description,
      contactEmail: typeof body.contactEmail === 'string' && body.contactEmail.includes('@')
        ? body.contactEmail.trim()
        : request.tenant.contactEmail,
      storefrontSettings: sanitizeStorefrontSettings(body.storefrontSettings, request.tenant.storefrontSettings),
    };
    if (isSafeHttpUrl(body.logoUrl)) updates.logoUrl = body.logoUrl.trim();
    if (isSafeHttpUrl(body.bannerUrl)) updates.bannerUrl = body.bannerUrl.trim();

    const updated = db.updateTenant(request.tenant.id, updates);
    return { message: 'Brand profile updated successfully', tenant: updated };
  });

  // Dedicated storefront settings update
  app.put('/api/v1/brand/storefront-settings', { preHandler: brandOwnerGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const settings = (request.body as any) || {};
    const updated = db.updateTenant(request.tenant.id, {
      storefrontSettings: sanitizeStorefrontSettings(settings, request.tenant.storefrontSettings),
    });
    return { message: 'Storefront settings updated successfully', tenant: updated };
  });

  // Brand Analytics
  app.get('/api/v1/brand/analytics', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const tenantId = request.tenant.id;
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

  // Public Storefront Discovery (returns only public storefront fields, never private contactEmail)
  app.get('/api/v1/internal/storefront/:brandSlug', async (request: FastifyRequest, reply: FastifyReply) => {
    const { brandSlug } = request.params as { brandSlug: string };
    const tenant = db.getTenantBySlug(brandSlug);
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(404).send({ error: 'NotFound', message: 'Storefront not found or inactive.' });
    }
    const products = db.getStorefrontProducts(tenant.id);
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        logoUrl: tenant.logoUrl,
        bannerUrl: tenant.bannerUrl,
        description: tenant.description,
        storefrontSettings: tenant.storefrontSettings,
      },
      products,
    };
  });

  // Internal Tenants Directory (protected by SUPER_ADMIN bearer token)
  app.get(
    '/api/v1/internal/tenants',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async () => {
      return { tenants: db.getTenants() };
    }
  );
}
