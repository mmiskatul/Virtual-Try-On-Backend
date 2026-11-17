import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { touchApiKey, verifyApiKey } from '../../modules/developer/api_keys.js';
import type { ApiScope, Order, OrderStatus, Product } from '../../domain/types.js';

const ORDER_STATUSES: OrderStatus[] = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
    apiKeyScopes?: ApiScope[];
  }
}

const REASONS: Record<string, string> = {
  MISSING: 'Send your API key in the X-API-Key header.',
  INVALID: 'This API key is not valid.',
  REVOKED: 'This API key has been revoked.',
  EXPIRED: 'This API key has expired.',
  TENANT_INACTIVE: 'This shop is not active.',
};

/** Authenticates a request by API key and requires one permission. The key can never reach session routes. */
function requireKey(scope: ApiScope) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const check = verifyApiKey(request.headers['x-api-key']);
    if (!check.ok) {
      return reply.status(401).send({ error: 'Unauthorized', code: `API_KEY_${check.reason}`, message: REASONS[check.reason] });
    }
    if (!check.key.scopes.includes(scope)) {
      return reply.status(403).send({ error: 'InsufficientScope', message: `This key does not have the "${scope}" permission.` });
    }
    request.tenant = check.tenant;
    request.apiKeyId = check.key.id;
    request.apiKeyScopes = check.key.scopes;
    touchApiKey(check.tenant.id, check.key.id);
  };
}

const productView = (p: Product) => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  description: p.description,
  category: p.category,
  price: p.price,
  images: p.images,
  tags: p.tags,
  storefrontPublished: p.brandStorefrontPublished,
  marketplacePublished: p.marketplacePublished,
  tryOnEligible: p.isTryOnEligible,
  variants: p.variants.map((v) => ({ sku: v.sku, size: v.size, color: v.color, stock: v.stockQuantity, available: v.available })),
  updatedAt: p.updatedAt,
});

const orderView = (o: Order) => ({
  id: o.id,
  status: o.status,
  paymentStatus: o.paymentStatus,
  customerEmail: o.customerEmail,
  shippingAddress: o.shippingAddress,
  items: o.items,
  subtotal: o.subtotal,
  shippingFee: o.shippingFee,
  totalAmount: o.totalAmount,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

function page(request: FastifyRequest) {
  const q = request.query as { limit?: string; offset?: string };
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
  const offset = Math.max(0, Number(q.offset) || 0);
  return { limit, offset };
}

/** The public API: what a brand's own software can do with an API key. Always limited to that brand. */
export async function publicApiRoutes(app: FastifyInstance) {
  app.get('/api/v1/public/me', { preHandler: requireKey('products:read') }, async (request: FastifyRequest) => ({
    brand: { id: request.tenant!.id, name: request.tenant!.name, slug: request.tenant!.slug },
    scopes: request.apiKeyScopes,
  }));

  app.get('/api/v1/public/products', { preHandler: requireKey('products:read') }, async (request: FastifyRequest) => {
    const { limit, offset } = page(request);
    const all = db.getProductsByTenant(request.tenant!.id);
    return { total: all.length, limit, offset, products: all.slice(offset, offset + limit).map(productView) };
  });

  app.get('/api/v1/public/products/:id', { preHandler: requireKey('products:read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const product = db.getProductsByTenant(request.tenant!.id).find((p) => p.id === id);
    if (!product) return reply.status(404).send({ error: 'NotFound', message: 'Product not found.' });
    return { product: productView(product) };
  });

  app.post('/api/v1/public/inventory/adjust', { preHandler: requireKey('products:write') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId, variantSku, change, reason } = (request.body as any) || {};
    if (typeof productId !== 'string' || typeof variantSku !== 'string' || !Number.isInteger(change) || Math.abs(change) > 100_000) {
      return reply.status(400).send({ error: 'ValidationError', message: 'productId, variantSku and a whole-number change are required.' });
    }
    const result = await db.runTransaction(() =>
      db.adjustInventory(request.tenant!.id, productId, variantSku, change, `API: ${String(reason || 'stock adjustment').slice(0, 120)}`),
    );
    if (!result.success) return reply.status(400).send({ error: 'InventoryError', message: result.error });
    return { newStock: result.newStock };
  });

  app.get('/api/v1/public/orders', { preHandler: requireKey('orders:read') }, async (request: FastifyRequest) => {
    const { limit, offset } = page(request);
    const status = (request.query as { status?: string }).status;
    const all = db.getOrders().filter((o) => o.tenantId === request.tenant!.id && (!status || o.status === status)).sort((a, b) => b.createdAt - a.createdAt);
    return { total: all.length, limit, offset, orders: all.slice(offset, offset + limit).map(orderView) };
  });

  app.get('/api/v1/public/orders/:id', { preHandler: requireKey('orders:read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const order = db.getOrderById(id, request.tenant!.id);
    if (!order) return reply.status(404).send({ error: 'NotFound', message: 'Order not found.' });
    return { order: orderView(order) };
  });

  app.patch('/api/v1/public/orders/:id/status', { preHandler: requireKey('orders:write') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { status } = (request.body as any) || {};
    if (!ORDER_STATUSES.includes(status)) {
      return reply.status(400).send({ error: 'ValidationError', message: `Status must be one of: ${ORDER_STATUSES.join(', ')}.` });
    }
    const updated = db.updateOrderStatus(id, request.tenant!.id, status);
    if (!updated) return reply.status(404).send({ error: 'NotFound', message: 'Order not found.' });
    return { order: orderView(updated) };
  });
}
