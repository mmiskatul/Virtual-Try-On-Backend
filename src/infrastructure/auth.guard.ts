import { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { db } from './database.js';
import { getGlobalPrisma } from './prisma.js';
import { User, Tenant, UserRole } from '../domain/types.js';
import { isSessionRevoked, resolveUserFromClaims, verifyDualJwt } from '../modules/auth/jwt.verifier.js';
import { extractCookieToken, wantsCookieOnlyTransport } from './auth_cookies.js';
import {
  BRAND_MEMBER_ROLE_CODES,
  PLATFORM_ADMIN_ROLE_CODES,
  resolvePermissionsForRoles,
} from '../modules/rbac/rbac.catalog.js';
import { ActiveViewAsSession, getActiveViewAsSession, tenantScopeGuard } from '../modules/tenants/tenant.scope.js';

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

export function extractAccessTokenFromRequest(request: FastifyRequest): string | null {
  return extractAccessTokenWithSource(request).token;
}

function extractAccessTokenWithSource(request: FastifyRequest): {
  token: string | null;
  fromCookie: boolean;
} {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const candidate = authHeader.substring(7).trim();
    if (candidate && candidate !== 'undefined' && candidate !== 'null') {
      return { token: candidate, fromCookie: false };
    }
  }
  const { token } = extractCookieToken(request, 'access');
  return { token, fromCookie: Boolean(token) };
}

async function verifyTokenAndSessionBinding(
  request: FastifyRequest,
  token: string,
  fromCookie: boolean,
): Promise<
  | {
      ok: true;
      claims: Awaited<ReturnType<typeof verifyDualJwt>>;
      user: User;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
    }
> {
  const claims = await verifyDualJwt(request, token);

  if (claims.sid && (await isSessionRevoked(claims.sid))) {
    return {
      ok: false,
      status: 401,
      error: 'SessionRevoked',
      message: 'This session has been revoked or expired. Please sign in again.',
    };
  }

  if (fromCookie) {
    const { token: sidCookie } = extractCookieToken(request, 'session');
    if (wantsCookieOnlyTransport(request) && claims.sid && !sidCookie) {
      return {
        ok: false,
        status: 401,
        error: 'SessionMissing',
        message: 'HttpOnly session cookie is required.',
      };
    }
    if (sidCookie && ((claims.sid && sidCookie !== claims.sid) || (await isSessionRevoked(sidCookie)))) {
      return {
        ok: false,
        status: 401,
        error: 'SessionMismatch',
        message: 'Session cookie does not match an active session.',
      };
    }
  }

  const user = await resolveUserFromClaims(claims);
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
      message: 'User not found or deleted.',
    };
  }

  return { ok: true, claims, user };
}

export async function resolveOptionalAuthUser(request: FastifyRequest): Promise<{
  user?: User;
  sid?: string;
}> {
  const { token, fromCookie } = extractAccessTokenWithSource(request);
  if (!token) return {};
  try {
    const verified = await verifyTokenAndSessionBinding(request, token, fromCookie);
    if (!verified.ok) return {};
    return { user: verified.user, sid: verified.claims.sid };
  } catch {
    return {};
  }
}

export async function authenticateToken(request: FastifyRequest, reply: FastifyReply) {
  if (request.authUser) {
    return;
  }
  try {
    const { token, fromCookie } = extractAccessTokenWithSource(request);
    if (!token) {
      const hasRefreshCookie = Boolean(extractCookieToken(request, 'refresh').token);
      if (hasRefreshCookie) {
        return reply.status(401).send({
          error: 'TokenExpired',
          code: 'TOKEN_EXPIRED',
          message: 'Access token expired or missing. Refresh required.',
        });
      }
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or malformed Authorization header or auth cookie.',
      });
    }

    const verified = await verifyTokenAndSessionBinding(request, token, fromCookie);
    if (!verified.ok) {
      return reply.status(verified.status).send({
        error: verified.error,
        message: verified.message,
      });
    }

    const { claims, user } = verified;

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
    if (err?.code === 'TOKEN_EXPIRED') {
      return reply.status(401).send({
        error: 'TokenExpired',
        code: 'TOKEN_EXPIRED',
        message: 'Access token expired.',
        details: err.message,
      });
    }
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

/**
 * Portal-boundary middleware preventing cross-portal access between
 * Super Admin ('admin'), Brand Merchant ('brand'), and Marketplace Customer ('marketplace') tokens.
 */
export function requirePortalRole(portal: 'admin' | 'brand' | 'marketplace'): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication and valid access token required.' });
    }

    const roleCodes = request.roleCodes || [request.authUser.role];

    if (portal === 'admin') {
      if (!roleCodes.some((r) => PLATFORM_ADMIN_ROLE_CODES.has(r))) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Super Admin portal access requires a valid platform administrator role.',
        });
      }
      return;
    }

    if (portal === 'brand') {
      const isBrandMember = roleCodes.some((r) => BRAND_MEMBER_ROLE_CODES.has(r));
      const isAuthorizedViewAs = Boolean(request.viewAsSession) && roleCodes.some((r) => PLATFORM_ADMIN_ROLE_CODES.has(r));
      if (!isBrandMember && !isAuthorizedViewAs) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Brand dashboard endpoints require an authenticated brand merchant account.',
        });
      }
      return;
    }

    if (portal === 'marketplace' && !roleCodes.includes('CUSTOMER')) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Marketplace customer endpoint requires a customer account.',
      });
    }
  };
}

export function createAdminMiddleware(...extraGuards: preHandlerHookHandler[]): preHandlerHookHandler[] {
  return [authenticateToken, requirePortalRole('admin'), ...extraGuards];
}

export function createBrandMiddleware(...extraGuards: preHandlerHookHandler[]): preHandlerHookHandler[] {
  return [authenticateToken, requirePortalRole('brand'), tenantScopeGuard, ...extraGuards];
}

/**
 * Registers an ordered middleware chain on an encapsulated Fastify plugin scope.
 */
export function registerScopedPreHandlers(app: FastifyInstance, guards: preHandlerHookHandler[]): void {
  for (const guard of guards) {
    app.addHook('preHandler', guard);
  }
}
