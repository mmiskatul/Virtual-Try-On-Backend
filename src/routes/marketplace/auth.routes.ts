import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { User } from '../../domain/types.js';
import { createOAuthExchangeCode } from '../../modules/auth/jwt.verifier.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  claimPortalOAuthExchangeCode,
  dispatchVerificationForUser,
  extractRequestOrigin,
  issuePortalAuthSession,
  isValidEmail,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
  validateStrongPassword,
  verifyGoogleIdToken,
} from '../auth/auth.service.js';

export async function customerAuthRoutes(app: FastifyInstance) {
  // Email existence probe for unified two-option (Google + Email -> Sign In or Create Account) flow
  app.post('/api/v1/marketplace/auth/check-email', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const email = normalizeEmail(rawEmail);
    if (!email || !isValidEmail(email)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Please enter a valid email address.',
      });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
      return { exists: false, email, emailVerified: false };
    }
    if (user.role !== 'CUSTOMER') {
      return {
        exists: true,
        portalMismatch: true,
        email,
        message: 'This email address is already in use. Please use a different email address.',
      };
    }

    return {
      exists: true,
      email: user.email,
      name: user.name,
      emailVerified: Boolean(user.emailVerified),
    };
  });

  // Google OAuth Customer Sync (verified directly via Google OIDC id_token)
  app.post('/api/v1/marketplace/auth/oauth-google', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const idToken = typeof body.idToken === 'string' ? body.idToken : '';
    const verified = await verifyGoogleIdToken(
      idToken,
      typeof body.name === 'string' ? body.name : undefined,
      'Customer',
    );
    if (!verified.ok) {
      return reply.status(verified.status).send({ error: verified.error, message: verified.message });
    }

    const { email, name } = verified.profile;
    let user = db.getUserByEmail(email);
    if (user && user.role !== 'CUSTOMER') {
      return reply.status(403).send({
        error: 'PortalMismatch',
        message: 'This email address is already in use. Please use a different Google account or email address.',
      });
    }
    if (!user) {
      user = db.createUser({
        id: `user_cust_${Math.random().toString(36).substring(2, 9)}`,
        name,
        email,
        passwordHash: db.hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'CUSTOMER',
        emailVerified: true,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      });
    } else if (!user.emailVerified) {
      user = db.updateUser(user.id, { emailVerified: true, emailVerifiedAt: Date.now() }) || user;
    }

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'marketplace',
      user,
      (request.headers['user-agent'] as string) || 'Google OAuth Web',
    );
    const oauthExchangeCode = await createOAuthExchangeCode({
      userId: user.id,
      portal: 'marketplace',
      deviceLabel: (request.headers['user-agent'] as string) || 'Google OAuth Web',
      ipAddress: request.ip,
    });
    return {
      ...issued.responseFields,
      oauthExchangeCode,
      user: sanitizePublicUser(user),
    };
  });

  // One-time cookie handoff endpoint used by NextAuth /api/auth/cookie-handoff to mint HttpOnly cookies on the browser
  app.post('/api/v1/marketplace/auth/oauth-exchange', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const code = typeof body.code === 'string' ? body.code : '';
    const claimed = await claimPortalOAuthExchangeCode(code, 'marketplace');
    if (!claimed.ok) {
      return reply.status(claimed.status).send({ error: claimed.error, message: claimed.message });
    }

    const { user, deviceLabel } = claimed;
    if (user.role !== 'CUSTOMER') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Customer account not found.' });
    }

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'marketplace',
      user,
      deviceLabel || (request.headers['user-agent'] as string) || 'Google OAuth Web',
    );

    return {
      ok: true,
      sessionId: issued.session.id,
      session: issued.responseFields.session,
      user: sanitizePublicUser(user),
    };
  });

  // Customer Registration (with Email Verification)
  app.post('/api/v1/marketplace/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!name || name.length < 2 || !rawEmail || !password) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Name (at least 2 characters), valid email, and password are required.',
      });
    }

    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Please enter a valid email address.',
      });
    }

    const passwordError = validateStrongPassword(password);
    if (passwordError) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: passwordError,
      });
    }

    if (db.getUserByEmail(email)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: 'An account with this email address already exists.',
      });
    }

    const newUser: User = {
      id: `user_cust_${Math.random().toString(36).substring(2, 9)}`,
      name,
      email,
      passwordHash: db.hashPassword(password),
      role: 'CUSTOMER',
      emailVerified: false,
      createdAt: Date.now(),
    };
    const created = db.createUser(newUser);
    const mailResult = await dispatchVerificationForUser(created, 'marketplace', extractRequestOrigin(request));

    if (!mailResult.delivered) {
      db.deleteUser(created.id);
      return reply.status(502).send({
        error: 'EmailDeliveryFailed',
        message: mailResult.error
          ? `Verification email could not be sent: ${mailResult.error}`
          : 'Verification email could not be sent right now. Please try again shortly.',
      });
    }

    db.recordAuditLog({
      actorId: created.id,
      actorRole: created.role,
      action: 'CUSTOMER_REGISTERED',
      entity: 'User',
      entityId: created.id,
      details: { email: created.email },
    });

    return reply.status(201).send({
      message: 'Account created! Please verify your email address before signing in.',
      requiresEmailVerification: true,
      user: sanitizePublicUser(created),
      emailDelivered: true,
    });
  });

  // Customer Login
  app.post('/api/v1/marketplace/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawEmail || !password) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Email and password are required.',
      });
    }

    const email = normalizeEmail(rawEmail);
    const user = db.getUserByEmail(email);
    if (!user || !db.verifyPassword(password, user.passwordHash)) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
    }

    if (user.role !== 'CUSTOMER') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'This email address is already in use. Please use a different email address.',
      });
    }

    if (!user.emailVerified) {
      return reply.status(403).send({
        error: 'EmailNotVerified',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before signing in.',
        email: user.email,
      });
    }

    // Transparently upgrade legacy SHA-256 hashes to scrypt on successful login
    if (!user.passwordHash.startsWith('scrypt$')) {
      db.updateUser(user.id, { passwordHash: db.hashPassword(password) });
    }

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'marketplace',
      user,
      (request.headers['user-agent'] as string) || 'Marketplace Web',
    );

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'CUSTOMER_LOGIN',
      entity: 'User',
      entityId: user.id,
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { sessionId: issued.session.id },
    });

    return {
      message: 'Login successful',
      ...issued.responseFields,
      user: sanitizePublicUser(user),
    };
  });

  // Authenticated Customer Profile / Me
  app.get('/api/v1/marketplace/auth/me', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return {
      user: sanitizePublicUser(request.authUser!),
    };
  });

  // Email verification, resend, forgot password, reset password routes
  registerSharedAuthRoutes(app, '/api/v1/marketplace/auth', 'marketplace');
}
