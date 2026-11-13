import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createAdminMiddleware,
  createBrandMiddleware,
} from '../../infrastructure/auth.guard.js';
import { db } from '../../infrastructure/database.js';
import {
  NotFoundException,
  parseWithSchema,
} from '../../infrastructure/errors.js';
import { okResponse } from '../../infrastructure/http.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  CatalogEntityIdParamsSchema,
  CategoryCreateSchema,
  CategoryUpdateSchema,
  CollectionCreateSchema,
  CollectionUpdateSchema,
  ModerateProductSchema,
  ProductIdParamsSchema,
  ProductVariantDeleteParamsSchema,
  VariantUpsertSchema,
} from './product.schemas.js';
import { requireTenantContext } from './profile.service.js';

const readGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const writeGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));
const adminModerationGuards = createAdminMiddleware(requirePermission('moderation', 'action'));

export async function brandCatalogExtRoutes(app: FastifyInstance) {
  // Brand Categories
  app.get('/api/v1/brand/categories', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const categories = await catalogRepository.listCategories(tenant.id);
    return okResponse({ categories }, request.correlationId);
  });

  app.post('/api/v1/brand/categories', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const data = parseWithSchema(CategoryCreateSchema, request.body ?? {});
    const category = await catalogRepository.upsertCategory({
      tenantId: tenant.id,
      ...data,
    });
    return reply.status(201).send(okResponse({ category }, request.correlationId));
  });

  app.put('/api/v1/brand/categories/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const updates = parseWithSchema(CategoryUpdateSchema, request.body ?? {});
    const category = await catalogRepository.updateCategory(tenant.id, id, updates);
    if (!category) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }
    return okResponse({ category }, request.correlationId);
  });

  app.delete('/api/v1/brand/categories/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const deleted = await catalogRepository.deleteCategory(tenant.id, id);
    if (!deleted) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }
    return okResponse({ deleted: true, id }, request.correlationId);
  });

  // Brand Collections
  app.get('/api/v1/brand/collections', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const collections = await catalogRepository.listCollections(tenant.id);
    return okResponse({ collections }, request.correlationId);
  });

  app.post('/api/v1/brand/collections', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const data = parseWithSchema(CollectionCreateSchema, request.body ?? {});
    const collection = await catalogRepository.upsertCollection({
      tenantId: tenant.id,
      ...data,
    });
    return reply.status(201).send(okResponse({ collection }, request.correlationId));
  });

  app.put('/api/v1/brand/collections/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const updates = parseWithSchema(CollectionUpdateSchema, request.body ?? {});
    const collection = await catalogRepository.updateCollection(tenant.id, id, updates);
    if (!collection) {
      throw new NotFoundException('Collection not found in your brand catalog.');
    }
    return okResponse({ collection }, request.correlationId);
  });

  app.delete('/api/v1/brand/collections/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const deleted = await catalogRepository.deleteCollection(tenant.id, id);
    if (!deleted) {
      throw new NotFoundException('Collection not found in your brand catalog.');
    }
    return okResponse({ deleted: true, id }, request.correlationId);
  });

  // Add or update product variant safely within tenant catalog
  app.post('/api/v1/products/:id/variants', { preHandler: writeGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
    const variantInput = parseWithSchema(VariantUpsertSchema, request.body ?? {});

    const product = db.getProductById(id, tenant.id);
    if (!product) {
      throw new NotFoundException('Product not found in tenant catalog.');
    }

    const nextVariants = [...(product.variants || [])];
    const idx = nextVariants.findIndex((v) => v.sku.toLowerCase() === variantInput.sku.toLowerCase());
    const variantRecord = {
      id: idx >= 0 ? nextVariants[idx].id : `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...variantInput,
    };
    if (idx >= 0) nextVariants[idx] = variantRecord;
    else nextVariants.push(variantRecord);

    const updated = db.updateProduct(id, tenant.id, { variants: nextVariants });
    if (updated) await catalogRepository.syncProductRelations(updated);

    return reply.status(201).send(okResponse({ variant: variantRecord, product: updated }, request.correlationId));
  });

  // Remove variant from product safely within tenant catalog
  app.delete('/api/v1/products/:id/variants/:variantId', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id, variantId } = parseWithSchema(ProductVariantDeleteParamsSchema, request.params ?? {});

    const product = db.getProductById(id, tenant.id);
    if (!product) {
      throw new NotFoundException('Product not found in tenant catalog.');
    }

    const existingVariants = product.variants || [];
    const filtered = existingVariants.filter((v) => v.id !== variantId && v.sku !== variantId);
    if (filtered.length === existingVariants.length) {
      throw new NotFoundException('Variant not found on product.');
    }

    const updated = db.updateProduct(id, tenant.id, { variants: filtered });
    if (updated) await catalogRepository.syncProductRelations(updated);

    return okResponse({ deleted: true, variantId, product: updated }, request.correlationId);
  });

  // Super Admin / Moderator: Moderate a product listing (approve, flag, reject, feature)
  app.patch(
    '/api/v1/admin/moderation/products/:id',
    { preHandler: adminModerationGuards },
    async (request: FastifyRequest) => {
      const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
      const data = parseWithSchema(ModerateProductSchema, request.body ?? {});

      const result = await catalogRepository.moderateProduct({
        productId: id,
        moderatorId: request.authUser!.id,
        moderatorRole: request.authUser!.role,
        moderationStatus: data.moderationStatus,
        note: data.note,
        featured: data.featured,
        sponsored: data.sponsored,
        correlationId: request.correlationId,
      });

      if (!result) {
        throw new NotFoundException('Product not found.');
      }

      return okResponse(result, request.correlationId);
    }
  );
}
