import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from './database.js';
import { User, Tenant, UserRole } from '../domain/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: User;
    tenant?: Tenant;
  }
}

export async function authenticateToken(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Missing or malformed Authorization header.' });
    }

    const token = authHeader.substring(7);
    const decoded = request.server.jwt.verify<any>(token);

    if (!decoded || !decoded.userId) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token payload.' });
    }

    const user = db.getUserById(decoded.userId);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'User not found or deleted.' });
    }

    request.authUser = user;

    if (user.tenantId) {
      const tenant = db.getTenantById(user.tenantId);
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Tenant organization not found.' });
      }
      if (tenant.status === 'SUSPENDED') {
        return reply.status(403).send({ error: 'TenantSuspended', message: 'Tenant organization is currently suspended.' });
      }
      request.tenant = tenant;
    }
  } catch (err: any) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token.', details: err.message });
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authUser) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required.' });
    }
    if (!allowedRoles.includes(request.authUser.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Role '${request.authUser.role}' does not have sufficient permission for this endpoint.`
      });
    }
  };
}
