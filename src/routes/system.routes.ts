import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { db } from '../infrastructure/database.js';
import { cloudinaryStorage } from '../infrastructure/cloudinary_storage.js';
import { observability } from '../infrastructure/observability.js';
import { config } from '../infrastructure/config.js';

const startedAt = Date.now();
let appVersion = '2.0.0';
try {
  appVersion = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')).version || appVersion;
} catch {
  // keep default
}

export async function systemRoutes(app: FastifyInstance) {
  // Service overview. Reports status only: never URLs, keys, or connection strings.
  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async () => {
      const isPrisma = db.isPrismaActive();
      return {
        service: 'virtual-try-on-unified-backend',
        description: 'Multi-tenant AI virtual try-on SaaS API (brand, marketplace, super admin)',
        version: appVersion,
        status: 'UP',
        environment: process.env.NODE_ENV || 'development',
        startedAt: new Date(startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        database: {
          provider: db.getDatabaseProviderLabel(),
          connected: isPrisma || db.isNeonSqlActive()
        },
        integrations: {
          imageStorage: cloudinaryStorage.isConfigured() ? 'configured' : 'not configured',
          aiService: config.aiServiceUrl ? 'configured' : 'not configured',
          email: config.smtpHost ? 'configured' : 'dev preview mode'
        },
        endpoints: {
          health: '/health',
          live: '/live',
          ready: '/ready',
          metrics: '/metrics',
          brand: '/api/v1/auth, /api/v1/products, /api/v1/brand',
          marketplace: '/api/v1/marketplace, /api/v1/try-on, /api/v1/checkout',
          admin: '/api/v1/admin'
        }
      };
    }
  });

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
