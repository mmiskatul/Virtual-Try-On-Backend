import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  DiscountCreateSchema,
  DiscountUpdateSchema,
  createDiscount,
  deleteDiscount,
  listDiscounts,
  updateDiscount,
} from '../../modules/commerce/discounts.js';
import { requireTenantContext } from './profile.service.js';

const readGuards = createBrandMiddleware(requirePermission('brand:orders', 'read'));
const writeGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

export async function brandDiscountRoutes(app: FastifyInstance) {
  app.get('/api/v1/brand/discounts', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { discounts: listDiscounts(tenant) };
  });

  app.post('/api/v1/brand/discounts', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(DiscountCreateSchema, request.body ?? {});
    const res = createDiscount(tenant, input);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'DISCOUNT_CREATED', entity: 'Discount', entityId: res.discount.id, correlationId: request.correlationId,
      details: { code: res.discount.code },
    });
    return reply.status(201).send({ discount: res.discount });
  });

  app.patch('/api/v1/brand/discounts/:id', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    const patch = parseWithSchema(DiscountUpdateSchema, request.body ?? {});
    const res = updateDiscount(tenant, id, patch);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'DISCOUNT_UPDATED', entity: 'Discount', entityId: id, correlationId: request.correlationId,
    });
    return { discount: res.discount };
  });

  app.delete('/api/v1/brand/discounts/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    if (!deleteDiscount(tenant, id)) throw new NotFoundException('Discount not found.');
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'DISCOUNT_DELETED', entity: 'Discount', entityId: id, correlationId: request.correlationId,
    });
    return { deleted: true };
  });
}
