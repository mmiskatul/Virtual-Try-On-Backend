import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import {
  authenticateToken,
  registerScopedPreHandlers,
  requirePortalRole,
} from '../../infrastructure/auth.guard.js';
import { okResponse } from '../../infrastructure/http.js';
import { PLATFORM_ADMIN_ROLE_CODES, requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { adminControlPlaneService } from '../../modules/admin/control_plane.service.js';
import { billingCreditService } from '../../modules/billing/billing.service.js';

const CreateTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80),
  contactEmail: z.string().email(),
  planSlug: z.enum(['STARTER', 'PRO', 'ENTERPRISE']).default('STARTER'),
});

const UserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().max(300).optional(),
});

const CmsSaveSchema = z.object({
  id: z.string().optional(),
  slug: z.string().min(2).max(120),
  type: z.string().min(2).max(64).default('PAGE'),
  title: z.string().min(2).max(255),
  summary: z.string().max(1000).optional(),
  body: z.unknown().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
  sortOrder: z.number().int().default(0),
});

const TicketCreateSchema = z.object({
  tenantId: z.string().optional(),
  requesterName: z.string().min(2),
  requesterEmail: z.string().email(),
  subject: z.string().min(3),
  category: z.string().default('GENERAL'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  message: z.string().min(3),
});

const RefundCreateSchema = z.object({
  orderId: z.string().min(1),
  tenantId: z.string().min(1),
  amount: z.number().positive(),
  reason: z.string().min(4),
});

const WebhookCreateSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  tenantId: z.string().optional(),
});

