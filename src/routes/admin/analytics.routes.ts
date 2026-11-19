import { FastifyInstance } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createAdminMiddleware, registerScopedPreHandlers } from '../../infrastructure/auth.guard.js';
import { billingCreditService } from '../../modules/billing/billing.service.js';
import { buildMonthlySeries } from '../../modules/admin/analytics_series.js';
import { requireAnyPermission } from '../../modules/rbac/rbac.catalog.js';

const adminGuards = createAdminMiddleware();

export async function adminAnalyticsRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, adminGuards);

  // Global Platform Overview
  app.get('/api/v1/admin/analytics/overview', { preHandler: requireAnyPermission('tenants:read', 'billing:read', 'ai:read') }, async () => {
    const tenants = db.getTenants();
    const products = db.getProducts();
    const orders = db.getOrders();

    const activeTenants = tenants.filter(t => t.status === 'ACTIVE').length;
    const suspendedTenants = tenants.filter(t => t.status === 'SUSPENDED').length;

    const gmv = orders
      .filter(o => o.paymentStatus === 'PAID')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    return {
      tenants: {
        total: tenants.length,
        active: activeTenants,
        suspended: suspendedTenants
      },
      catalog: {
        totalProducts: products.length,
        marketplacePublished: products.filter(p => p.marketplacePublished).length,
        tryOnEligible: products.filter(p => p.isTryOnEligible).length
      },
      orders: {
        totalOrders: orders.length,
        gmv: Number(gmv.toFixed(2))
      },
      aiTelemetry: {
        // Real count of generation jobs. Latency and GPU details are not measured by this service, so they are not reported.
        totalTryOnInvocations: db.getAllGenerations().length
      }
    };
  });

  // Real monthly revenue (paid invoices) and try-on generations for the last N months, oldest first.
  app.get('/api/v1/admin/analytics/series', { preHandler: requireAnyPermission('billing:read', 'ai:read') }, async (request) => {
    const q = request.query as { months?: string };
    const points = buildMonthlySeries({
      invoices: await billingCreditService.listInvoicesDurable(),
      generations: db.getAllGenerations(),
      months: Number(q.months) || 6,
    });
    return { success: true, data: { points } };
  });
}
