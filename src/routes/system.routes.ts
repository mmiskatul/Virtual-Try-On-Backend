import { FastifyInstance } from 'fastify';
import { db } from '../infrastructure/database.js';
import { cloudinaryStorage } from '../infrastructure/cloudinary_storage.js';
import { observability } from '../infrastructure/observability.js';
import { redisAdapter } from '../infrastructure/redis.js';
import { rabbitMqBus } from '../infrastructure/rabbitmq.js';
import { storageAdapter } from '../infrastructure/storage.adapter.js';
import { createAdminMiddleware } from '../infrastructure/auth.guard.js';

export async function systemRoutes(app: FastifyInstance) {
  // Public root: deliberately minimal. No infrastructure, integration or route details are exposed here.
  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async () => ({
      name: 'V-TRY Studio API',
      status: 'UP',
    }),
  });

  app.get('/health', async () => {
    // Public probe: no infrastructure details in production.
    if (process.env.NODE_ENV === 'production') {
      return { status: 'UP', timestamp: Date.now() };
    }
    const isPrisma = db.isPrismaActive();
    const isDbSql = db.isNeonSqlActive();
    const [redisHealth, storageHealth] = await Promise.all([
      redisAdapter.health(),
      storageAdapter.health(),
    ]);
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
      cloudinaryConfigured: cloudinaryStorage.isConfigured(),
      redis: redisHealth,
      rabbitmq: { connected: rabbitMqBus.isConnected() },
      storage: storageHealth,
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

  app.get('/metrics', { preHandler: createAdminMiddleware() }, async () => {
    return observability.getMetrics();
  });
}
