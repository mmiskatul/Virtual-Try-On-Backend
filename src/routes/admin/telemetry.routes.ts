import { FastifyInstance } from 'fastify';
import { createAdminMiddleware, registerScopedPreHandlers } from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { db } from '../../infrastructure/database.js';
import { geminiTryOnEngine } from '../../modules/tryon/gemini.engine.js';

const adminGuards = createAdminMiddleware();

export async function adminTelemetryRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, adminGuards);

  // Real numbers about virtual try-on across all shops (from the stored try-on jobs).
  app.get('/api/v1/admin/ai/telemetry', { preHandler: requirePermission('ai', 'read') }, async () => {
    const jobs = db.getAllGenerations();
    const completed = jobs.filter((j) => j.status === 'COMPLETED').length;
    const failed = jobs.filter((j) => j.status === 'FAILED').length;
    const inProgress = jobs.length - completed - failed;
    const finished = completed + failed;
    const engine = geminiTryOnEngine.status();
    return {
      service: 'Gemini virtual try-on (built into the backend)',
      provider: 'gemini',
      imageModel: engine.imageModel,
      configured: engine.configured,
      totalGenerations: jobs.length,
      completed,
      failed,
      inProgress,
      successRate: finished > 0 ? Number(((completed / finished) * 100).toFixed(1)) : null,
      status: engine.configured ? 'HEALTHY' : 'KEY_REQUIRED',
    };
  });
}
