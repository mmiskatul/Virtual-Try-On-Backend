import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import {
  createAdminMiddleware,
  createBrandMiddleware,
} from '../../infrastructure/auth.guard.js';
import { okResponse } from '../../infrastructure/http.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';

const CategoryCreateSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  seoTitle: z.string().max(255).optional(),
});

const CollectionCreateSchema = z.object({
  title: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
});

const VariantUpsertSchema = z.object({
  sku: z.string().min(2).max(120),
  size: z.string().min(1).max(32).default('M'),
  color: z.string().min(1).max(64).default('Default'),
  priceOverride: z.number().nonnegative().optional(),
  stockQuantity: z.number().int().min(0).default(0),
  available: z.boolean().default(true),
});

const ModerateProductSchema = z.object({
  moderationStatus: z.enum(['APPROVED', 'PENDING_REVIEW', 'FLAGGED', 'REJECTED']),
  note: z.string().max(500).optional(),
  featured: z.boolean().optional(),
  sponsored: z.boolean().optional(),
});

const readGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const writeGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));
const adminModerationGuards = createAdminMiddleware(requirePermission('moderation', 'action'));

export async function brandCatalogExtRoutes(app: FastifyInstance) {
  // Brand Categories
  app.get('/api/v1/brand/categories', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const categories = await catalogRepository.listCategories(request.tenant!.id);
    return okResponse({ categories }, request.correlationId);
  });

  app.post('/api/v1/brand/categories', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CategoryCreateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const category = await catalogRepository.upsertCategory({
      tenantId: request.tenant!.id,
      ...parsed.data,
    });
    return reply.status(201).send(okResponse({ category }, request.correlationId));
  });

  // Brand Collections
  app.get('/api/v1/brand/collections', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const collections = await catalogRepository.listCollections(request.tenant!.id);
    return okResponse({ collections }, request.correlationId);
  });

  app.post('/api/v1/brand/collections', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CollectionCreateSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const collection = await catalogRepository.upsertCollection({
      tenantId: request.tenant!.id,
      ...parsed.data,
    });
    return reply.status(201).send(okResponse({ collection }, request.correlationId));
  });

  // Add or update product variant safely within tenant catalog
  app.post('/api/v1/products/:id/variants', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = VariantUpsertSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const product = db.getProductById(id, request.tenant!.id);
    if (!product) {
      return reply.status(404).send({ error: 'NotFound', message: 'Product not found in tenant catalog.' });
    }

    const nextVariants = [...(product.variants || [])];
    const idx = nextVariants.findIndex((v) => v.sku === parsed.data.sku);
    const variantRecord = {
      id: idx >= 0 ? nextVariants[idx].id : `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...parsed.data,
    };
    if (idx >= 0) nextVariants[idx] = variantRecord;
    else nextVariants.push(variantRecord);

    const updated = db.updateProduct(id, request.tenant!.id, { variants: nextVariants });
    if (updated) await catalogRepository.syncProductRelations(updated);

    return reply.status(201).send(okResponse({ variant: variantRecord, product: updated }, request.correlationId));
  });

  // Super Admin / Moderator: Moderate a product listing (approve, flag, reject, feature)
  app.patch(
    '/api/v1/admin/moderation/products/:id',
    { preHandler: adminModerationGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = ModerateProductSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
      }

      const result = await catalogRepository.moderateProduct({
        productId: id,
        moderatorId: request.authUser!.id,
        moderatorRole: request.authUser!.role,
        moderationStatus: parsed.data.moderationStatus,
        note: parsed.data.note,
        featured: parsed.data.featured,
        sponsored: parsed.data.sponsored,
        correlationId: request.correlationId,
      });

      if (!result) {
        return reply.status(404).send({ error: 'NotFound', message: 'Product not found.' });
      }

      return okResponse(result, request.correlationId);
    }
  );
}

