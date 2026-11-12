import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createAdminMiddleware, registerScopedPreHandlers, requireRole } from '../../infrastructure/auth.guard.js';

const adminGuards = createAdminMiddleware(requireRole('SUPER_ADMIN'));

export async function adminAuditRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, adminGuards);

  // Get Audit Trail
  app.get('/api/v1/admin/audit-logs', { preHandler: adminGuards }, async (request: FastifyRequest) => {
    const { tenantId } = request.query as { tenantId?: string };
    const logs = db.getAuditLogs(tenantId);
    return logs;
  });
}
