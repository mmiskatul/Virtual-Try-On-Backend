import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { okResponse } from '../../infrastructure/http.js';
import { tenantScopeGuard } from '../../modules/tenants/tenant.scope.js';
import { commerceEngagementService } from '../../modules/commerce/engagement.service.js';
import { adminControlPlaneService } from '../../modules/admin/control_plane.service.js';

const AddCartItemSchema = z.object({
  productId: z.string().min(1),
  sku: z.string().optional(),
  quantity: z.number().int().min(1).max(20).default(1),
});

const ReviewCreateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3).max(1500),
});

const ReviewReplySchema = z.object({
  reply: z.string().min(2).max(1000),
});

const CustomerTicketSchema = z.object({
  subject: z.string().min(3).max(255),
  category: z.string().default('ORDER_SUPPORT'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  message: z.string().min(5).max(3000),
});

export async function commerceEngagementRoutes(app: FastifyInstance) {
  // Server-Side Multi-Seller Cart
  app.get('/api/v1/cart', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const cart = commerceEngagementService.getCart(request.authUser!.id);
    return okResponse(cart, request.correlationId);
  });

  app.post('/api/v1/cart/items', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = AddCartItemSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const res = commerceEngagementService.addToCart(request.authUser!.id, parsed.data);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return okResponse(res.cart, request.correlationId);
  });

  app.delete('/api/v1/cart/items/:sku', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const { sku } = request.params as { sku: string };
    const cart = commerceEngagementService.removeFromCart(request.authUser!.id, sku);
    return okResponse(cart, request.correlationId);
  });

  // Customer / Brand Scoped Orders
  app.get('/api/v1/orders', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const orders = commerceEngagementService.listOrdersForUser(
      request.authUser!.id,
      request.authUser!.email,
      request.tenant?.id
    );
    return okResponse({ orders }, request.correlationId);
  });

  // Favorites
  app.get('/api/v1/favorites', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return okResponse({ productIds: commerceEngagementService.listFavorites(request.authUser!.id) }, request.correlationId);
  });

  app.post('/api/v1/favorites', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId } = (request.body as { productId?: string }) || {};
    if (!productId) return reply.status(400).send({ error: 'ValidationError', message: 'productId is required.' });
    const ok = await commerceEngagementService.addFavorite(request.authUser!.id, productId);
    if (!ok) return reply.status(404).send({ error: 'NotFound', message: 'Product not found.' });
    return reply.status(201).send(
      okResponse({ productIds: commerceEngagementService.listFavorites(request.authUser!.id) }, request.correlationId)
    );
  });

  app.delete('/api/v1/favorites/:productId', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const { productId } = request.params as { productId: string };
    const productIds = await commerceEngagementService.removeFavorite(request.authUser!.id, productId);
    return okResponse({ productIds }, request.correlationId);
  });

  // Product Reviews + Verified Brand Reply
  app.get('/api/v1/products/:id/reviews', async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    return okResponse(commerceEngagementService.listProductReviews(id), request.correlationId);
  });

  app.post('/api/v1/products/:id/reviews', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = ReviewCreateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const res = await commerceEngagementService.createReview({
      productId: id,
      userId: request.authUser!.id,
      userEmail: request.authUser!.email,
      userName: request.authUser!.name,
      rating: parsed.data.rating,
      comment: parsed.data.comment,
    });
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return reply.status(201).send(okResponse({ review: res.review }, request.correlationId));
  });

  app.post(
    '/api/v1/reviews/:id/reply',
    { preHandler: [authenticateToken, tenantScopeGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = ReviewReplySchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }
      const res = await commerceEngagementService.replyToReview(
        id,
        request.tenant!.id,
        parsed.data.reply,
        request.authUser!.id
      );
      if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
      return okResponse({ review: res.review }, request.correlationId);
    }
  );

  // Notifications
  app.get('/api/v1/notifications', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    return okResponse({ notifications: commerceEngagementService.listNotifications(request.authUser!.id) }, request.correlationId);
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const updated = commerceEngagementService.markNotificationRead(request.authUser!.id, id);
    if (!updated) return reply.status(404).send({ error: 'NotFound', message: 'Notification not found.' });
    return okResponse({ notification: updated }, request.correlationId);
  });

  // Customer & Brand Self-Service Support Tickets (routed into Super Admin ticket queue)
  app.get('/api/v1/support/tickets', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const email = request.authUser!.email.toLowerCase();
    const tenantId = request.tenant?.id;
    const tickets = adminControlPlaneService
      .listSupportTickets()
      .filter((t) => t.requesterEmail.toLowerCase() === email || (tenantId && t.tenantId === tenantId));
    return okResponse({ tickets }, request.correlationId);
  });

  app.post('/api/v1/support/tickets', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CustomerTicketSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const ticket = await adminControlPlaneService.createSupportTicket({
      tenantId: request.tenant?.id,
      requesterName: request.authUser!.name,
      requesterEmail: request.authUser!.email,
      subject: parsed.data.subject,
      category: parsed.data.category,
      priority: parsed.data.priority,
      message: parsed.data.message,
    });
    return reply.status(201).send(okResponse({ ticket }, request.correlationId));
  });

  // Privacy & GDPR Account Export & Deletion Requests
  app.get('/api/v1/account/export', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = commerceEngagementService.exportAccountData(request.authUser!.id);
    if (!payload) return reply.status(404).send({ error: 'NotFound', message: 'Account not found.' });
    return okResponse(payload, request.correlationId);
  });

  app.post('/api/v1/account/delete-request', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const req = await commerceEngagementService.submitDeletionRequest(
      request.authUser!.id,
      request.authUser!.email,
      request.tenant?.id
    );
    return okResponse({ governanceRequest: req }, request.correlationId);
  });
}

