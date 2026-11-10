import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { User } from '../../domain/types.js';
import {
  dispatchVerificationForUser,
  isValidEmail,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
  validateStrongPassword,
} from '../auth/auth.service.js';

export async function customerAuthRoutes(app: FastifyInstance) {
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
    const mailResult = await dispatchVerificationForUser(created, 'marketplace');

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

    const token = app.jwt.sign({ userId: user.id, role: user.role, email: user.email });
    return {
      message: 'Login successful',
      token,
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
