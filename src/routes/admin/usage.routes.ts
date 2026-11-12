import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createAdminMiddleware, registerScopedPreHandlers, requireRole } from '../../infrastructure/auth.guard.js';

const guards = createAdminMiddleware(requireRole('SUPER_ADMIN'));
const PLANS = ['STARTER', 'PRO', 'ENTERPRISE'];

function limitParam(raw: unknown, fallback = 100): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : fallback;
}

export async function adminUsageRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, guards);

  // Per-shop quota, usage and generation outcome summary
  app.get('/api/v1/admin/usage', { preHandler: guards }, async () => {
    const jobs = db.getAllGenerations();
    const ledger = db.getAllUsageLedger();
    return db.getTenants().map(t => {
      const sub = db.getSubscription(t.id);
      const tJobs = jobs.filter(j => j.tenantId === t.id);
      const tLedger = ledger.filter(l => l.tenantId === t.id);
      const quota = sub?.tryOnMonthlyQuota ?? 0;
      const used = sub?.tryOnUsed ?? 0;
      return {
        tenantId: t.id,
        name: t.name,
        tenantStatus: t.status,
        plan: sub?.plan ?? null,
        subscriptionStatus: sub?.status ?? null,
        productLimit: sub?.productLimit ?? 0,
        quota,
        used,
        remaining: Math.max(0, quota - used),
        percentUsed: quota > 0 ? Math.round((used / quota) * 100) : 0,
        generations: {
          total: tJobs.length,
          queued: tJobs.filter(j => j.status === 'QUEUED').length,
          processing: tJobs.filter(j => j.status === 'PROCESSING').length,
          completed: tJobs.filter(j => j.status === 'COMPLETED').length,
          failed: tJobs.filter(j => j.status === 'FAILED').length
        },
        ledger: {
          reserved: tLedger.filter(l => l.status === 'RESERVED').length,
          consumed: tLedger.filter(l => l.status === 'CONSUMED').length,
          released: tLedger.filter(l => l.status === 'RELEASED').length
        }
      };
    });
  });

  // Recent generation jobs (never exposes the session access-token hash)
  app.get('/api/v1/admin/generations', { preHandler: guards }, async (request: FastifyRequest) => {
    const q = request.query as any;
    const tenantId = typeof q.tenantId === 'string' ? q.tenantId : undefined;
    return db.getAllGenerations()
      .filter(j => (tenantId ? j.tenantId === tenantId : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limitParam(q.limit))
      .map(({ accessTokenHash, idempotencyKey, ...safe }) => safe);
  });

  // Usage ledger entries
  app.get('/api/v1/admin/usage-ledger', { preHandler: guards }, async (request: FastifyRequest) => {
    const q = request.query as any;
    const tenantId = typeof q.tenantId === 'string' ? q.tenantId : undefined;
    return db.getAllUsageLedger()
      .filter(l => (tenantId ? l.tenantId === tenantId : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limitParam(q.limit));
  });

  // Change a shop's plan / quota (audited)
  app.patch('/api/v1/admin/tenants/:id/plan', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    const sub = db.getSubscription(id);
    if (!db.getTenantById(id) || !sub) {
      return reply.status(404).send({ error: 'NotFound', message: 'Tenant or subscription not found.' });
    }

    const updates: any = {};
    if (body.plan !== undefined) {
      if (!PLANS.includes(body.plan)) {
        return reply.status(400).send({ error: 'ValidationError', message: `plan must be one of ${PLANS.join(', ')}.` });
      }
      updates.plan = body.plan;
    }
    for (const field of ['tryOnMonthlyQuota', 'productLimit'] as const) {
      if (body[field] !== undefined) {
        const n = body[field];
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
          return reply.status(400).send({ error: 'ValidationError', message: `${field} must be an integer between 0 and 1,000,000.` });
        }
        updates[field] = n;
      }
    }
    if (body.status !== undefined) {
      if (!['ACTIVE', 'PAST_DUE', 'CANCELLED'].includes(body.status)) {
        return reply.status(400).send({ error: 'ValidationError', message: "status must be 'ACTIVE', 'PAST_DUE' or 'CANCELLED'." });
      }
      updates.status = body.status;
    }
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'ValidationError', message: 'No valid fields to update.' });
    }

    const before = { plan: sub.plan, tryOnMonthlyQuota: sub.tryOnMonthlyQuota, productLimit: sub.productLimit, status: sub.status };
    const updated = db.updateSubscription(id, updates);

    db.recordAuditLog({
      tenantId: id,
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      action: 'PLAN_CHANGED',
      entity: 'Subscription',
      entityId: id,
      details: { before, after: updates }
    });

    return { message: 'Subscription updated.', subscription: updated };
  });
}
