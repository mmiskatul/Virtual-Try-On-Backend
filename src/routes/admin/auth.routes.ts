import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requirePortalRole } from '../../infrastructure/auth.guard.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { PLATFORM_ADMIN_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
import {
  issuePortalAuthSession,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
} from '../auth/auth.service.js';

export async function adminAuthRoutes(app: FastifyInstance) {
  // Super Admin Login
  app.post('/api/v1/admin/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawEmail || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Email and password are required.' });
    }

    const email = normalizeEmail(rawEmail);
    const user = db.getUserByEmail(email);
    if (!user || !db.verifyPassword(password, user.passwordHash)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid super-admin credentials.' });
    }

    if (!PLATFORM_ADMIN_ROLE_CODES.has(user.role)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Access restricted to Platform Super Admins only.' });
    }

    if (!user.emailVerified) {
      return reply.status(403).send({
        error: 'EmailNotVerified',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your administrator email address before signing in.',
        email: user.email,
      });
    }

    if (!user.passwordHash.startsWith('scrypt$')) {
      db.updateUser(user.id, { passwordHash: db.hashPassword(password) });
    }

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'admin',
      user,
      (request.headers['user-agent'] as string) || 'Admin Console',
    );

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_LOGIN',
      entity: 'Platform',
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { email: user.email, sessionId: issued.session.id },
    });

    return {
      message: 'Super Admin authentication successful',
      ...issued.responseFields,
      admin: sanitizePublicUser(user),
    };
  });

  // Authenticated Super Admin Profile / Me
  app.get(
    '/api/v1/admin/auth/me',
    { preHandler: [authenticateToken, requirePortalRole('admin')] },
    async (request: FastifyRequest) => {
      return {
        admin: sanitizePublicUser(request.authUser!),
      };
    }
  );

  // Email verification, resend, forgot password, reset password routes for Super Admin portal
  registerSharedAuthRoutes(app, '/api/v1/admin/auth', 'admin');
}
