import { FastifyInstance } from 'fastify';
import { db } from '../infrastructure/database.js';
import { cloudinaryStorage } from '../infrastructure/cloudinary_storage.js';
import { observability } from '../infrastructure/observability.js';

export async function systemRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const isPrisma = db.isPrismaActive();
    const isDbSql = db.isNeonSqlActive();
    return {
      status: 'UP',
      service: 'virtual-try-on-unified-backend',
      timestamp: Date.now(),
      persistence: isPrisma
        ? 'Prisma ORM (PostgreSQL)'
        : isDbSql
        ? 'Neon PostgreSQL SQL Database'
        : 'Resilient In-Memory & File Snapshot',
      prismaActive: isPrisma,
      cloudinaryConfigured: cloudinaryStorage.isConfigured()
    };
  });

  app.get('/live', async () => {
    return { status: 'OK' };
  });

  app.get('/ready', async (_req, reply) => {
    const prisma = db.getPrisma();
    if (prisma && prisma.isConnected()) {
      const health = await prisma.checkHealth();
      if (!health.ok) {
        return reply.status(503).send({ status: 'DEGRADED', reason: health.error });
      }
    }
    const neon = db.getNeonSql();
    if (neon && neon.isConnected()) {
      const health = await neon.checkHealth();
      if (!health.ok) {
        return reply.status(503).send({ status: 'DEGRADED', reason: health.error });
      }
    }
    return { status: 'READY' };
  });

  app.get('/metrics', async () => {
    return observability.getMetrics();
  });
}
