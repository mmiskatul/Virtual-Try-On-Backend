import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createAdminMiddleware, registerScopedPreHandlers } from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';

const adminGuards = createAdminMiddleware();

export async function adminAuditRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, adminGuards);

  // Get Audit Trail
  app.get('/api/v1/admin/audit-logs', { preHandler: requirePermission('audit', 'read') }, async (request: FastifyRequest) => {
    const { tenantId } = request.query as { tenantId?: string };
    const logs = db.getAuditLogs(tenantId);
    return logs;
  });
}
