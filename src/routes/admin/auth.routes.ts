import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loginThrottle } from '../../infrastructure/rate_limiting.js';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requirePortalRole } from '../../infrastructure/auth.guard.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { PLATFORM_ADMIN_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
import {
  issuePortalAuthSession,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
  verifyGoogleIdToken,
} from '../auth/auth.service.js';
import { randomBytes } from 'node:crypto';
import { getValidatedEnv } from '../../infrastructure/env.schema.js';

/** The only emails that may become super admin: SEED_ADMIN_EMAIL, plus optional SUPER_ADMIN_EMAILS (comma-separated). */
function allowedAdminEmails(): Set<string> {
  const raw = [process.env.SEED_ADMIN_EMAIL || '', ...(process.env.SUPER_ADMIN_EMAILS || '').split(',')];
  return new Set(raw.map((e) => e.trim().toLowerCase()).filter(Boolean));
}

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
    const lockedFor = loginThrottle.lockedFor('admin', email);
    if (lockedFor > 0) {
      reply.header('Retry-After', String(lockedFor));
      return reply.status(429).send({
        error: 'TooManyRequests',
        code: 'ACCOUNT_TEMPORARILY_LOCKED',
        message: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      });
    }
    const user = db.getUserByEmail(email);
    if (!user || !db.verifyPassword(password, user.passwordHash)) {
      loginThrottle.recordFailure('admin', email);
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid super-admin credentials.' });
    }
    loginThrottle.clear('admin', email);

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

  // Tells the sign-in page whether Google sign-in is available (the client ID is public by design).
  app.get('/api/v1/admin/auth/google-config', async () => {
    const clientId = getValidatedEnv().GOOGLE_CLIENT_ID.trim();
    return { enabled: Boolean(clientId) && allowedAdminEmails().size > 0, googleClientId: clientId || null };
  });

  // Super Admin Google sign-in: a verified Google account whose email is listed in .env
  app.post('/api/v1/admin/auth/oauth-google', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const idToken = typeof body.idToken === 'string' ? body.idToken : '';

    // Without a configured client ID the token audience cannot be checked, so refuse rather than trust any Google token.
    if (!getValidatedEnv().GOOGLE_CLIENT_ID.trim() || allowedAdminEmails().size === 0) {
      return reply.status(503).send({
        error: 'GoogleNotConfigured',
        message: 'Google sign-in is not set up on the server (GOOGLE_CLIENT_ID and SEED_ADMIN_EMAIL).',
      });
    }

    const verified = await verifyGoogleIdToken(idToken, undefined, 'Platform Super Admin');
    if (!verified.ok) {
      return reply.status(verified.status).send({ error: verified.error, message: verified.message });
    }
    const { email, name } = verified.profile;

    const lockedFor = loginThrottle.lockedFor('admin', email);
    if (lockedFor > 0) {
      reply.header('Retry-After', String(lockedFor));
      return reply.status(429).send({
        error: 'TooManyRequests',
        code: 'ACCOUNT_TEMPORARILY_LOCKED',
        message: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      });
    }

    const denied = () => {
      loginThrottle.recordFailure('admin', email);
      return reply.status(403).send({
        error: 'Forbidden',
        code: 'NOT_AN_ADMIN',
        message: 'This Google account is not authorised for the Super Admin console.',
      });
    };
    if (!allowedAdminEmails().has(email)) return denied();

    let user = db.getUserByEmail(email);
    if (user && !PLATFORM_ADMIN_ROLE_CODES.has(user.role)) return denied();

    if (!user) {
      const now = Date.now();
      user = db.createUser({
        id: db.getUserById('user_admin') ? `user_admin_${Math.random().toString(36).slice(2, 8)}` : 'user_admin',
        name,
        email,
        passwordHash: `disabled$${randomBytes(24).toString('base64url')}`,
        role: 'SUPER_ADMIN',
        emailVerified: true,
        emailVerifiedAt: now,
        createdAt: now,
      });
    } else if (!user.emailVerified) {
      user = db.updateUser(user.id, { emailVerified: true, emailVerifiedAt: Date.now() }) || user;
    }
    loginThrottle.clear('admin', email);

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'admin',
      user,
      (request.headers['user-agent'] as string) || 'Admin Console (Google)',
    );

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_LOGIN',
      entity: 'Platform',
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { email: user.email, sessionId: issued.session.id, provider: 'google_oauth' },
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
