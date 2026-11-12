import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { okResponse } from '../../infrastructure/http.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { tenantScopeGuard } from '../../modules/tenants/tenant.scope.js';
import { billingCreditService } from '../../modules/billing/billing.service.js';

const SubscribeSchema = z.object({
  planSlug: z.enum(['STARTER', 'PRO', 'ENTERPRISE']),
  billingInterval: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
});

const AdminPlanUpsertSchema = z.object({
  id: z.string().min(2).max(64),
  slug: z.string().min(2).max(64).transform((s) => s.toUpperCase()),
  name: z.string().min(2).max(128),
  description: z.string().default(''),
  monthlyPrice: z.number().nonnegative(),
  annualPrice: z.number().nonnegative(),
  currency: z.string().default('BDT').transform(() => 'BDT'),
  trialDays: z.number().int().min(0).default(14),
  publicVisible: z.boolean().default(true),
  entitlements: z
    .array(
      z.object({
        featureKey: z.string().min(1),
        state: z.enum(['ENABLED', 'DISABLED', 'LIMIT']),
        limitValue: z.number().int().nullable().optional(),
      })
    )
    .default([]),
});

const CreditAdjustSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, 'Credit delta must be non-zero'),
  promo: z.boolean().default(true),
  reason: z.string().min(4).max(400),
});

export async function billingRoutes(app: FastifyInstance) {
  // Public SaaS Plan Catalog
  app.get('/api/v1/plans', async (request: FastifyRequest) => {
    const plans = await billingCreditService.listPlans(false);
    return okResponse({ plans }, request.correlationId);
  });

  // Brand: Get subscription, real-time credit account, ledger, and invoices
  app.get(
    '/api/v1/brand/billing',
    { preHandler: [authenticateToken, tenantScopeGuard, requirePermission('brand:billing', 'manage')] },
    async (request: FastifyRequest) => {
      const tenantId = request.tenant!.id;
      const [plans, credits] = await Promise.all([
        billingCreditService.listPlans(false),
        billingCreditService.getCreditBalance(tenantId),
      ]);
      const subscription = db.getSubscription(tenantId);
      const ledger = billingCreditService.getLedger(tenantId).slice(0, 50);
      const invoices = billingCreditService.getInvoices(tenantId);

      return okResponse(
        { subscription, credits, ledger, invoices, availablePlans: plans },
        request.correlationId
      );
    }
  );

  // Brand: Subscribe / Upgrade Plan
  app.post(
    '/api/v1/brand/billing/subscribe',
    { preHandler: [authenticateToken, tenantScopeGuard, requirePermission('brand:billing', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SubscribeSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const res = await billingCreditService.changeTenantPlan({
        tenantId: request.tenant!.id,
        planSlug: parsed.data.planSlug,
        billingInterval: parsed.data.billingInterval,
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        correlationId: request.correlationId,
      });
      return okResponse(res, request.correlationId);
    }
  );

  // Admin: Plans CRUD
  app.get(
    '/api/v1/admin/plans',
    { preHandler: [authenticateToken, requirePermission('plans', 'read')] },
    async (request: FastifyRequest) => {
      const plans = await billingCreditService.listPlans(true);
      return okResponse({ plans }, request.correlationId);
    }
  );

  app.post(
    '/api/v1/admin/plans',
    { preHandler: [authenticateToken, requirePermission('plans', 'write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = AdminPlanUpsertSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const plan = await billingCreditService.upsertPlan(
        parsed.data,
        request.authUser!.id,
        request.authUser!.role,
        request.correlationId
      );
      return reply.status(201).send(okResponse({ plan }, request.correlationId));
    }
  );

  // Admin: Subscriptions list & plan update
  app.get(
    '/api/v1/admin/subscriptions',
    { preHandler: [authenticateToken, requirePermission('billing', 'read')] },
    async (request: FastifyRequest) => {
      const tenants = db.getTenants();
      const rows = await Promise.all(
        tenants.map(async (t) => ({
          tenantId: t.id,
          tenantName: t.name,
          tenantStatus: t.status,
          subscription: db.getSubscription(t.id),
          credits: await billingCreditService.getCreditBalance(t.id),
        }))
      );
      return okResponse({ subscriptions: rows }, request.correlationId);
    }
  );

  app.patch(
    '/api/v1/admin/subscriptions/:tenantId',
    { preHandler: [authenticateToken, requirePermission('billing', 'write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = request.params as { tenantId: string };
      const parsed = SubscribeSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      if (!db.getTenantById(tenantId)) {
        return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found.' });
      }
      const res = await billingCreditService.changeTenantPlan({
        tenantId,
        planSlug: parsed.data.planSlug,
        billingInterval: parsed.data.billingInterval,
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        correlationId: request.correlationId,
      });
      return okResponse(res, request.correlationId);
    }
  );

  // Admin: Manual or Promotional Credit Adjustment with Immutable Ledger & Audit
  app.post(
    '/api/v1/admin/tenants/:id/credits/grant',
    { preHandler: [authenticateToken, requirePermission('billing', 'write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = CreditAdjustSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      if (!db.getTenantById(id)) {
        return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found.' });
      }
      const account = await billingCreditService.adjustCredits({
        tenantId: id,
        delta: parsed.data.delta,
        promo: parsed.data.promo,
        reason: parsed.data.reason,
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        correlationId: request.correlationId,
      });
      return okResponse({ account, ledger: billingCreditService.getLedger(id).slice(0, 10) }, request.correlationId);
    }
  );

  app.get(
    '/api/v1/admin/billing/ledger',
    { preHandler: [authenticateToken, requirePermission('billing', 'read')] },
    async (request: FastifyRequest) => {
      const tenantId = (request.query as any)?.tenantId;
      return okResponse(
        {
          ledger: billingCreditService.getLedger(typeof tenantId === 'string' ? tenantId : undefined).slice(0, 100),
          invoices: billingCreditService.getInvoices(typeof tenantId === 'string' ? tenantId : undefined).slice(0, 100),
        },
        request.correlationId
      );
    }
  );
}

