import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { User } from '../../domain/types.js';
import { createUserSession } from '../../modules/auth/jwt.verifier.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  dispatchVerificationForUser,
  extractRequestOrigin,
  isValidEmail,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
  validateStrongPassword,
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
        message: 'This email belongs to a Brand or Admin account. Please sign in on that portal.',
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
    const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
    if (!idToken) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Valid Google ID token is required.' });
    }

    let tokenInfo: Record<string, any>;
    try {
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!verifyRes.ok) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid Google ID token.' });
      }
      tokenInfo = (await verifyRes.json()) as Record<string, any>;
    } catch {
      return reply.status(502).send({ error: 'UpstreamError', message: 'Unable to verify Google ID token.' });
    }

    const expectedClientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (expectedClientId && tokenInfo.aud !== expectedClientId) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Google token audience mismatch.' });
    }

    const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === 'true';
    const email = typeof tokenInfo.email === 'string' ? normalizeEmail(tokenInfo.email) : '';
    const name =
      (typeof tokenInfo.name === 'string' && tokenInfo.name.trim()) ||
      (typeof body.name === 'string' && body.name.trim()) ||
      email.split('@')[0] ||
      'Customer';
    if (!emailVerified || !email || !isValidEmail(email)) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Verified Google email required.' });
    }

    let user = db.getUserByEmail(email);
    if (user && user.role !== 'CUSTOMER') {
      return reply.status(403).send({
        error: 'PortalMismatch',
        message: 'This email belongs to a Brand or Admin account. Please sign in on that portal.',
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

    const session = await createUserSession({
      userId: user.id,
      deviceLabel: 'Google OAuth Web',
      ipAddress: request.ip,
    });
    const token = app.jwt.sign({ userId: user.id, role: user.role, email: user.email, sid: session.id });
    return { token, sessionId: session.id, user: sanitizePublicUser(user) };
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
      emailDelivered: mailResult.delivered,
      ...(!mailResult.delivered ? { warning: 'Account created, but the verification email could not be sent. Use "Resend verification" in a minute.' } : {}),
      ...(mailResult.preview ? { devPreview: mailResult.preview } : {}),
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
        message: 'This account belongs to a Brand or Admin portal. Please sign in on that portal.',
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

    const session = await createUserSession({
      userId: user.id,
      deviceLabel: (request.headers['user-agent'] as string) || 'Marketplace Web',
      ipAddress: request.ip,
    });
    const token = app.jwt.sign({ userId: user.id, role: user.role, email: user.email, sid: session.id });

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'CUSTOMER_LOGIN',
      entity: 'User',
      entityId: user.id,
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { sessionId: session.id },
    });

    return {
      message: 'Login successful',
      token,
      sessionId: session.id,
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
