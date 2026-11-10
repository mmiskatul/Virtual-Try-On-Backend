import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { OrderStatus } from '../../domain/types.js';

const brandGuards = [authenticateToken, requireRole('BRAND_OWNER', 'STORE_MANAGER')];
const VALID_ORDER_STATUSES: OrderStatus[] = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

export async function brandOrderRoutes(app: FastifyInstance) {
  // Get Brand Orders
  app.get('/api/v1/brand/orders', { preHandler: brandGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const orders = db.getOrdersByTenant(request.tenant.id);
    return { orders };
  });

  // Update Order Status
  app.patch('/api/v1/brand/orders/:id/status', { preHandler: brandGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const { id } = request.params as { id: string };
    const { status } = (request.body as any) || {};

    if (!status || !VALID_ORDER_STATUSES.includes(status)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: `Order status must be one of: ${VALID_ORDER_STATUSES.join(', ')}.`
      });
    }

    const updated = db.updateOrderStatus(id, request.tenant.id, status);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Order not found for this tenant.' });
    }
    return { message: 'Order status updated successfully', order: updated };
  });
}
