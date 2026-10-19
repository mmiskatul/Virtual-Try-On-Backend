import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { Product, ProductVariant } from '../../domain/types.js';
import { idempotencyManager } from '../../infrastructure/idempotency.js';

export async function brandProductRoutes(app: FastifyInstance) {
  // List Products
  app.get('/api/v1/products', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const products = db.getProductsByTenant(request.tenant!.id);
    return { products };
  });

  // Create Product
  app.post('/api/v1/products', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const { name, category, price, sku, variants, isTryOnEligible, tryOnCategory } = body || {};

    if (!name || !category || price === undefined || !sku) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'name, category, price, and sku are required.'
      });
    }

    const tenantId = request.tenant!.id;
    const idempotencyKey = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;
    let compositeKey: string | undefined;

    if (idempotencyKey) {
      compositeKey = idempotencyManager.getCompositeKey(idempotencyKey, tenantId);
      const existing = idempotencyManager.getRecord(compositeKey);
      if (existing) {
        if (existing.status === 'PROCESSING') {
          return reply.status(409).send({
            error: 'ConflictError',
            code: 'CONCURRENT_REQUEST_IN_FLIGHT',
            message: 'A product creation with this Idempotency-Key is currently in progress.'
          });
        }
        if (existing.status === 'COMPLETED') {
          const currentHash = idempotencyManager.computeHash(request.body);
          if (existing.requestHash !== currentHash) {
            return reply.status(422).send({
              error: 'UnprocessableEntity',
              code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
              message: 'Idempotency key was previously used with a different product payload.'
            });
          }
          reply.header('idempotency-replay', 'true');
          return reply.status(existing.statusCode || 201).send(existing.responsePayload);
        }
      }

      idempotencyManager.startOperation(
        compositeKey,
        idempotencyKey,
        tenantId,
        idempotencyManager.computeHash(request.body)
      );
    }

    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;

    const defaultVariants: ProductVariant[] = variants && variants.length > 0 ? variants : [
      { id: `v_${Date.now()}_1`, sku: `${sku}-S`, size: 'S', color: 'Default', stockQuantity: 10, available: true },
      { id: `v_${Date.now()}_2`, sku: `${sku}-M`, size: 'M', color: 'Default', stockQuantity: 15, available: true }
    ];

    const now = Date.now();
    const product: Product = {
      id: `prod_${Math.random().toString(36).substring(2, 9)}`,
      tenantId,
      name,
      slug,
      description: body.description || '',
      category,
      subCategory: body.subCategory || '',
      collection: body.collection || '',
      sku,
      price: Number(price),
      compareAtPrice: body.compareAtPrice ? Number(body.compareAtPrice) : undefined,
      images: body.images || ['https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=800'],
      fabricIds: body.fabricIds || [],
      tags: body.tags || [],
      brandStorefrontPublished: body.brandStorefrontPublished ?? true,
      marketplacePublished: body.marketplacePublished ?? false,
      isTryOnEligible: isTryOnEligible ?? true,
      tryOnCategory: (tryOnCategory || 'tops').toLowerCase() as any,
      specs: body.specs || {},
      variants: defaultVariants,
      createdAt: now,
      updatedAt: now
    };

    try {
      const created = await db.runTransaction(async () => {
        return db.createProduct(product);
      });

      const responsePayload = { message: 'Product created successfully', product: created };

      if (compositeKey) {
        idempotencyManager.completeOperation(compositeKey, 201, responsePayload);
      }

      return reply.status(201).send(responsePayload);
    } catch (err: any) {
      if (compositeKey) {
        idempotencyManager.failOperation(compositeKey);
      }
      throw err;
    }
  });

  // Get Product by ID
  app.get('/api/v1/products/:id', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const product = db.getProductById(id, request.tenant!.id);
    if (!product) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    return { product };
  });

  // Update Product
  app.put('/api/v1/products/:id', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<Product>;
    const updated = db.updateProduct(id, request.tenant!.id, body);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    return { message: 'Product updated successfully', product: updated };
  });

  // Publication State Toggle
  app.patch('/api/v1/products/:id/publish', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    const product = db.getProductById(id, request.tenant!.id);
    if (!product) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found.' });
    }

    const updates: Partial<Product> = {};
    if (body.channel && typeof body.published === 'boolean') {
      if (body.channel === 'brandStorefrontPublished') updates.brandStorefrontPublished = body.published;
      if (body.channel === 'marketplacePublished') updates.marketplacePublished = body.published;
    } else {
      if (typeof body.brandStorefrontPublished === 'boolean') updates.brandStorefrontPublished = body.brandStorefrontPublished;
      if (typeof body.marketplacePublished === 'boolean') updates.marketplacePublished = body.marketplacePublished;
    }

    const updated = db.updateProduct(id, request.tenant!.id, updates);
    return {
      message: 'Product publication state updated successfully',
      product: updated,
      brandStorefrontPublished: updated?.brandStorefrontPublished,
      marketplacePublished: updated?.marketplacePublished
    };
  });

  // Delete Product
  app.delete('/api/v1/products/:id', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const deleted = db.deleteProduct(id, request.tenant!.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    return { message: 'Product deleted successfully' };
  });
}
