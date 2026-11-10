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

function isSafeHttpsSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function adminInfrastructureRoutes(app: FastifyInstance) {
  // 1. Read Masked SMTP + Supabase / Database Configuration
  app.get('/api/v1/admin/infrastructure/config', { preHandler: adminGuards }, async () => {
    const prisma = db.getPrisma();
    const counts = prisma && prisma.isConnected() ? await prisma.getTableCounts().catch(() => null) : null;
    const health = prisma && prisma.isConnected() ? await prisma.checkHealth().catch(() => null) : null;

    return {
      smtp: {
        activeTransport: emailService.getActiveTransport(),
        configured: emailService.hasRealTransport(),
        host: config.smtpHost || '',
        port: config.smtpPort || 587,
        secure: config.smtpSecure,
        user: config.smtpUser || '',
        hasPass: Boolean(config.smtpPass),
        maskedPass: maskSecret(config.smtpPass),
        from: config.emailFrom || 'V-TRY Studio <noreply@v-try.fashion>',
        resendConfigured: Boolean(config.resendApiKey),
        maskedResendKey: maskSecret(config.resendApiKey),
      },
      portals: {
        marketplaceUrl: config.marketplaceUrl,
        brandDashboardUrl: config.brandDashboardUrl,
        superAdminUrl: config.superAdminUrl,
      },
      database: {
        provider: db.getDatabaseProviderLabel(),
        connected: db.isPrismaActive() || db.isNeonSqlActive(),
        prismaActive: db.isPrismaActive(),
        latencyMs: health?.latencyMs ?? null,
        dbHost: extractHost(config.databaseUrl),
        hasDatabaseUrl: Boolean(config.databaseUrl),
        maskedDatabaseUrl: maskConnectionString(config.databaseUrl),
        supabaseUrl: config.supabaseUrl || '',
        hasAnonKey: Boolean(config.supabaseAnonKey),
        maskedAnonKey: maskSecret(config.supabaseAnonKey),
        hasServiceRoleKey: Boolean(config.supabaseServiceRoleKey),
        maskedServiceRoleKey: maskSecret(config.supabaseServiceRoleKey),
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

  // 2. Save & Live-Reload SMTP + Portal Links
  app.post('/api/v1/admin/infrastructure/smtp', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const envUpdates: Record<string, string> = {};

    if (typeof body.host === 'string') {
      const val = sanitizeEnvValue(body.host);
      config.smtpHost = val;
      process.env.SMTP_HOST = val;
      envUpdates.SMTP_HOST = val;
    }
    if (body.port !== undefined) {
      const portNum = Number(body.port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return reply.status(400).send({ error: 'ValidationError', message: 'SMTP port must be between 1 and 65535.' });
      }
      config.smtpPort = portNum;
      process.env.SMTP_PORT = String(portNum);
      envUpdates.SMTP_PORT = String(portNum);
    }
    if (typeof body.secure === 'boolean') {
      config.smtpSecure = body.secure;
      process.env.SMTP_SECURE = String(body.secure);
      envUpdates.SMTP_SECURE = String(body.secure);
    }
    if (typeof body.user === 'string') {
      const val = sanitizeEnvValue(body.user);
      config.smtpUser = val;
      process.env.SMTP_USER = val;
      envUpdates.SMTP_USER = val;
    }
    if (typeof body.pass === 'string' && body.pass !== '' && !isMaskedPlaceholder(body.pass)) {
      const val = sanitizeEnvValue(body.pass);
      config.smtpPass = val;
      process.env.SMTP_PASS = val;
      envUpdates.SMTP_PASS = val;
    } else if (body.clearPass === true) {
      config.smtpPass = '';
      process.env.SMTP_PASS = '';
      envUpdates.SMTP_PASS = '';
    }
    if (typeof body.from === 'string' && body.from.trim()) {
      const val = sanitizeEnvValue(body.from);
      config.emailFrom = val;
      process.env.EMAIL_FROM = val;
      envUpdates.EMAIL_FROM = val;
    }
    if (typeof body.resendApiKey === 'string' && body.resendApiKey.trim() && !isMaskedPlaceholder(body.resendApiKey)) {
      const val = sanitizeEnvValue(body.resendApiKey);
      config.resendApiKey = val;
      process.env.RESEND_API_KEY = val;
      envUpdates.RESEND_API_KEY = val;
    }
    if (typeof body.marketplaceUrl === 'string' && body.marketplaceUrl.trim()) {
      const val = sanitizeEnvValue(body.marketplaceUrl);
      config.marketplaceUrl = val;
      process.env.MARKETPLACE_URL = val;
      envUpdates.MARKETPLACE_URL = val;
    }
    if (typeof body.brandDashboardUrl === 'string' && body.brandDashboardUrl.trim()) {
      const val = sanitizeEnvValue(body.brandDashboardUrl);
      config.brandDashboardUrl = val;
      process.env.BRAND_DASHBOARD_URL = val;
      envUpdates.BRAND_DASHBOARD_URL = val;
    }
    if (typeof body.superAdminUrl === 'string' && body.superAdminUrl.trim()) {
      const val = sanitizeEnvValue(body.superAdminUrl);
      config.superAdminUrl = val;
      process.env.SUPER_ADMIN_URL = val;
      envUpdates.SUPER_ADMIN_URL = val;
    }

    emailService.reloadTransport();
    updateEnvFile(envUpdates);

    db.recordAuditLog({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      action: 'SMTP_CONFIG_UPDATED',
      entity: 'EmailTransport',
      details: {
        activeTransport: emailService.getActiveTransport(),
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
      },
    });

    return {
      success: true,
      activeTransport: emailService.getActiveTransport(),
      message: 'SMTP & email delivery configuration updated and reloaded.',
    };
  });

  // 3. Verify SMTP Handshake OR Send Real Test Email
  app.post('/api/v1/admin/infrastructure/smtp/test', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const action = body.action === 'send' ? 'send' : 'verify';
    const override = body.host
      ? {
          host: sanitizeEnvValue(body.host),
          port: body.port ? Number(body.port) : config.smtpPort,
          secure: typeof body.secure === 'boolean' ? body.secure : config.smtpSecure,
          user: typeof body.user === 'string' ? sanitizeEnvValue(body.user) : config.smtpUser,
          pass:
            typeof body.pass === 'string' && body.pass && !isMaskedPlaceholder(body.pass)
              ? sanitizeEnvValue(body.pass)
              : config.smtpPass,
          from: typeof body.from === 'string' && body.from ? sanitizeEnvValue(body.from) : config.emailFrom,
        }
      : undefined;

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

    const verifyRes = await emailService.verifySmtpConnection(override);
    return reply.status(verifyRes.success ? 200 : 400).send(verifyRes);
  });

  // 4. Test Supabase / PostgreSQL Connection (Non-destructive)
  app.post('/api/v1/admin/infrastructure/database/test', { preHandler: adminGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const candidateDbUrl =
      typeof body.databaseUrl === 'string' && body.databaseUrl.trim() && !isMaskedPlaceholder(body.databaseUrl)
        ? sanitizeEnvValue(body.databaseUrl)
        : config.databaseUrl;

    const candidateSupabaseUrl =
      typeof body.supabaseUrl === 'string' && body.supabaseUrl.trim()
        ? sanitizeEnvValue(body.supabaseUrl)
        : config.supabaseUrl;

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

      let supabaseRestOk: boolean | null = null;
      if (candidateSupabaseUrl && isSafeHttpsSupabaseUrl(candidateSupabaseUrl)) {
        try {
          const restRes = await fetch(`${candidateSupabaseUrl.replace(/\/$/, '')}/rest/v1/`, {
            headers: config.supabaseAnonKey ? { apikey: config.supabaseAnonKey } : undefined,
            signal: AbortSignal.timeout(4000),
          });
          supabaseRestOk = restRes.status < 500;
        } catch {
          supabaseRestOk = false;
        }
      }

      if (!sqlConnected && !prismaConnected) {
        return reply.status(400).send({
          success: false,
          message: health.error || 'Could not establish PostgreSQL / Supabase connection.',
        });
      }

      return {
        success: true,
        latencyMs: health.latencyMs,
        supabaseRestOk,
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
      config.supabaseDbUrl = cleaned;
      process.env.DATABASE_URL = cleaned;
      process.env.SUPABASE_DB_URL = cleaned;
      envUpdates.DATABASE_URL = cleaned;
      envUpdates.SUPABASE_DB_URL = cleaned;
    }

    if (typeof body.supabaseUrl === 'string') {
      const cleaned = sanitizeEnvValue(body.supabaseUrl);
      if (cleaned && !isSafeHttpsSupabaseUrl(cleaned)) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: 'Supabase Project URL must be a valid public https:// URL (e.g. https://xyz.supabase.co).',
        });
      }
      config.supabaseUrl = cleaned;
      process.env.SUPABASE_URL = cleaned;
      envUpdates.SUPABASE_URL = cleaned;
    }

    if (typeof body.supabaseAnonKey === 'string' && body.supabaseAnonKey.trim() && !isMaskedPlaceholder(body.supabaseAnonKey)) {
      const cleaned = sanitizeEnvValue(body.supabaseAnonKey);
      config.supabaseAnonKey = cleaned;
      process.env.SUPABASE_ANON_KEY = cleaned;
      envUpdates.SUPABASE_ANON_KEY = cleaned;
    }

    if (
      typeof body.supabaseServiceRoleKey === 'string' &&
      body.supabaseServiceRoleKey.trim() &&
      !isMaskedPlaceholder(body.supabaseServiceRoleKey)
    ) {
      const cleaned = sanitizeEnvValue(body.supabaseServiceRoleKey);
      config.supabaseServiceRoleKey = cleaned;
      process.env.SUPABASE_SERVICE_ROLE_KEY = cleaned;
      envUpdates.SUPABASE_SERVICE_ROLE_KEY = cleaned;
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
