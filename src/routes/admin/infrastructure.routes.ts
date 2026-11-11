import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { emailService } from '../../infrastructure/email.service.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { PrismaDatabase } from '../../infrastructure/prisma_database.js';
import { NeonSqlDatabase } from '../../infrastructure/neon_database.js';
import {
  isMaskedPlaceholder,
  maskConnectionString,
  maskSecret,
  sanitizeEnvValue,
  updateEnvFile,
} from '../../infrastructure/env_manager.js';

const adminGuards = [authenticateToken, requireRole('SUPER_ADMIN')];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractHost(uri: string): string {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return '';
  }
}

function isValidPostgresUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
  } catch {
    return false;
  }
}

export async function adminInfrastructureRoutes(app: FastifyInstance) {
  // 1. Read Masked Resend Email + Supabase / Database Configuration
  app.get('/api/v1/admin/infrastructure/config', { preHandler: adminGuards }, async () => {
    const prisma = db.getPrisma();
    const counts = prisma && prisma.isConnected() ? await prisma.getTableCounts().catch(() => null) : null;
    const health = prisma && prisma.isConnected() ? await prisma.checkHealth().catch(() => null) : null;

    return {
      resend: {
        activeTransport: emailService.getActiveTransport(),
        configured: emailService.hasRealTransport(),
        hasApiKey: Boolean(config.resendApiKey),
        maskedApiKey: maskSecret(config.resendApiKey),
        from: config.resendFrom || 'V-TRY Studio <onboarding@resend.dev>',
      },
      database: {
        provider: db.getDatabaseProviderLabel(),
        connected: db.isPrismaActive() || db.isNeonSqlActive(),
        prismaActive: db.isPrismaActive(),
        latencyMs: health?.latencyMs ?? null,
        dbHost: extractHost(config.databaseUrl),
        hasDatabaseUrl: Boolean(config.databaseUrl),
        maskedDatabaseUrl: maskConnectionString(config.databaseUrl),
        tableCounts: counts,
        snapshotCounts: {
          tenants: db.getTenants().length,
          users: db.getUsers().length,
          products: db.getProducts().length,
          orders: db.getOrders().length,
        },
      },
    };
  });

  // 2. Save & Live-Reload Resend Configuration
  app.post('/api/v1/admin/infrastructure/resend', { preHandler: adminGuards }, async (request: FastifyRequest) => {
    const body = (request.body as any) || {};
    const envUpdates: Record<string, string> = {};

    if (typeof body.apiKey === 'string' && body.apiKey.trim() && !isMaskedPlaceholder(body.apiKey)) {
      const val = sanitizeEnvValue(body.apiKey);
      config.resendApiKey = val;
      process.env.RESEND_API_KEY = val;
      envUpdates.RESEND_API_KEY = val;
    } else if (body.clearApiKey === true) {
      config.resendApiKey = '';
      process.env.RESEND_API_KEY = '';
      envUpdates.RESEND_API_KEY = '';
    }

    if (typeof body.from === 'string' && body.from.trim()) {
      const val = sanitizeEnvValue(body.from);
      config.resendFrom = val;
      process.env.RESEND_FROM = val;
      envUpdates.RESEND_FROM = val;
    }

    emailService.reloadTransport();
    updateEnvFile(envUpdates);

    db.recordAuditLog({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      action: 'RESEND_CONFIG_UPDATED',
      entity: 'EmailTransport',
      details: {
        activeTransport: emailService.getActiveTransport(),
        from: config.resendFrom,
      },
    });

    return {
      success: true,
      activeTransport: emailService.getActiveTransport(),
      message: 'Resend email delivery configuration updated and reloaded.',
    };
  });

  // 3. Verify Resend API Key OR Send Real Test Email
  app.post('/api/v1/admin/infrastructure/resend/test', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const action = body.action === 'send' ? 'send' : 'verify';
    const override = {
      apiKey:
        typeof body.apiKey === 'string' && body.apiKey.trim() && !isMaskedPlaceholder(body.apiKey)
          ? sanitizeEnvValue(body.apiKey)
          : undefined,
      from: typeof body.from === 'string' && body.from.trim() ? sanitizeEnvValue(body.from) : undefined,
    };

    if (action === 'send') {
      const recipient = typeof body.testRecipient === 'string' ? body.testRecipient.trim() : '';
      if (!recipient || !EMAIL_REGEX.test(recipient)) {
        return reply.status(400).send({
          success: false,
          message: 'Please provide a valid recipient email address to send a test email.',
        });
      }
      const res = await emailService.sendTestEmail(recipient, override);
      return reply.status(res.success ? 200 : 400).send(res);
    }

    const verifyRes = await emailService.verifyResendConnection(override);
    return reply.status(verifyRes.success ? 200 : 400).send(verifyRes);
  });

  // 4. Test Supabase / PostgreSQL Connection (Non-destructive)
  app.post('/api/v1/admin/infrastructure/database/test', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const candidateDbUrl =
      typeof body.databaseUrl === 'string' && body.databaseUrl.trim() && !isMaskedPlaceholder(body.databaseUrl)
        ? sanitizeEnvValue(body.databaseUrl)
        : config.databaseUrl;

    if (!candidateDbUrl) {
      return reply.status(400).send({
        success: false,
        message: 'No PostgreSQL / Supabase connection URI configured to test.',
      });
    }

    if (!isValidPostgresUri(candidateDbUrl)) {
      return reply.status(400).send({
        success: false,
        message: 'Connection URI must start with postgresql:// or postgres://.',
      });
    }

    const tempSql = new NeonSqlDatabase(candidateDbUrl);
    const tempPrisma = new PrismaDatabase(candidateDbUrl);
    try {
      const sqlConnected = await tempSql.init();
      const prismaConnected = await tempPrisma.init();
      const health = prismaConnected ? await tempPrisma.checkHealth() : await tempSql.checkHealth();
      const counts = prismaConnected ? await tempPrisma.getTableCounts().catch(() => null) : null;

      if (!sqlConnected && !prismaConnected) {
        return reply.status(400).send({
          success: false,
          message: health.error || 'Could not establish PostgreSQL / Supabase connection.',
        });
      }

      return {
        success: true,
        latencyMs: health.latencyMs,
        counts,
        message: `Connected successfully in ${health.latencyMs}ms! Schema verified (${counts ? `${counts.tenants} tenants, ${counts.users} users` : 'SQL ready'}).`,
      };
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        message: `Database test failed: ${err?.message || 'Connection error'}`,
      });
    } finally {
      await tempPrisma.close().catch(() => {});
      await tempSql.close().catch(() => {});
    }
  });

  // 5. Save Supabase / PostgreSQL Configuration & Reconnect Live
  app.post('/api/v1/admin/infrastructure/database', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const envUpdates: Record<string, string> = {};

    let nextDbUrl = config.databaseUrl;
    if (typeof body.databaseUrl === 'string' && body.databaseUrl.trim() && !isMaskedPlaceholder(body.databaseUrl)) {
      const cleaned = sanitizeEnvValue(body.databaseUrl);
      if (!isValidPostgresUri(cleaned)) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: 'Database connection URI must start with postgresql:// or postgres://.',
        });
      }
      nextDbUrl = cleaned;
      config.databaseUrl = cleaned;
      process.env.DATABASE_URL = cleaned;
      envUpdates.DATABASE_URL = cleaned;
    }

    updateEnvFile(envUpdates);
    const reloadResult = await db.reloadDatabase(nextDbUrl);

    db.recordAuditLog({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      action: 'DATABASE_CONFIG_UPDATED',
      entity: 'Database',
      details: {
        provider: reloadResult.provider,
        connected: reloadResult.connected,
        dbHost: extractHost(nextDbUrl),
      },
    });

    if (!reloadResult.connected && nextDbUrl) {
      return reply.status(400).send({
        success: false,
        ...reloadResult,
        message: reloadResult.error || 'Settings saved, but live reconnection failed.',
      });
    }

    return {
      success: true,
      ...reloadResult,
      message: `Connected and hydrated from ${reloadResult.provider}!`,
    };
  });

  // 6. Sync Local Snapshot / Demo Data into Connected Supabase / PostgreSQL Database
  app.post('/api/v1/admin/infrastructure/database/sync', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await db.syncSnapshotToDatabase();
      db.recordAuditLog({
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        action: 'DATABASE_SYNC_COMPLETED',
        entity: 'Database',
        details: result.synced,
      });
      return {
        success: true,
        ...result,
        message: `Synchronized ${result.synced.tenants} tenants, ${result.synced.users} users, and ${result.synced.products} products to ${db.getDatabaseProviderLabel()}.`,
      };
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        message: err?.message || 'Could not synchronize snapshot to database.',
      });
    }
  });
}

