import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { clearPortalAuthCookies, resolvePortalFromRequest } from '../../infrastructure/auth_cookies.js';
import { okResponse } from '../../infrastructure/http.js';
import {
  listUserSessions,
  revokeAllUserSessions,
  revokeUserSession,
} from '../../modules/auth/jwt.verifier.js';
import {
  ROLE_DEFINITIONS,
  PERMISSION_DEFINITIONS,
  requirePermission,
  seedDefaultRbac,
} from '../../modules/rbac/rbac.catalog.js';
import {
  endViewAsSession,
  getActiveViewAsSession,
  startViewAsSession,
} from '../../modules/tenants/tenant.scope.js';
import { recordAudit } from '../../modules/audit/audit.service.js';

const ViewAsStartSchema = z.object({
  mode: z.enum(['READ_ONLY', 'SUPPORT_WRITE']).default('READ_ONLY'),
  reason: z.string().min(5, 'A detailed support reason (min 5 chars) is required for View-As access.').max(500),
  ttlMinutes: z.number().int().min(5).max(120).default(30),
});

const AssignRoleSchema = z.object({
  userId: z.string().min(1),
  roleCode: z.string().min(1),
  tenantId: z.string().optional(),
});

export async function sessionRbacRoutes(app: FastifyInstance) {
  // List current authenticated user's sessions
  app.get('/api/v1/auth/sessions', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const sessions = await listUserSessions(request.authUser!.id);
    return okResponse(
      {
        currentSessionId: request.sessionId || null,
        sessions,
      },
      request.correlationId
    );
  });

  // Revoke a specific session belonging to current user (or any session by Super Admin)
  app.post('/api/v1/auth/sessions/:id/revoke', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const ownSessions = await listUserSessions(request.authUser!.id);
    const isOwn = ownSessions.some((s) => s.id === id) || request.sessionId === id;
    const isAdmin = (request.roleCodes || [request.authUser!.role]).includes('SUPER_ADMIN');

    if (!isOwn && !isAdmin) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You can only revoke your own active sessions.',
      });
    }

    await revokeUserSession(id);
    if (request.sessionId === id) {
      clearPortalAuthCookies(reply, request, resolvePortalFromRequest(request));
    }
    await recordAudit({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      tenantId: request.authUser!.tenantId,
      action: 'AUTH_SESSION_REVOKED',
      entity: 'UserSession',
      entityId: id,
      correlationId: request.correlationId,
      ipAddress: request.ip,
    });

    return okResponse({ revoked: true, sessionId: id }, request.correlationId);
  });

  // Revoke all active sessions for current user
  app.post('/api/v1/auth/sessions/revoke-all', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const count = await revokeAllUserSessions(request.authUser!.id);
    clearPortalAuthCookies(reply, request, resolvePortalFromRequest(request));
    await recordAudit({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      tenantId: request.authUser!.tenantId,
      action: 'AUTH_ALL_SESSIONS_REVOKED',
      entity: 'User',
      entityId: request.authUser!.id,
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { count },
    });
    return okResponse({ revokedCount: count }, request.correlationId);
  });

  // Return authenticated user's resolved RBAC roles & permission set
  app.get('/api/v1/auth/rbac/me', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return okResponse(
      {
        userId: request.authUser!.id,
        role: request.authUser!.role,
        roleCodes: request.roleCodes || [request.authUser!.role],
        permissions: Array.from(request.permissions || []),
        authSource: request.authSource || 'fastify_jwt',
        viewAs: request.viewAsSession || null,
      },
      request.correlationId
    );
  });

  // Admin: List RBAC roles & permission matrix (and idempotently sync default catalog)
  app.get(
    '/api/v1/admin/rbac/roles',
    { preHandler: [authenticateToken, requirePermission('staff', 'manage')] },
    async (request: FastifyRequest) => {
      const prisma = getGlobalPrisma();
      const seedStats = await seedDefaultRbac(prisma);
      return okResponse(
        {
          roles: ROLE_DEFINITIONS,
          permissions: PERMISSION_DEFINITIONS,
          seedStats,
        },
        request.correlationId
      );
    }
  );

  // Admin: Assign an enterprise RBAC role to a platform staff or tenant user
  app.post(
    '/api/v1/admin/staff/roles/assign',
    { preHandler: [authenticateToken, requirePermission('staff', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = AssignRoleSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      const { userId, roleCode, tenantId } = parsed.data;
      const roleDef = ROLE_DEFINITIONS.find((r) => r.code === roleCode);
      if (!roleDef) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: `Unknown RBAC role code '${roleCode}'.`,
        });
      }

      const targetUser = db.getUserById(userId);
      if (!targetUser) {
        return reply.status(404).send({ error: 'NotFound', message: 'Target user not found.' });
      }

      const prisma = getGlobalPrisma();
      if (prisma) {
        await seedDefaultRbac(prisma);
        const profile = await prisma.userProfile.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            displayName: targetUser.name,
            status: 'ACTIVE',
          },
        });
        const roleRow = await prisma.role.findUnique({ where: { code: roleCode } });
        if (roleRow) {
          await prisma.userRoleAssignment.createMany({
            data: [
              {
                userProfileId: profile.id,
                roleId: roleRow.id,
                tenantId: tenantId ?? null,
              },
            ],
            skipDuplicates: true,
          });
        }
      }

      await recordAudit({
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        tenantId,
        action: 'ADMIN_ROLE_ASSIGNED',
        entity: 'User',
        entityId: userId,
        correlationId: request.correlationId,
        ipAddress: request.ip,
        details: { roleCode, tenantId: tenantId ?? null },
      });

      return okResponse({ assigned: true, userId, roleCode, tenantId: tenantId ?? null }, request.correlationId);
    }
  );

  // Admin: Start audited View-As tenant inspection session
  app.post(
    '/api/v1/admin/tenants/:id/view-as',
    { preHandler: [authenticateToken, requirePermission('tenants', 'view_as')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = ViewAsStartSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }

      const tenant = db.getTenantById(id);
      if (!tenant) {
        return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found.' });
      }

      const session = await startViewAsSession({
        adminId: request.authUser!.id,
        tenantId: id,
        mode: parsed.data.mode,
        reason: parsed.data.reason,
        ttlMinutes: parsed.data.ttlMinutes,
        correlationId: request.correlationId,
        ipAddress: request.ip,
      });

      return okResponse(
        {
          session,
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
          headerHint: 'Pass X-View-As-Session: <session.id> on tenant-scoped endpoints',
        },
        request.correlationId
      );
    }
  );

  // Admin: End an active View-As session
  app.post(
    '/api/v1/admin/view-as/:sessionId/end',
    { preHandler: [authenticateToken, requirePermission('tenants', 'view_as')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = request.params as { sessionId: string };
      const ended = await endViewAsSession(sessionId, request.authUser!.id, request.correlationId);
      if (!ended) {
        return reply.status(404).send({ error: 'NotFound', message: 'Active View-As session not found.' });
      }
      return okResponse({ ended: true, session: ended }, request.correlationId);
    }
  );

  // Admin: Check active View-As status for header session
  app.get(
    '/api/v1/admin/view-as/active',
    { preHandler: [authenticateToken, requirePermission('tenants', 'view_as')] },
    async (request: FastifyRequest) => {
      const sid = typeof request.headers['x-view-as-session'] === 'string' ? request.headers['x-view-as-session'] : '';
      const active = sid ? await getActiveViewAsSession(sid, request.authUser!.id) : null;
      return okResponse({ active }, request.correlationId);
    }
  );
}

