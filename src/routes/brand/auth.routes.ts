import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { Tenant } from '../../domain/types.js';

export async function brandAuthRoutes(app: FastifyInstance) {
  // Brand Registration
  app.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const { brandName, slug, email, password, ownerName } = body || {};

    if (!brandName || !slug || !email || !password || !ownerName) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'All fields (brandName, slug, email, password, ownerName) are required.'
      });
    }

    const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
    if (db.getTenantBySlug(cleanSlug)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Brand slug '${cleanSlug}' is already registered.`
      });
    }

    if (db.getUserByEmail(email)) {
      return reply.status(409).send({
        error: 'ConflictError',
        message: `Email '${email}' is already in use.`
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
        accentColor: '#38bdf8',
        announcement: 'Welcome to our brand new storefront!',
        aboutText: `Welcome to ${brandName}.`
      },
      createdAt: now,
      updatedAt: now
    };
    db.createTenant(tenant);

    const user = db.createUser({
      id: `user_${Math.random().toString(36).substring(2, 9)}`,
      tenantId: tenant.id,
      name: ownerName,
      email,
      passwordHash: db.hashPassword(password),
      role: 'BRAND_OWNER',
      createdAt: now
    });

    const token = app.jwt.sign({ userId: user.id, role: user.role, tenantId: tenant.id });

    return reply.status(201).send({
      message: 'Brand registered successfully',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant
    });
  });

  // Brand Owner Login
  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = (request.body as any) || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Email and password are required' });
    }

    const user = db.getUserByEmail(email);
    if (!user || user.passwordHash !== db.hashPassword(password)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    let tenant: Tenant | undefined = undefined;
    if (user.tenantId) {
      tenant = db.getTenantById(user.tenantId);
      if (tenant && tenant.status !== 'ACTIVE') {
        return reply.status(403).send({
          error: 'TenantSuspended',
          message: 'Your brand account has been suspended by platform administration.'
        });
      }
    }

    const token = app.jwt.sign({ userId: user.id, role: user.role, tenantId: user.tenantId });

    return {
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant
    };
  });

  // Authenticated Brand Profile / Me
  app.get('/api/v1/auth/me', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return {
      user: {
        id: request.authUser!.id,
        name: request.authUser!.name,
        email: request.authUser!.email,
        role: request.authUser!.role
      },
      tenant: request.tenant
    };
  });
}
