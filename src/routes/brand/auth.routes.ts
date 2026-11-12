import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requirePortalRole } from '../../infrastructure/auth.guard.js';
import { Tenant } from '../../domain/types.js';
import { createOAuthExchangeCode } from '../../modules/auth/jwt.verifier.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { BRAND_MEMBER_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
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

function slugifyBrandName(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateUniqueBrandSlug(
  brandName: string,
  explicitSlug?: string,
): { slug: string; conflict: boolean } {
  const baseSlug = slugifyBrandName(explicitSlug || brandName).slice(0, 50).replace(/-$/, '') || 'brand';
  let cleanSlug = baseSlug.length >= 2 ? baseSlug : `${baseSlug}-brand`;
  if (explicitSlug && db.getTenantBySlug(cleanSlug)) {
    return { slug: cleanSlug, conflict: true };
  }
  for (let i = 2; db.getTenantBySlug(cleanSlug); i++) {
    cleanSlug = `${baseSlug}-${i}`;
  }
  return { slug: cleanSlug, conflict: false };
}

function createBrandTenantRecord(brandName: string, contactEmail: string, explicitSlug?: string): Tenant {
  const now = Date.now();
  const { slug: cleanSlug } = generateUniqueBrandSlug(brandName, explicitSlug);
  const tenantId = `tenant_${cleanSlug}_${Math.random().toString(36).substring(2, 6)}`;
  const tenant: Tenant = {
    id: tenantId,
    name: brandName,
    slug: cleanSlug,
    status: 'ACTIVE',
    contactEmail,
    storefrontSettings: {
      primaryColor: '#0f172a',
      accentColor: '#000000',
      announcement: 'Welcome to our brand new storefront!',
      aboutText: `Welcome to ${brandName}.`,
    },
    createdAt: now,
    updatedAt: now,
  };
  return db.createTenant(tenant);
}

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
    const slugResolution = generateUniqueBrandSlug(brandName, slug || undefined);
    if (slugResolution.conflict) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Brand slug '${slugResolution.slug}' is already registered.`,
      });
    }

    if (db.getUserByEmail(email)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Email '${email}' is already in use.`,
      });
    }

    const now = Date.now();
    const tenant = createBrandTenantRecord(brandName, email, slug || undefined);

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

    if (!mailResult.delivered) {
      db.deleteUser(user.id);
      db.deleteTenant(tenant.id);
      return reply.status(502).send({
        error: 'EmailDeliveryFailed',
        message: mailResult.error
          ? `Verification email could not be sent: ${mailResult.error}`
          : 'Verification email could not be sent right now. Please try again shortly.',
      });
    }

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
      emailDelivered: true,
    });
  });

  // Google OAuth Brand Merchant Sync (verified via Google OIDC id_token)
  app.post('/api/v1/auth/oauth-google', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const idToken = typeof body.idToken === 'string' ? body.idToken : '';
    const verified = await verifyGoogleIdToken(
      idToken,
      typeof body.name === 'string' ? body.name : undefined,
      'Brand Owner',
    );
    if (!verified.ok) {
      return reply.status(verified.status).send({ error: verified.error, message: verified.message });
    }

    const { email, name } = verified.profile;
    let user = db.getUserByEmail(email);

    if (user && !BRAND_MEMBER_ROLE_CODES.has(user.role)) {
      return reply.status(403).send({
        error: 'PortalMismatch',
        message: 'This email address is already in use under another account type. Please use a different Google account or business email.',
      });
    }

    let tenant: Tenant | undefined = undefined;
    let isNewBrand = false;

    if (!user) {
      const requestedBrandName =
        typeof body.brandName === 'string' && body.brandName.trim().length >= 2
          ? body.brandName.trim().slice(0, 80)
          : `${name} Studio`;
      tenant = createBrandTenantRecord(requestedBrandName, email);
      const now = Date.now();
      user = db.createUser({
        id: `user_brand_${Math.random().toString(36).substring(2, 9)}`,
        tenantId: tenant.id,
        name,
        email,
        passwordHash: db.hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'BRAND_OWNER',
        emailVerified: true,
        emailVerifiedAt: now,
        createdAt: now,
      });
      isNewBrand = true;
    } else {
      if (user.tenantId) {
        tenant = db.getTenantById(user.tenantId);
        if (tenant && tenant.status !== 'ACTIVE') {
          return reply.status(403).send({
            error: 'TenantSuspended',
            message: 'Your brand account has been suspended by platform administration.',
          });
        }
      }
      if (!tenant) {
        tenant = createBrandTenantRecord(`${name} Studio`, email);
        user =
          db.updateUser(user.id, {
            tenantId: tenant.id,
            ...(user.emailVerified ? {} : { emailVerified: true, emailVerifiedAt: Date.now() }),
          }) || user;
      } else if (!user.emailVerified) {
        user = db.updateUser(user.id, { emailVerified: true, emailVerifiedAt: Date.now() }) || user;
      }
    }

    const deviceLabel = (request.headers['user-agent'] as string) || 'Google OAuth Web';
    const issued = await issuePortalAuthSession(request, reply, 'brand', user, deviceLabel);
    const oauthExchangeCode = await createOAuthExchangeCode({
      userId: user.id,
      portal: 'brand',
      deviceLabel,
      ipAddress: request.ip,
    });

    if (isNewBrand) {
      await recordAudit({
        actorId: user.id,
        actorRole: user.role,
        tenantId: tenant.id,
        action: 'BRAND_REGISTERED',
        entity: 'Tenant',
        entityId: tenant.id,
        correlationId: request.correlationId,
        ipAddress: request.ip,
        details: { brandName: tenant.name, slug: tenant.slug, email: user.email, provider: 'google_oauth' },
      });
    }

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: 'BRAND_LOGIN',
      entity: 'User',
      entityId: user.id,
      correlationId: request.correlationId,
      ipAddress: request.ip,
      details: { sessionId: issued.session.id, provider: 'google_oauth' },
    });

    return {
      message: 'Google login successful',
      ...issued.responseFields,
      oauthExchangeCode,
      user: sanitizePublicUser(user),
      tenant,
      isNewBrand,
    };
  });

  // One-time cookie handoff endpoint used by NextAuth /api/auth/cookie-handoff to mint HttpOnly cookies on the browser
  app.post('/api/v1/auth/oauth-exchange', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const code = typeof body.code === 'string' ? body.code : '';
    const claimed = await claimPortalOAuthExchangeCode(code, 'brand');
    if (!claimed.ok) {
      return reply.status(claimed.status).send({ error: claimed.error, message: claimed.message });
    }

    const { user, deviceLabel } = claimed;
    if (!BRAND_MEMBER_ROLE_CODES.has(user.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Access restricted to Brand Merchant accounts.',
      });
    }

    const tenant = user.tenantId ? db.getTenantById(user.tenantId) : undefined;
    if (tenant && tenant.status !== 'ACTIVE') {
      return reply.status(403).send({
        error: 'TenantSuspended',
        message: 'Your brand account has been suspended by platform administration.',
      });
    }

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'brand',
      user,
      deviceLabel || (request.headers['user-agent'] as string) || 'Google OAuth Web',
    );

    return {
      ok: true,
      sessionId: issued.session.id,
      session: issued.responseFields.session,
      user: sanitizePublicUser(user),
      tenant,
    };
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

    const issued = await issuePortalAuthSession(
      request,
      reply,
      'brand',
      user,
      (request.headers['user-agent'] as string) || 'Brand Dashboard',
    );

    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      tenantId: user.tenantId,
      action: 'BRAND_LOGIN',
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
      tenant,
    };
  });

  // Authenticated Brand Profile / Me
  app.get('/api/v1/auth/me', { preHandler: [authenticateToken, requirePortalRole('brand')] }, async (request: FastifyRequest) => {
    return {
      user: sanitizePublicUser(request.authUser!),
      tenant: request.tenant,
    };
  });

  // Email verification, resend, forgot password, reset password routes
  registerSharedAuthRoutes(app, '/api/v1/auth', 'brand');
}
