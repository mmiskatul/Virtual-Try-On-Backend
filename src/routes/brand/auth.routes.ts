import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { Tenant } from '../../domain/types.js';
import { createUserSession } from '../../modules/auth/jwt.verifier.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { BRAND_MEMBER_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
import {
  dispatchVerificationForUser,
  extractRequestOrigin,
  isValidEmail,
  normalizeEmail,
  registerSharedAuthRoutes,
  sanitizePublicUser,
  validateStrongPassword,
} from '../auth/auth.service.js';

export async function brandAuthRoutes(app: FastifyInstance) {
  // Brand Registration (with Email Verification)
  app.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const brandName = typeof body.brandName === 'string' ? body.brandName.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug : '';
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';

    if (!brandName || !rawEmail || !password || !ownerName) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'All fields (brandName, email, password, ownerName) are required.',
      });
    }

    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Please provide a valid business email address.',
      });
    }

    const passwordError = validateStrongPassword(password);
    if (passwordError) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: passwordError,
      });
    }

    // The storefront slug is generated from the brand name; a number is appended if it is taken.
    const slugify = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const baseSlug = slugify(slug || brandName).slice(0, 50).replace(/-$/, '') || 'brand';
    let cleanSlug = baseSlug.length >= 2 ? baseSlug : `${baseSlug}-brand`;
    if (slug && db.getTenantBySlug(cleanSlug)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Brand slug '${cleanSlug}' is already registered.`,
      });
    }
    for (let i = 2; db.getTenantBySlug(cleanSlug); i++) {
      cleanSlug = `${baseSlug}-${i}`;
    }

    if (db.getUserByEmail(email)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Email '${email}' is already in use.`,
      });
    }

    const now = Date.now();
    const tenantId = `tenant_${cleanSlug}_${Math.random().toString(36).substring(2, 6)}`;
    const tenant: Tenant = {
      id: tenantId,
      name: brandName,
      slug: cleanSlug,
      status: 'ACTIVE',
      contactEmail: email,
      storefrontSettings: {
        primaryColor: '#0f172a',
        accentColor: '#000000',
        announcement: 'Welcome to our brand new storefront!',
        aboutText: `Welcome to ${brandName}.`,
      },
      createdAt: now,
      updatedAt: now,
    };
    db.createTenant(tenant);

    const user = db.createUser({
      id: `user_${Math.random().toString(36).substring(2, 9)}`,
      tenantId: tenant.id,
      name: ownerName,
      email,
      passwordHash: db.hashPassword(password),
      role: 'BRAND_OWNER',
      emailVerified: false,
      createdAt: now,
    });

    const mailResult = await dispatchVerificationForUser(user, 'brand', extractRequestOrigin(request));

    db.recordAuditLog({
      tenantId: tenant.id,
      actorId: user.id,
      actorRole: user.role,
      action: 'BRAND_REGISTERED',
      entity: 'Tenant',
      entityId: tenant.id,
      details: { brandName: tenant.name, slug: tenant.slug, email: user.email },
    });

    return reply.status(201).send({
      message: 'Brand registered! Please verify your email address before signing in.',
      requiresEmailVerification: true,
      user: sanitizePublicUser(user),
      tenant,
      emailDelivered: mailResult.delivered,
      ...(!mailResult.delivered
        ? {
            warning: mailResult.error
              ? `Account created, but verification email could not be sent: ${mailResult.error}`
              : 'Account created, but the verification email could not be sent. Use "Resend verification" in a minute.',
          }
        : {}),
    });
  });

  // Brand Owner Login
  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawEmail || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Email and password are required' });
    }

    const email = normalizeEmail(rawEmail);
    const user = db.getUserByEmail(email);
    if (!user || !db.verifyPassword(password, user.passwordHash)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    if (!BRAND_MEMBER_ROLE_CODES.has(user.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Access restricted to Brand Merchant accounts. Please use the appropriate portal.',
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

    let tenant: Tenant | undefined = undefined;
    if (user.tenantId) {
      tenant = db.getTenantById(user.tenantId);
      if (tenant && tenant.status !== 'ACTIVE') {
        return reply.status(403).send({
          error: 'TenantSuspended',
          message: 'Your brand account has been suspended by platform administration.',
        });
      }
    }

    if (!user.passwordHash.startsWith('scrypt$')) {
      db.updateUser(user.id, { passwordHash: db.hashPassword(password) });
    }

    const session = await createUserSession({
      userId: user.id,
      deviceLabel: (request.headers['user-agent'] as string) || 'Brand Dashboard',
      ipAddress: request.ip,
    });
    const token = app.jwt.sign({ userId: user.id, role: user.role, tenantId: user.tenantId, sid: session.id });

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: 'BRAND_LOGIN',
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
      tenant,
    };
  });

  // Authenticated Brand Profile / Me
  app.get('/api/v1/auth/me', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return {
      user: sanitizePublicUser(request.authUser!),
      tenant: request.tenant,
    };
  });

  // Email verification, resend, forgot password, reset password routes
  registerSharedAuthRoutes(app, '/api/v1/auth', 'brand');
}
