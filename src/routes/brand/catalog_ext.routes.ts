import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createAdminMiddleware,
  createBrandMiddleware,
} from '../../infrastructure/auth.guard.js';
import { db } from '../../infrastructure/database.js';
import {
  ConflictException,
  NotFoundException,
  parseWithSchema,
} from '../../infrastructure/errors.js';
import { okResponse } from '../../infrastructure/http.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  CatalogEntityIdParamsSchema,
  CategoryCreateSchema,
  CategoryUpdateSchema,
  CategoryFormOptionsResponseSchema,
  CheckCategorySlugQuerySchema,
  CheckCategorySlugResponseSchema,
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

const CATEGORY_PRESET_SUGGESTIONS = [
  'Dresses',
  'Tops & Shirts',
  'T-Shirts & Polos',
  'Pants & Trousers',
  'Jeans & Denim',
  'Outerwear & Jackets',
  'Coats & Parkas',
  'Knitwear & Sweaters',
  'Skirts',
  'Blazers & Tailoring',
  'Activewear & Sportswear',
  'Loungewear & Sleepwear',
  'Swimwear',
  'Suits & Eveningwear',
  'Accessories',
];

const TRY_ON_GARMENT_CLASSES = ['tops', 'bottoms', 'dresses', 'outerwear', 'all', 'none'] as const;

function slugifyName(val: string): string {
  return (
    val
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'category'
  );
}

async function createCategoryHandler(request: FastifyRequest, reply: FastifyReply) {
  const tenant = requireTenantContext(request.tenant);
  const data = parseWithSchema(CategoryCreateSchema, request.body ?? {});

  const cleanSlug = slugifyName(data.slug || data.name);

  // Enforce uniqueness within brand tenant
  const existingSlug = await catalogRepository.findCategoryBySlug(tenant.id, cleanSlug);
  if (existingSlug) {
    throw new ConflictException(
      `A category with slug "${cleanSlug}" already exists in your brand catalog.`,
      'DUPLICATE_CATEGORY_SLUG'
    );
  }

  const existingName = await catalogRepository.findCategoryByName(tenant.id, data.name);
  if (existingName) {
    throw new ConflictException(
      `A category with name "${data.name}" already exists in your brand catalog.`,
      'DUPLICATE_CATEGORY_NAME'
    );
  }

  const category = await catalogRepository.upsertCategory({
    tenantId: tenant.id,
    name: data.name,
    slug: cleanSlug,
    sortOrder: data.sortOrder,
    seoTitle: data.seoTitle,
    description: data.description,
    parentCategory: data.parentCategory,
    tryOnCategory: data.tryOnCategory,
    active: data.active,
  });

  const userPayload = request.user as { id?: string; role?: string } | undefined;
  recordAudit({
    tenantId: tenant.id,
    actorId: userPayload?.id || 'system',
    actorRole: userPayload?.role || 'BRAND_OWNER',
    action: 'tenant:category:create',
    entity: 'category',
    entityId: category.id,
    details: {
      name: category.name,
      slug: category.slug,
      tryOnCategory: category.tryOnCategory,
      parentCategory: category.parentCategory,
    },
  });

  return reply.status(201).send(
    okResponse(
      {
        category,
        message: `Category "${category.name}" created successfully.`,
      },
      request.correlationId
    )
  );
}