export async function adminControlPlaneRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, [authenticateToken, requirePortalRole('admin')]);

  // Unified Super Admin Control Plane Hydration Snapshot
  app.get(
    '/api/v1/admin/control-plane/snapshot',
    { preHandler: [authenticateToken, requirePermission('tenants', 'read')] },
    async (request: FastifyRequest) => {
      const snapshot = await adminControlPlaneService.getFullSnapshot();
      return okResponse(snapshot, request.correlationId);
    }
  );

  // Create Tenant directly from Super Admin console
  app.post(
    '/api/v1/admin/tenants',
    { preHandler: [authenticateToken, requirePermission('tenants', 'write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTenantSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const res = await adminControlPlaneService.createTenantAsAdmin({
        ...parsed.data,
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        correlationId: request.correlationId,
      });
      if (!res.ok) {
        return reply.status(409).send({ error: res.error, message: res.message });
      }
      return reply.status(201).send(okResponse(res, request.correlationId));
    }
  );

  // Platform Users & Session Governance
  app.get(
    '/api/v1/admin/users',
    { preHandler: [authenticateToken, requirePermission('users', 'read')] },
    async (request: FastifyRequest) => {
      const users = await adminControlPlaneService.listUsers();
      return okResponse({ users }, request.correlationId);
    }
  );

  app.get(
    '/api/v1/admin/staff',
    { preHandler: [authenticateToken, requirePermission('staff', 'manage')] },
    async (request: FastifyRequest) => {
      const allUsers = await adminControlPlaneService.listUsers();
      const staff = allUsers.filter((u: { role: string }) => PLATFORM_ADMIN_ROLE_CODES.has(u.role));
      return okResponse({ staff }, request.correlationId);
    }
  );

  app.patch(
    '/api/v1/admin/users/:id/status',
    { preHandler: [authenticateToken, requirePermission('users', 'suspend')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = UserStatusSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const updated = await adminControlPlaneService.setUserStatus({
        userId: id,
        status: parsed.data.status,
        reason: parsed.data.reason,
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        correlationId: request.correlationId,
      });
      if (!updated) return reply.status(404).send({ error: 'NotFound', message: 'User not found.' });
      return okResponse({ user: updated }, request.correlationId);
    }
  );

  // Finance Overview & Refunds
  app.get(
    '/api/v1/admin/finance',
    { preHandler: [authenticateToken, requirePermission('billing', 'read')] },
    async (request: FastifyRequest) => {
      const orders = db.getOrders();
      const gmv = orders.filter((o) => o.paymentStatus === 'PAID').reduce((sum, o) => sum + o.totalAmount, 0);
      return okResponse(
        {
          summary: { gmv, totalOrders: orders.length },
          transactions: orders,
          invoices: billingCreditService.getInvoices(),
          refunds: adminControlPlaneService.listRefunds(),
        },
        request.correlationId
      );
    }
  );

  app.post(
    '/api/v1/admin/finance/refunds',
    { preHandler: [authenticateToken, requirePermission('billing', 'refund')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefundCreateSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const refund = await adminControlPlaneService.createRefund(parsed.data, request.authUser!.id, request.authUser!.role);
      return reply.status(201).send(okResponse({ refund }, request.correlationId));
    }
  );

  // AI Models & Routing Policy
  app.get(
    '/api/v1/admin/ai/models',
    { preHandler: [authenticateToken, requirePermission('ai', 'read')] },
    async (request: FastifyRequest) => {
      return okResponse(adminControlPlaneService.getAiModelsAndRouting(), request.correlationId);
    }
  );

  app.patch(
    '/api/v1/admin/ai/models/:id',
    { preHandler: [authenticateToken, requirePermission('ai', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as { active?: boolean; isDefault?: boolean }) || {};
      const model = await adminControlPlaneService.updateAiModel(
        id,
        body,
        request.authUser!.id,
        request.authUser!.role,
        request.correlationId
      );
      if (!model) return reply.status(404).send({ error: 'NotFound', message: 'AI model not found.' });
      return okResponse({ model }, request.correlationId);
    }
  );

  app.put(
    '/api/v1/admin/ai/routing',
    { preHandler: [authenticateToken, requirePermission('ai', 'manage')] },
    async (request: FastifyRequest) => {
      const body = (request.body as Record<string, any>) || {};
      const routing = await adminControlPlaneService.updateAiRouting(
        body,
        request.authUser!.id,
        request.authUser!.role,
        request.correlationId
      );
      return okResponse({ routing }, request.correlationId);
    }
  );

  // Marketplace Moderation Queue
  app.get(
    '/api/v1/admin/moderation/products',
    { preHandler: [authenticateToken, requirePermission('moderation', 'read')] },
    async (request: FastifyRequest) => {
      const items = await adminControlPlaneService.listModerationQueue();
      return okResponse({ items }, request.correlationId);
    }
  );

  // CMS Content Blocks
  app.get(
    '/api/v1/admin/cms',
    { preHandler: [authenticateToken, requirePermission('cms', 'manage')] },
    async (request: FastifyRequest) => {
      return okResponse({ pages: adminControlPlaneService.listCmsPages() }, request.correlationId);
    }
  );

  app.post(
    '/api/v1/admin/cms',
    { preHandler: [authenticateToken, requirePermission('cms', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CmsSaveSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const page = await adminControlPlaneService.saveCmsPage(parsed.data, request.authUser!.id, request.authUser!.role);
      return reply.status(201).send(okResponse({ page }, request.correlationId));
    }
  );

  // Support Tickets
  app.get(
    '/api/v1/admin/support/tickets',
    { preHandler: [authenticateToken, requirePermission('support', 'read')] },
    async (request: FastifyRequest) => {
      return okResponse({ tickets: adminControlPlaneService.listSupportTickets() }, request.correlationId);
    }
  );

  app.post(
    '/api/v1/admin/support/tickets',
    { preHandler: [authenticateToken, requirePermission('support', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = TicketCreateSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const ticket = await adminControlPlaneService.createSupportTicket(parsed.data);
      return reply.status(201).send(okResponse({ ticket }, request.correlationId));
    }
  );

  app.patch(
    '/api/v1/admin/support/tickets/:id',
    { preHandler: [authenticateToken, requirePermission('support', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};
      const updated = await adminControlPlaneService.replyOrUpdateTicket(
        id,
        body,
        request.authUser!.name,
        request.authUser!.role
      );
      if (!updated) return reply.status(404).send({ error: 'NotFound', message: 'Support ticket not found.' });
      return okResponse({ ticket: updated }, request.correlationId);
    }
  );

  // Feature Flags, Webhooks, Data Governance & Platform Settings
  app.get(
    '/api/v1/admin/feature-flags',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest) => {
      return okResponse({ featureFlags: adminControlPlaneService.listFeatureFlags() }, request.correlationId);
    }
  );

  app.patch(
    '/api/v1/admin/feature-flags/:key',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { key } = request.params as { key: string };
      const body = (request.body as any) || {};
      const flag = await adminControlPlaneService.updateFeatureFlag(
        key,
        body,
        request.authUser!.id,
        request.authUser!.role
      );
      if (!flag) return reply.status(404).send({ error: 'NotFound', message: 'Feature flag not found.' });
      return okResponse({ flag }, request.correlationId);
    }
  );

  app.get(
    '/api/v1/admin/webhooks',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest) => {
      return okResponse({ webhooks: adminControlPlaneService.listWebhooks() }, request.correlationId);
    }
  );

  app.post(
    '/api/v1/admin/webhooks',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = WebhookCreateSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const webhook = await adminControlPlaneService.addWebhook(parsed.data, request.authUser!.id, request.authUser!.role);
      return reply.status(201).send(okResponse({ webhook }, request.correlationId));
    }
  );

  app.get(
    '/api/v1/admin/governance/requests',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest) => {
      return okResponse({ requests: adminControlPlaneService.listGovernanceRequests() }, request.correlationId);
    }
  );

  app.patch(
    '/api/v1/admin/governance/requests/:id',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { status } = (request.body as any) || {};
      const updated = await adminControlPlaneService.updateGovernanceRequest(
        id,
        status,
        request.authUser!.id,
        request.authUser!.role
      );
      if (!updated) return reply.status(404).send({ error: 'NotFound', message: 'Governance request not found.' });
      return okResponse({ request: updated }, request.correlationId);
    }
  );

  app.get(
    '/api/v1/admin/settings',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest) => {
      return okResponse({ settings: adminControlPlaneService.getSettings() }, request.correlationId);
    }
  );

  app.put(
    '/api/v1/admin/settings',
    { preHandler: [authenticateToken, requirePermission('security', 'manage')] },
    async (request: FastifyRequest) => {
      const updated = await adminControlPlaneService.updateSettings(
        (request.body as Record<string, unknown>) || {},
        request.authUser!.id,
        request.authUser!.role
      );
      return okResponse({ settings: updated }, request.correlationId);
    }
  );
}
