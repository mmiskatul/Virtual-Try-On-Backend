import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';

export async function adminAuditRoutes(app: FastifyInstance) {
  // Get Audit Trail
  app.get('/api/v1/admin/audit-logs', { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] }, async (request: FastifyRequest) => {
    const { tenantId } = request.query as { tenantId?: string };
    const logs = db.getAuditLogs(tenantId);
    return logs;
  });
}
