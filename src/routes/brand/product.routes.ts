import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import {
  createBrandMiddleware,
  registerScopedPreHandlers,
} from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { Product, ProductVariant } from '../../domain/types.js';
import { idempotencyManager } from '../../infrastructure/idempotency.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';
import {
  CreateProductInputSchema,
  ProductCreateResponseSchema,
  ProductListResponseSchema,
  formatZodValidationError,
  validateZodOutput,
} from './storefront.schemas.js';

const brandReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandWriteGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));

export async function brandProductRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, brandReadGuards);
  // List Products
  app.get('/api/v1/products', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const products = db.getProductsByTenant(request.tenant.id);
    return validateZodOutput(
      ProductListResponseSchema,
      { products },
      'GET /api/v1/products'
    );
  });

  // Create Product
  app.post('/api/v1/products', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const parsedBody = CreateProductInputSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send(formatZodValidationError(parsedBody.error));
    }
    const body = parsedBody.data;
    const { name, category, price, sku, variants, isTryOnEligible, tryOnCategory } = body;

    const tenantId = request.tenant.id;
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

    const defaultVariants: ProductVariant[] =
      variants && variants.length > 0
        ? variants.map((v, idx) => ({
            id: v.id || `v_${Date.now()}_${idx + 1}`,
            sku: v.sku,
            size: v.size,
            color: v.color,
            stockQuantity: v.stockQuantity,
            available: v.available,
          }))
        : [
            { id: `v_${Date.now()}_1`, sku: `${sku}-S`, size: 'S', color: 'Default', stockQuantity: 10, available: true },
            { id: `v_${Date.now()}_2`, sku: `${sku}-M`, size: 'M', color: 'Default', stockQuantity: 15, available: true },
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
      compareAtPrice: body.compareAtPrice !== undefined ? Number(body.compareAtPrice) : undefined,
      images: (body.images || []).filter(Boolean),
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
      await catalogRepository.syncProductRelations(created);

      const responsePayload = validateZodOutput(
        ProductCreateResponseSchema,
        { message: 'Product created successfully', product: created },
        'POST /api/v1/products'
      );

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
  app.get('/api/v1/products/:id', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const { id } = request.params as { id: string };
    const product = db.getProductById(id, request.tenant.id);
    if (!product) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    return { product };
  });

  // Update Product (whitelist mutable fields to prevent tenantId/id mass assignment)
  app.put('/api/v1/products/:id', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const { id } = request.params as { id: string };
    const body = (request.body as Partial<Product>) || {};
    const safeUpdates: Partial<Product> = {};
    if (body.name !== undefined) safeUpdates.name = body.name;
    if (body.description !== undefined) safeUpdates.description = body.description;
    if (body.category !== undefined) safeUpdates.category = body.category;
    if (body.subCategory !== undefined) safeUpdates.subCategory = body.subCategory;
    if (body.collection !== undefined) safeUpdates.collection = body.collection;
    if (body.sku !== undefined) safeUpdates.sku = body.sku;
    if (body.price !== undefined && Number(body.price) >= 0) safeUpdates.price = Number(body.price);
    if (body.compareAtPrice !== undefined) safeUpdates.compareAtPrice = Number(body.compareAtPrice);
    if (Array.isArray(body.images)) safeUpdates.images = body.images;
    if (Array.isArray(body.fabricIds)) safeUpdates.fabricIds = body.fabricIds;
    if (Array.isArray(body.tags)) safeUpdates.tags = body.tags;
    if (typeof body.brandStorefrontPublished === 'boolean') safeUpdates.brandStorefrontPublished = body.brandStorefrontPublished;
    if (typeof body.marketplacePublished === 'boolean') safeUpdates.marketplacePublished = body.marketplacePublished;
    if (typeof body.isTryOnEligible === 'boolean') safeUpdates.isTryOnEligible = body.isTryOnEligible;
    if (body.tryOnCategory !== undefined) safeUpdates.tryOnCategory = body.tryOnCategory;
    if (body.specs !== undefined) safeUpdates.specs = body.specs;
    if (Array.isArray(body.variants)) safeUpdates.variants = body.variants;

    const updated = db.updateProduct(id, request.tenant.id, safeUpdates);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    await catalogRepository.syncProductRelations(updated);
    return { message: 'Product updated successfully', product: updated };
  });

  // Publication State Toggle (enforces moderation blocks)
  app.patch('/api/v1/products/:id/publish', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    let brandStorefrontPublished: boolean | undefined;
    let marketplacePublished: boolean | undefined;
    if (body.channel && typeof body.published === 'boolean') {
      if (body.channel === 'brandStorefrontPublished') brandStorefrontPublished = body.published;
      if (body.channel === 'marketplacePublished') marketplacePublished = body.published;
    } else {
      if (typeof body.brandStorefrontPublished === 'boolean') brandStorefrontPublished = body.brandStorefrontPublished;
      if (typeof body.marketplacePublished === 'boolean') marketplacePublished = body.marketplacePublished;
    }

    const result = await catalogRepository.setPublicationState({
      productId: id,
      tenantId: request.tenant.id,
      brandStorefrontPublished,
      marketplacePublished,
    });

    if (!result.ok) {
      const status = result.code === 'ModerationBlocked' ? 403 : 404;
      return reply.status(status).send({ error: result.code, message: result.message });
    }

    return {
      message: 'Product publication state updated successfully',
      product: result.product,
      publication: result.publication,
      brandStorefrontPublished: result.product.brandStorefrontPublished,
      marketplacePublished: result.product.marketplacePublished,
    };
  });

  // Delete Product
  app.delete('/api/v1/products/:id', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const { id } = request.params as { id: string };
    const deleted = db.deleteProduct(id, request.tenant.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in your tenant catalog.' });
    }
    return { message: 'Product deleted successfully' };
  });
}
