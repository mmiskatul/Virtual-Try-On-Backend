import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';

export async function brandOrderRoutes(app: FastifyInstance) {
  // Get Brand Orders
  app.get('/api/v1/brand/orders', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const orders = db.getOrdersByTenant(request.tenant!.id);
    return { orders };
  });

  // Update Order Status
  app.patch('/api/v1/brand/orders/:id/status', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { status } = (request.body as any) || {};
    const updated = db.updateOrderStatus(id, request.tenant!.id, status);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Order not found for this tenant.' });
    }
    return { message: 'Order status updated successfully', order: updated };
  });
}
