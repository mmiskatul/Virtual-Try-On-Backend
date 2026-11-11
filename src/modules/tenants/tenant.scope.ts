import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { recordAudit } from '../audit/audit.service.js';
import { PLATFORM_ADMIN_ROLE_CODES } from '../rbac/rbac.catalog.js';

export interface ActiveViewAsSession {
  id: string;
  adminId: string;
  tenantId: string;
  mode: 'READ_ONLY' | 'SUPPORT_WRITE';
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt?: Date | null;
}

const memoryViewAsSessions = new Map<string, ActiveViewAsSession>();

export async function startViewAsSession(params: {
  adminId: string;
  tenantId: string;
  mode?: 'READ_ONLY' | 'SUPPORT_WRITE';
  reason: string;
  ttlMinutes?: number;
  correlationId?: string;
  ipAddress?: string;
}): Promise<ActiveViewAsSession> {
  const id = crypto.randomUUID();
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + (params.ttlMinutes ?? 30) * 60 * 1000);
  const mode = params.mode === 'SUPPORT_WRITE' ? 'SUPPORT_WRITE' : 'READ_ONLY';

  const session: ActiveViewAsSession = {
    id,
    adminId: params.adminId,
    tenantId: params.tenantId,
    mode,
    reason: params.reason.trim(),
    startedAt,
    expiresAt,
    endedAt: null,
  };
  memoryViewAsSessions.set(id, session);

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      await prisma.viewAsSession.create({
        data: {
          id,
          adminId: params.adminId,
          tenantId: params.tenantId,
          mode,
          reason: session.reason,
          expiresAt,
        },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'view_as.prisma_create_warning');
    }
  }

  await recordAudit({
    actorId: params.adminId,
    actorRole: 'SUPER_ADMIN',
    tenantId: params.tenantId,
    action: 'ADMIN_VIEW_AS_STARTED',
    entity: 'ViewAsSession',
    entityId: id,
    correlationId: params.correlationId,
    ipAddress: params.ipAddress,
    details: { mode, reason: session.reason, expiresAt: expiresAt.toISOString() },
  });

  return session;
}

export async function getActiveViewAsSession(
  sessionId: string,
  adminId: string
): Promise<ActiveViewAsSession | null> {
  const now = Date.now();
  const mem = memoryViewAsSessions.get(sessionId);
  if (mem) {
    if (mem.adminId !== adminId || mem.endedAt || mem.expiresAt.getTime() < now) return null;
    return mem;
  }

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      const row = await prisma.viewAsSession.findUnique({ where: { id: sessionId } });
      if (!row) return null;
      if (row.adminId !== adminId || row.endedAt || row.expiresAt.getTime() < now) return null;
      const mapped: ActiveViewAsSession = {
        id: row.id,
        adminId: row.adminId,
        tenantId: row.tenantId,
        mode: row.mode as 'READ_ONLY' | 'SUPPORT_WRITE',
        reason: row.reason,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
        endedAt: row.endedAt,
      };
      memoryViewAsSessions.set(sessionId, mapped);
      return mapped;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'view_as.prisma_lookup_warning');
    }
  }

  return null;
}

export async function endViewAsSession(
  sessionId: string,
  adminId: string,
  correlationId?: string
): Promise<ActiveViewAsSession | null> {
  const now = new Date();
  let target = memoryViewAsSessions.get(sessionId);
  const prisma = getGlobalPrisma();

  if (!target && prisma) {
    try {
      const row = await prisma.viewAsSession.findUnique({ where: { id: sessionId } });
      if (row) {
        target = {
          id: row.id,
          adminId: row.adminId,
          tenantId: row.tenantId,
          mode: row.mode as 'READ_ONLY' | 'SUPPORT_WRITE',
          reason: row.reason,
          startedAt: row.startedAt,
          expiresAt: row.expiresAt,
          endedAt: row.endedAt,
        };
      }
    } catch {
      // ignore
    }
  }

  if (!target || target.adminId !== adminId) return null;
  target.endedAt = now;
  memoryViewAsSessions.set(sessionId, target);

  if (prisma) {
    try {
      await prisma.viewAsSession.update({
        where: { id: sessionId },
        data: { endedAt: now },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'view_as.prisma_end_warning');
    }
  }

  await recordAudit({
    actorId: adminId,
    actorRole: 'SUPER_ADMIN',
    tenantId: target.tenantId,
    action: 'ADMIN_VIEW_AS_ENDED',
    entity: 'ViewAsSession',
    entityId: sessionId,
    correlationId,
  });

  return target;
}

/**
 * Enforces strict multi-tenant scoping:
 * - Derives active tenant from authenticated principal (or verified `X-View-As-Session` for platform admins).
 * - Rejects client-supplied `tenantId` mismatches with `403 TenantScopeViolation`.
 * - Rejects write mutations under a `READ_ONLY` View-As inspection session.
 */
export async function tenantScopeGuard(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authUser) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required.' });
  }

  const isMutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (request.viewAsSession && request.viewAsSession.mode === 'READ_ONLY' && isMutating) {
    return reply.status(403).send({
      error: 'ViewAsReadOnly',
      message: 'Mutations are blocked during a READ_ONLY View-As support inspection session.',
    });
  }

  const scopedTenantId = request.tenant?.id || request.authUser.tenantId;
  if (!scopedTenantId) {
    return reply.status(403).send({
      error: 'TenantRequired',
      message: 'This operation requires an authenticated brand tenant scope.',
    });
  }

  // Reject any attempt by a non-platform-admin to spoof another tenantId via query or JSON body
  const roles = request.roleCodes || [request.authUser.role];
  const isPlatformAdmin = roles.some((r) => PLATFORM_ADMIN_ROLE_CODES.has(r));
  const body = (request.body as Record<string, unknown> | undefined) || {};
  const query = (request.query as Record<string, unknown> | undefined) || {};
  const clientTenantId =
    (typeof body.tenantId === 'string' && body.tenantId) ||
    (typeof query.tenantId === 'string' && query.tenantId) ||
    undefined;

  if (!isPlatformAdmin && clientTenantId && clientTenantId !== scopedTenantId) {
    await recordAudit({
      actorId: request.authUser.id,
      actorRole: request.authUser.role,
      tenantId: scopedTenantId,
      action: 'TENANT_SPOOF_ATTEMPT_BLOCKED',
      entity: 'Tenant',
      entityId: clientTenantId,
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { path: request.url, attemptedTenantId: clientTenantId },
    });
    return reply.status(403).send({
      error: 'TenantScopeViolation',
      message: 'Cross-tenant access denied: client tenant identifier does not match authenticated tenant.',
    });
  }

  const tenant = request.tenant || db.getTenantById(scopedTenantId);
  if (!tenant || tenant.status !== 'ACTIVE') {
    return reply.status(403).send({
      error: 'TenantSuspended',
      message: 'Tenant organization is inactive or suspended.',
    });
  }
  request.tenant = tenant;
}

/**
 * Sets PostgreSQL Row-Level Security GUC context variables inside an explicit Prisma transaction.
 */
export async function withTenantRlsContext<T>(
  prisma: any,
  ctx: { userId: string; tenantId?: string; role: string },
  fn: (tx: any) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${ctx.tenantId || ''}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_role', ${ctx.role}, true)`;
    return fn(tx);
  });
}

