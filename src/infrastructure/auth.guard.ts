import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from './database.js';
import { getGlobalPrisma } from './prisma.js';
import { User, Tenant, UserRole } from '../domain/types.js';
import { isSessionRevoked, resolveUserFromClaims, verifyDualJwt } from '../modules/auth/jwt.verifier.js';
import { PLATFORM_ADMIN_ROLE_CODES, resolvePermissionsForRoles } from '../modules/rbac/rbac.catalog.js';
import { ActiveViewAsSession, getActiveViewAsSession } from '../modules/tenants/tenant.scope.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: User;
    tenant?: Tenant;
    roleCodes?: string[];
    permissions?: Set<string>;
    sessionId?: string;
    authSource?: 'fastify_jwt' | 'supabase_jwt';
    viewAsSession?: ActiveViewAsSession;
  }
}

export async function authenticateToken(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or malformed Authorization header.' });
    }

    const token = authHeader.substring(7);
    const claims = await verifyDualJwt(request, token);

    if (claims.sid && (await isSessionRevoked(claims.sid))) {
      return reply.status(401).send({
        error: 'SessionRevoked',
        message: 'This session has been revoked or expired. Please sign in again.',
      });
    }

    const user = await resolveUserFromClaims(claims);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'User not found or deleted.' });
    }

    request.authUser = user;
    request.sessionId = claims.sid;
    request.authSource = claims.authSource;

    const roleSet = new Set<string>([user.role]);
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const profile = await prisma.userProfile.findUnique({
          where: { userId: user.id },
          include: {
            roleAssignments: { include: { role: true } },
            memberships: true,
          },
        });
        if (profile?.status === 'SUSPENDED') {
          return reply.status(403).send({
            error: 'AccountSuspended',
            message: 'User account has been suspended by platform administration.',
          });
        }
        if (profile) {
          for (const ra of profile.roleAssignments || []) {
            if (ra.role?.code) roleSet.add(ra.role.code);
          }
          for (const tm of profile.memberships || []) {
            if (tm.status === 'ACTIVE' && tm.roleCode) roleSet.add(tm.roleCode);
          }
        }
      } catch {
        // Resilient fallback if profile table has no row yet for seeded/legacy user
      }
    }

    request.roleCodes = Array.from(roleSet);
    request.permissions = resolvePermissionsForRoles(request.roleCodes);

    // Optional audited View-As tenant inspection for Platform Admins
    const viewAsHeader = request.headers['x-view-as-session'];
    if (typeof viewAsHeader === 'string' && viewAsHeader.trim()) {
      const isAdmin = request.roleCodes.some((r) => PLATFORM_ADMIN_ROLE_CODES.has(r));
      if (!isAdmin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only platform administrators can use View-As session headers.',
        });
      }
      const viewAs = await getActiveViewAsSession(viewAsHeader.trim(), user.id);
      if (!viewAs) {
        return reply.status(401).send({
          error: 'ViewAsSessionInvalid',
          message: 'View-As inspection session is invalid, ended, or expired.',
        });
      }
      const viewedTenant = db.getTenantById(viewAs.tenantId);
      if (!viewedTenant) {
        return reply.status(404).send({ error: 'NotFound', message: 'Viewed tenant no longer exists.' });
      }
      request.viewAsSession = viewAs;
      request.tenant = viewedTenant;
      return;
    }

    if (user.tenantId) {
      const tenant = db.getTenantById(user.tenantId);
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Tenant organization not found.' });
      }
      if (tenant.status !== 'ACTIVE') {
        return reply.status(403).send({
          error: 'TenantSuspended',
          message: 'Tenant organization is not active.',
        });
      }
      request.tenant = tenant;
    }
  } catch (err: any) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token.', details: err.message });
  }
}

export function requireRole(...allowedRoles: (UserRole | string)[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required.' });
    }
    const roleCodes = request.roleCodes || [request.authUser.role];
    const hasAllowedRole = roleCodes.some((r) => allowedRoles.includes(r));
    if (!hasAllowedRole) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Role '${request.authUser.role}' does not have sufficient permission for this endpoint.`,
      });
    }
  };
}
