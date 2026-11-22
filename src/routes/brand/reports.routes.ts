import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware } from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  customersReport,
  discountStats,
  parsePeriod,
  productsReport,
  salesReport,
  tryOnReport,
} from '../../modules/reports/reports.service.js';
import { listDiscounts } from '../../modules/commerce/discounts.js';
import { requireTenantContext } from './profile.service.js';

const analyticsGuards = createBrandMiddleware(requirePermission('brand:analytics', 'read'));
const ordersGuards = createBrandMiddleware(requirePermission('brand:orders', 'read'));

const periodOf = (request: FastifyRequest) => parsePeriod((request.query as { period?: string } | undefined)?.period);

/**
 * Read-only reports for the signed-in brand. The brand is always taken from the login, never from the
 * request, so one brand can never see another brand's numbers.
 */
export async function brandReportRoutes(app: FastifyInstance) {
  app.get('/api/v1/brand/reports/sales', { preHandler: analyticsGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return salesReport(db.getOrdersByTenant(tenant.id), periodOf(request));
  });

  app.get('/api/v1/brand/reports/products', { preHandler: analyticsGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return productsReport(db.getOrdersByTenant(tenant.id), db.getProductsByTenant(tenant.id), periodOf(request));
  });

  app.get('/api/v1/brand/reports/customers', { preHandler: analyticsGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return customersReport(db.getOrdersByTenant(tenant.id), periodOf(request));
  });

  app.get('/api/v1/brand/reports/try-on', { preHandler: analyticsGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const jobs = db.getAllGenerations().filter((g) => g.tenantId === tenant.id);
    return tryOnReport(jobs, db.getProductsByTenant(tenant.id), periodOf(request));
  });

  // How each discount code is doing: orders, sales and money given away.
  app.get('/api/v1/brand/discounts/stats', { preHandler: ordersGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return discountStats(db.getOrdersByTenant(tenant.id), listDiscounts(tenant));
  });
}