export async function brandCatalogExtRoutes(app: FastifyInstance) {
  // Brand Categories - Form Options
  app.get('/api/v1/brand/categories/form-options', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const existing = await catalogRepository.listCategories(tenant.id);
    const existingCategories = existing.map((c) => c.name);

    return okResponse(
      {
        presets: CATEGORY_PRESET_SUGGESTIONS,
        tryOnClasses: TRY_ON_GARMENT_CLASSES,
        existingCategories,
        existingCount: existing.length,
        defaultSortOrder: (existing.length + 1) * 10,
      },
      request.correlationId
    );
  });

  // Brand Categories - Slug Availability Check
  app.get('/api/v1/brand/categories/check-slug', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const query = parseWithSchema(CheckCategorySlugQuerySchema, request.query ?? {});
    const target = query.slug || query.name || '';
    if (!target.trim()) {
      return okResponse(
        { available: true, slug: '', message: 'Provide a category name or slug to check availability.' },
        request.correlationId
      );
    }

    const result = await catalogRepository.checkCategorySlugAvailable(tenant.id, target);
    return okResponse(
      {
        ...result,
        message: result.available
          ? `Slug "${result.slug}" is available for your brand.`
          : `Slug "${result.slug}" is already in use. Suggested: "${result.suggestedSlug}".`,
      },
      request.correlationId
    );
  });

  // Brand Categories - List
  app.get('/api/v1/brand/categories', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const categories = await catalogRepository.listCategories(tenant.id);
    return okResponse({ categories }, request.correlationId);
  });

  // Brand Categories - Create / Add
  app.post('/api/v1/brand/categories', { preHandler: writeGuards }, createCategoryHandler);
  app.post('/api/v1/brand/categories/add', { preHandler: writeGuards }, createCategoryHandler);

  // Brand Categories - Get By ID
  app.get('/api/v1/brand/categories/:id', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const category = await catalogRepository.getCategoryById(tenant.id, id);
    if (!category) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }
    return okResponse({ category }, request.correlationId);
  });

  // Brand Categories - Update
  app.put('/api/v1/brand/categories/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const updates = parseWithSchema(CategoryUpdateSchema, request.body ?? {});

    const existing = await catalogRepository.getCategoryById(tenant.id, id);
    if (!existing) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }

    if (updates.slug && slugifyName(updates.slug) !== existing.slug) {
      const conflictSlug = await catalogRepository.findCategoryBySlug(tenant.id, updates.slug);
      if (conflictSlug && conflictSlug.id !== id) {
        throw new ConflictException(
          `A category with slug "${updates.slug}" already exists in your brand catalog.`,
          'DUPLICATE_CATEGORY_SLUG'
        );
      }
    }

    if (updates.name && updates.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
      const conflictName = await catalogRepository.findCategoryByName(tenant.id, updates.name);
      if (conflictName && conflictName.id !== id) {
        throw new ConflictException(
          `A category with name "${updates.name}" already exists in your brand catalog.`,
          'DUPLICATE_CATEGORY_NAME'
        );
      }
    }

    const category = await catalogRepository.updateCategory(tenant.id, id, updates);
    if (!category) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }

    const userPayload = request.user as { id?: string; role?: string } | undefined;
    recordAudit({
      tenantId: tenant.id,
      actorId: userPayload?.id || 'system',
      actorRole: userPayload?.role || 'BRAND_OWNER',
      action: 'tenant:category:update',
      entity: 'category',
      entityId: category.id,
      details: { name: category.name, slug: category.slug },
    });

    return okResponse({ category, message: 'Category updated successfully.' }, request.correlationId);
  });

  // Brand Categories - Delete
  app.delete('/api/v1/brand/categories/:id', { preHandler: writeGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(CatalogEntityIdParamsSchema, request.params ?? {});
    const existing = await catalogRepository.getCategoryById(tenant.id, id);
    if (!existing) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }

    const deleted = await catalogRepository.deleteCategory(tenant.id, id);
    if (!deleted) {
      throw new NotFoundException('Category not found in your brand catalog.');
    }

    const userPayload = request.user as { id?: string; role?: string } | undefined;
    recordAudit({
      tenantId: tenant.id,
      actorId: userPayload?.id || 'system',
      actorRole: userPayload?.role || 'BRAND_OWNER',
      action: 'tenant:category:delete',
      entity: 'category',
      entityId: id,
      details: { name: existing.name, slug: existing.slug },
    });

    return okResponse({ deleted: true, id, message: `Category "${existing.name}" removed.` }, request.correlationId);
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
