import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';

export async function adminTenantRoutes(app: FastifyInstance) {
  // List all tenants with quotas & counts
  app.get('/api/v1/admin/tenants', { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] }, async () => {
    const tenants = db.getTenants();
    const products = db.getProducts();
    const orders = db.getOrders();

    return tenants.map(t => {
      const sub = db.getSubscription(t.id);
      const tenantProds = products.filter(p => p.tenantId === t.id);
      const tenantOrders = orders.filter(o => o.tenantId === t.id);
      const revenue = tenantOrders
        .filter(o => o.paymentStatus === 'PAID')
        .reduce((sum, o) => sum + o.totalAmount, 0);

      return {
        ...t,
        productCount: tenantProds.length,
        orderCount: tenantOrders.length,
        totalRevenue: revenue,
        subscription: sub || {
          plan: 'STARTER',
          productLimit: 50,
          tryOnMonthlyQuota: 500,
          tryOnUsed: 0,
          status: 'ACTIVE'
        }
      };
    });
  });

  // Suspend or Activate Tenant
  app.patch('/api/v1/admin/tenants/:id/status', { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { status } = (request.body as any) || {};

    if (!status || !['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION'].includes(status)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: "Status must be 'ACTIVE', 'SUSPENDED', or 'PENDING_VERIFICATION'."
      });
    }

    const tenant = db.getTenantById(id);
    if (!tenant) {
      return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found.' });
    }

    const updated = db.updateTenant(id, { status });

    db.recordAuditLog({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      action: status === 'ACTIVE' ? 'TENANT_ACTIVATED' : 'TENANT_SUSPENDED',
      entity: 'Tenant',
      entityId: id,
      details: { previousStatus: tenant.status, newStatus: status }
    });

    return {
      message: `Tenant status successfully updated to ${status}`,
      tenant: updated
    };
  });
}
