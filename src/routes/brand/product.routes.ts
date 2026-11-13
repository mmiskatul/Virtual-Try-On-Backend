import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Product, ProductVariant } from '../../domain/types.js';
import { createBrandMiddleware, registerScopedPreHandlers } from '../../infrastructure/auth.guard.js';
import { db } from '../../infrastructure/database.js';
import {
  AppError,
  ConflictException,
  NotFoundException,
  parseWithSchema,
  validateOutputWithSchema,
} from '../../infrastructure/errors.js';
import { idempotencyManager } from '../../infrastructure/idempotency.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { requireTenantContext } from './profile.service.js';
import {
  AddProductFormOptionsResponseSchema,
  BulkImportProductsInputSchema,
  BulkImportProductsResponseSchema,
  ProductBulkAction,
  BulkProductActionInputSchema,
  BulkProductActionResponseSchema,
  CheckSkuQuerySchema,
  CheckSkuResponseSchema,
  ProductExportJsonResponseSchema,
  ProductExportQuerySchema,
  ProductIdParamsSchema,
  ProductListQuerySchema,
  ProductPublishInputSchema,
  UpdateProductInputSchema,
} from './product.schemas.js';
import {
  CreateProductInputSchema,
  ProductCreateResponseSchema,
  ProductListResponseSchema,
  validateZodOutput,
} from './storefront.schemas.js';

const brandReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandWriteGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));

function filterTenantProducts(
  products: Product[],
  query: { search?: string; category?: string; status?: string }
): Product[] {
  const searchLower = query.search?.trim().toLowerCase() || '';
  const categoryFilter = query.category?.trim();
  const statusFilter = query.status || 'ALL';

  return products.filter((p) => {
    const matchesSearch =
      !searchLower ||
      p.name.toLowerCase().includes(searchLower) ||
      p.sku.toLowerCase().includes(searchLower) ||
      p.category.toLowerCase().includes(searchLower);
    const matchesCategory =
      !categoryFilter || categoryFilter.toLowerCase() === 'all' || p.category === categoryFilter;
    const matchesStatus =
      statusFilter === 'ALL' ||
      (statusFilter === 'MARKETPLACE' && p.marketplacePublished) ||
      (statusFilter === 'STOREFRONT_ONLY' && p.brandStorefrontPublished && !p.marketplacePublished) ||
      (statusFilter === 'DRAFT' && !p.brandStorefrontPublished && !p.marketplacePublished) ||
      (statusFilter === 'TRYON' && p.isTryOnEligible);
    return matchesSearch && matchesCategory && matchesStatus;
  });
}

function escapeCsvCell(value: string | number | boolean): string {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function productsToCsv(products: Product[]): string {
  const header = [
    'id',
    'name',
    'sku',
    'category',
    'collection',
    'price',
    'stock',
    'storefrontPublished',
    'marketplacePublished',
    'isTryOnEligible',
    'tryOnCategory',
  ].join(',');

  const lines = products.map((p) => {
    const totalStock = (p.variants || []).reduce((acc, v) => acc + (Number(v.stockQuantity) || 0), 0);
    return [
      escapeCsvCell(p.id),
      escapeCsvCell(p.name),
      escapeCsvCell(p.sku),
      escapeCsvCell(p.category),
      escapeCsvCell(p.collection || ''),
      escapeCsvCell(p.price),
      escapeCsvCell(totalStock),
      escapeCsvCell(p.brandStorefrontPublished),
      escapeCsvCell(p.marketplacePublished),
      escapeCsvCell(p.isTryOnEligible),
      escapeCsvCell(p.tryOnCategory),
    ].join(',');
  });

  return [header, ...lines].join('\n');
}

function buildDefaultVariants(sku: string, stock?: number): ProductVariant[] {
  const ts = Date.now();
  if (typeof stock === 'number' && Number.isFinite(stock) && stock >= 0) {
    const first = Math.floor(stock / 2);
    const second = stock - first;
    return [
      { id: `v_${ts}_1`, sku: `${sku}-S`, size: 'S', color: 'Default', stockQuantity: first, available: first > 0 },
      { id: `v_${ts}_2`, sku: `${sku}-M`, size: 'M', color: 'Default', stockQuantity: second, available: second > 0 },
    ];
  }
  return [
    { id: `v_${ts}_1`, sku: `${sku}-S`, size: 'S', color: 'Default', stockQuantity: 10, available: true },
    { id: `v_${ts}_2`, sku: `${sku}-M`, size: 'M', color: 'Default', stockQuantity: 15, available: true },
  ];
}

function normalizeTryOnCategory(raw?: string): Product['tryOnCategory'] {
  const clean = (raw || 'tops').trim().toLowerCase();
  if (clean === 'tops' || clean === 'bottoms' || clean === 'dresses' || clean === 'outerwear' || clean === 'all') {
    return clean;
  }
  return 'tops';
}

const DEFAULT_APPAREL_CATEGORIES = [
  'Dresses',
  'Tops',
  'Shirts',
  'T-Shirts',
  'Hoodies',
  'Jackets',
  'Pants',
  'Jeans',
  'Traditional Wear',
  'Sarees',
  'Accessories',
];

async function createBrandProductHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  routeLabel: string
) {
  const tenant = requireTenantContext(request.tenant);
  const body = parseWithSchema(CreateProductInputSchema, request.body ?? {});
  const { name, category, price, sku, variants, isTryOnEligible, tryOnCategory } = body;

  const tenantId = tenant.id;
  const idempotencyKey = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;
  let compositeKey: string | undefined;

  if (idempotencyKey) {
    compositeKey = idempotencyManager.getCompositeKey(idempotencyKey, tenantId);
    const existing = idempotencyManager.getRecord(compositeKey);
    if (existing) {
      if (existing.status === 'PROCESSING') {
        throw new ConflictException(
          'A product creation with this Idempotency-Key is currently in progress.',
          'CONCURRENT_REQUEST_IN_FLIGHT'
        );
      }
      if (existing.status === 'COMPLETED') {
        const currentHash = idempotencyManager.computeHash(request.body);
        if (existing.requestHash !== currentHash) {
          throw new AppError({
            statusCode: 422,
            errorName: 'UnprocessableEntity',
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'Idempotency key was previously used with a different product payload.',
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

  const existingProducts = db.getProductsByTenant(tenantId);
  const duplicateSku = existingProducts.some((p) => p.sku.toLowerCase() === sku.trim().toLowerCase());
  if (duplicateSku) {
    if (compositeKey) idempotencyManager.failOperation(compositeKey);
    throw new ConflictException(`A product with SKU "${sku}" already exists in your tenant catalog.`, 'DUPLICATE_SKU');
  }

  const subscription = db.getSubscription(tenantId);
  if (subscription && existingProducts.length >= subscription.productLimit) {
    if (compositeKey) idempotencyManager.failOperation(compositeKey);
    throw new ConflictException(
      `Product catalog limit reached (${subscription.productLimit} SKUs on ${subscription.plan} plan).`,
      'PRODUCT_QUOTA_EXCEEDED',
      { limit: subscription.productLimit, currentCount: existingProducts.length }
    );
  }

  const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'garment';
  const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;

  const resolvedVariants: ProductVariant[] =
    variants && variants.length > 0
      ? variants.map((v, idx) => ({
          id: v.id || `v_${Date.now()}_${idx + 1}`,
          sku: v.sku,
          size: v.size,
          color: v.color,
          stockQuantity: v.stockQuantity,
          available: v.available,
        }))
      : buildDefaultVariants(sku, body.stock);

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
    tryOnCategory: normalizeTryOnCategory(tryOnCategory),
    specs: body.specs || {},
    variants: resolvedVariants,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const created = await db.runTransaction(async () => db.createProduct(product));
    await catalogRepository.syncProductRelations(created);

    await recordAudit({
      actorId: request.authUser?.id || 'system',
      actorRole: request.authUser?.role || 'BRAND_OWNER',
      tenantId,
      action: 'PRODUCT_CREATED',
      entity: 'Product',
      entityId: created.id,
      correlationId: request.correlationId,
      details: { sku: created.sku, name: created.name, category: created.category, endpoint: routeLabel },
    });

    const responsePayload = validateZodOutput(
      ProductCreateResponseSchema,
      { message: 'Product created successfully', product: created },
      routeLabel
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
}

export async function brandProductRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, brandReadGuards);

  // List Products
  app.get('/api/v1/products', { preHandler: brandReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const query = parseWithSchema(ProductListQuerySchema, request.query ?? {});
    const products = filterTenantProducts(db.getProductsByTenant(tenant.id), query);
    return validateZodOutput(
      ProductListResponseSchema,
      { products },
      'GET /api/v1/products'
    );
  });

  // Add Product Form Options (categories, collections, fabrics, SKU prefix, plan quota)
  app.get('/api/v1/products/form-options', { preHandler: brandReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const [catList, colList] = await Promise.all([
      catalogRepository.listCategories(tenant.id),
      catalogRepository.listCollections(tenant.id),
    ]);
    const tenantProducts = db.getProductsByTenant(tenant.id);
    const tenantFabrics = db.getFabricsByTenant(tenant.id);
    const sub = db.getSubscription(tenant.id);

    const categories = Array.from(
      new Set([
        ...DEFAULT_APPAREL_CATEGORIES,
        ...catList.map((c) => c.name),
        ...tenantProducts.map((p) => p.category),
      ].filter(Boolean))
    );

    const collections = Array.from(
      new Set([
        ...colList.map((c) => c.title),
        ...tenantProducts.map((p) => p.collection).filter((c): c is string => Boolean(c)),
      ])
    );

    const prefixBase = (tenant.slug || tenant.name || 'BRD')
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 3)
      .toUpperCase() || 'BRD';

    const limit = sub?.productLimit ?? 50;
    const used = tenantProducts.length;

    return validateOutputWithSchema(
      AddProductFormOptionsResponseSchema,
      {
        categories,
        collections,
        fabrics: tenantFabrics.map((f) => ({
          id: f.id,
          name: f.name,
          composition: f.composition,
        })),
        tryOnCategories: ['tops', 'bottoms', 'dresses', 'outerwear', 'all'],
        defaultCurrency: 'BDT',
        suggestedSkuPrefix: prefixBase,
        quota: {
          plan: sub?.plan ?? 'STARTER',
          used,
          limit,
          remaining: Math.max(0, limit - used),
        },
      },
      'GET /api/v1/products/form-options'
    );
  });

  // Live SKU Uniqueness Check for /dashboard/products/addproduct
  app.get('/api/v1/products/check-sku', { preHandler: brandReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { sku, excludeProductId } = parseWithSchema(CheckSkuQuerySchema, request.query ?? {});
    const existing = db.getProductsByTenant(tenant.id);
    const duplicate = existing.some(
      (p) =>
        p.id !== excludeProductId &&
        p.sku.trim().toLowerCase() === sku.trim().toLowerCase()
    );

    return validateOutputWithSchema(
      CheckSkuResponseSchema,
      {
        sku,
        available: !duplicate,
        message: duplicate
          ? `SKU "${sku}" is already assigned to another garment in your catalog.`
          : `SKU "${sku}" is available.`,
      },
      'GET /api/v1/products/check-sku'
    );
  });

  // Export Tenant Catalog (CSV or JSON) - declared before /:id to avoid route shadowing
  app.get('/api/v1/products/export', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const query = parseWithSchema(ProductExportQuerySchema, request.query ?? {});
    const filtered = filterTenantProducts(db.getProductsByTenant(tenant.id), query);

    if (query.format === 'csv') {
      const csv = productsToCsv(filtered);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="brand-catalog-export.csv"');
      return reply.status(200).send(csv);
    }

    return validateOutputWithSchema(
      ProductExportJsonResponseSchema,
      {
        total: filtered.length,
        exportedAt: new Date().toISOString(),
        products: filtered,
      },
      'GET /api/v1/products/export'
    );
  });

  // Create Product (/api/v1/products and dedicated /api/v1/products/addproduct)
  app.post('/api/v1/products', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) =>
    createBrandProductHandler(request, reply, 'POST /api/v1/products')
  );

  app.post('/api/v1/products/addproduct', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) =>
    createBrandProductHandler(request, reply, 'POST /api/v1/products/addproduct')
  );

  // Bulk CSV / Batch Product Import - declared before /:id
  app.post('/api/v1/products/bulk-import', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { rows, skipDuplicateSkus } = parseWithSchema(BulkImportProductsInputSchema, request.body ?? {});

    const existing = db.getProductsByTenant(tenant.id);
    const knownSkus = new Set(existing.map((p) => p.sku.toLowerCase()));
    const subscription = db.getSubscription(tenant.id);

    const skipped: Array<{ rowNumber: number; sku: string; reason: string }> = [];
    const validCandidates: Array<{
      rowNumber: number;
      row: (typeof rows)[number];
    }> = [];

    rows.forEach((row, index) => {
      const rowNumber = index + 1;
      const skuKey = row.sku.trim().toLowerCase();
      if (knownSkus.has(skuKey)) {
        if (!skipDuplicateSkus) {
          throw new ConflictException(
            `Row ${rowNumber}: Duplicate SKU "${row.sku}" already exists in catalog or batch.`,
            'DUPLICATE_SKU'
          );
        }
        skipped.push({ rowNumber, sku: row.sku, reason: 'Duplicate SKU already in tenant catalog or CSV batch' });
        return;
      }
      knownSkus.add(skuKey);
      validCandidates.push({ rowNumber, row });
    });

    if (subscription && existing.length + validCandidates.length > subscription.productLimit) {
      throw new ConflictException(
        `Bulk import exceeds your plan product limit (${subscription.productLimit} SKUs).`,
        'PRODUCT_QUOTA_EXCEEDED',
        { limit: subscription.productLimit, currentCount: existing.length, requestedCount: validCandidates.length }
      );
    }

    const now = Date.now();
    const importedProducts: Product[] = await db.runTransaction(async () => {
      const createdList: Product[] = [];
      for (const { row } of validCandidates) {
        const baseSlug =
          row.name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-|-$/g, '') || 'garment';
        const product: Product = {
          id: `prod_${Math.random().toString(36).substring(2, 9)}`,
          tenantId: tenant.id,
          name: row.name,
          slug: `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`,
          description: row.description || '',
          category: row.category || 'Apparel',
          subCategory: row.subCategory || '',
          collection: row.collection || '',
          sku: row.sku,
          price: Number(row.price),
          images: row.image ? [row.image] : [],
          fabricIds: [],
          tags: [],
          brandStorefrontPublished: row.brandStorefrontPublished ?? true,
          marketplacePublished: row.marketplacePublished ?? false,
          isTryOnEligible: row.isTryOnEligible ?? true,
          tryOnCategory: normalizeTryOnCategory(row.tryOnCategory),
          specs: {},
          variants: buildDefaultVariants(row.sku, row.stock),
          createdAt: now,
          updatedAt: now,
        };
        createdList.push(db.createProduct(product));
      }
      return createdList;
    });

    for (const product of importedProducts) {
      await catalogRepository.syncProductRelations(product);
    }

    await recordAudit({
      actorId: request.authUser?.id || 'system',
      actorRole: request.authUser?.role || 'BRAND_OWNER',
      tenantId: tenant.id,
      action: 'PRODUCTS_BULK_IMPORTED',
      entity: 'Product',
      entityId: tenant.id,
      correlationId: request.correlationId,
      details: { importedCount: importedProducts.length, skippedCount: skipped.length },
    });

    return reply.status(201).send(
      validateOutputWithSchema(
        BulkImportProductsResponseSchema,
        {
          message: `Imported ${importedProducts.length} garment(s); skipped ${skipped.length} duplicate row(s).`,
          importedCount: importedProducts.length,
          skippedCount: skipped.length,
          importedProducts,
          skipped,
        },
        'POST /api/v1/products/bulk-import'
      )
    );
  });

  // Bulk Product Action (Visibility / Try-On / Archive) - declared before /:id
  app.patch('/api/v1/products/bulk', { preHandler: brandWriteGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { productIds, action } = parseWithSchema(BulkProductActionInputSchema, request.body ?? {});

    const uniqueIds = Array.from(new Set(productIds));
    const updatedProducts: Product[] = [];
    const errors: Array<{ productId: string; code: string; message: string }> = [];

    for (const productId of uniqueIds) {
      const target = db.getProductById(productId, tenant.id);
      if (!target) {
        errors.push({ productId, code: 'NotFound', message: 'Product not found in tenant catalog.' });
        continue;
      }

      if (action === 'PUBLISH_MARKETPLACE') {
        const pubRes = await catalogRepository.setPublicationState({
          productId,
          tenantId: tenant.id,
          marketplacePublished: true,
        });
        if (!pubRes.ok) {
          errors.push({ productId, code: pubRes.code, message: pubRes.message });
          continue;
        }
        updatedProducts.push(pubRes.product);
        continue;
      }

      const updatesByAction: Record<Exclude<ProductBulkAction, 'PUBLISH_MARKETPLACE'>, Partial<Product>> = {
        UNPUBLISH_MARKETPLACE: { marketplacePublished: false },
        SHOW_STOREFRONT: { brandStorefrontPublished: true },
        HIDE_STOREFRONT: { brandStorefrontPublished: false },
        ENABLE_TRYON: { isTryOnEligible: true },
        DISABLE_TRYON: { isTryOnEligible: false },
        ARCHIVE: { brandStorefrontPublished: false, marketplacePublished: false },
      };

      const updated = db.updateProduct(productId, tenant.id, updatesByAction[action]);
      if (updated) {
        await catalogRepository.syncProductRelations(updated);
        updatedProducts.push(updated);
      }
    }

    if (updatedProducts.length === 0 && errors.length > 0 && errors.every((e) => e.code === 'NotFound')) {
      throw new NotFoundException('None of the specified products were found in your tenant catalog.');
    }

    await recordAudit({
      actorId: request.authUser?.id || 'system',
      actorRole: request.authUser?.role || 'BRAND_OWNER',
      tenantId: tenant.id,
      action: `PRODUCTS_BULK_${action}`,
      entity: 'Product',
      entityId: tenant.id,
      correlationId: request.correlationId,
      details: { updatedCount: updatedProducts.length, skippedCount: errors.length },
    });

    return validateOutputWithSchema(
      BulkProductActionResponseSchema,
      {
        message: `Applied ${action} to ${updatedProducts.length} product(s).`,
        action,
        updatedCount: updatedProducts.length,
        skippedCount: errors.length,
        products: updatedProducts,
        errors,
      },
      'PATCH /api/v1/products/bulk'
    );
  });

  // Get Product by ID
  app.get('/api/v1/products/:id', { preHandler: brandReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
    const product = db.getProductById(id, tenant.id);
    if (!product) {
      throw new NotFoundException('Product not found in your tenant catalog.');
    }
    return { product };
  });

  // Update Product (strict Zod schema + tenant isolation)
  app.put('/api/v1/products/:id', { preHandler: brandWriteGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
    const body = parseWithSchema(UpdateProductInputSchema, request.body ?? {});

    const existing = db.getProductById(id, tenant.id);
    if (!existing) {
      throw new NotFoundException('Product not found in your tenant catalog.');
    }

    if (body.sku && body.sku.toLowerCase() !== existing.sku.toLowerCase()) {
      const collision = db
        .getProductsByTenant(tenant.id)
        .some((p) => p.id !== id && p.sku.toLowerCase() === body.sku!.toLowerCase());
      if (collision) {
        throw new ConflictException(`Another product already uses SKU "${body.sku}".`, 'DUPLICATE_SKU');
      }
    }

    const safeUpdates: Partial<Product> = {};
    if (body.name !== undefined) safeUpdates.name = body.name;
    if (body.description !== undefined) safeUpdates.description = body.description;
    if (body.category !== undefined) safeUpdates.category = body.category;
    if (body.subCategory !== undefined) safeUpdates.subCategory = body.subCategory;
    if (body.collection !== undefined) safeUpdates.collection = body.collection;
    if (body.sku !== undefined) safeUpdates.sku = body.sku;
    if (body.price !== undefined) safeUpdates.price = Number(body.price);
    if (body.compareAtPrice !== undefined) {
      safeUpdates.compareAtPrice = body.compareAtPrice === null ? undefined : Number(body.compareAtPrice);
    }
    if (body.images !== undefined) safeUpdates.images = body.images.filter(Boolean);
    if (body.fabricIds !== undefined) safeUpdates.fabricIds = body.fabricIds;
    if (body.tags !== undefined) safeUpdates.tags = body.tags;
    if (body.brandStorefrontPublished !== undefined) safeUpdates.brandStorefrontPublished = body.brandStorefrontPublished;
    if (body.marketplacePublished !== undefined) safeUpdates.marketplacePublished = body.marketplacePublished;
    if (body.isTryOnEligible !== undefined) safeUpdates.isTryOnEligible = body.isTryOnEligible;
    if (body.tryOnCategory !== undefined) safeUpdates.tryOnCategory = normalizeTryOnCategory(body.tryOnCategory);
    if (body.specs !== undefined) safeUpdates.specs = body.specs;

    if (body.variants !== undefined) {
      safeUpdates.variants = body.variants.map((v, idx) => ({
        id: v.id || `v_${Date.now()}_${idx + 1}`,
        sku: v.sku,
        size: v.size,
        color: v.color,
        stockQuantity: v.stockQuantity,
        available: v.available,
      }));
    } else if (body.stock !== undefined) {
      const currentVariants = [...(existing.variants || [])];
      if (currentVariants.length === 0) {
        safeUpdates.variants = buildDefaultVariants(body.sku || existing.sku, body.stock);
      } else {
        const diff = body.stock - currentVariants.reduce((sum, v) => sum + (v.stockQuantity || 0), 0);
        currentVariants[0] = {
          ...currentVariants[0],
          stockQuantity: Math.max(0, currentVariants[0].stockQuantity + diff),
          available: Math.max(0, currentVariants[0].stockQuantity + diff) > 0,
        };
        safeUpdates.variants = currentVariants;
      }
    }

    const updated = db.updateProduct(id, tenant.id, safeUpdates);
    if (!updated) {
      throw new NotFoundException('Product not found in your tenant catalog.');
    }
    await catalogRepository.syncProductRelations(updated);
    return { message: 'Product updated successfully', product: updated };
  });

  // Publication & Try-On State Toggle (enforces moderation blocks)
  app.patch('/api/v1/products/:id/publish', { preHandler: brandWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
    const body = parseWithSchema(ProductPublishInputSchema, request.body ?? {});

    let brandStorefrontPublished = body.brandStorefrontPublished;
    let marketplacePublished = body.marketplacePublished;
    let isTryOnEligible = body.isTryOnEligible;

    if (body.channel && typeof body.published === 'boolean') {
      if (body.channel === 'brandStorefrontPublished') brandStorefrontPublished = body.published;
      if (body.channel === 'marketplacePublished') marketplacePublished = body.published;
      if (body.channel === 'isTryOnEligible') isTryOnEligible = body.published;
    }

    const result = await catalogRepository.setPublicationState({
      productId: id,
      tenantId: tenant.id,
      brandStorefrontPublished,
      marketplacePublished,
      isTryOnEligible,
    });

    if (!result.ok) {
      if (result.code === 'ModerationBlocked') {
        return reply.status(403).send({
          error: 'ModerationBlocked',
          code: 'MODERATION_BLOCKED',
          message: result.message,
        });
      }
      throw new NotFoundException(result.message);
    }

    return {
      message: 'Product publication state updated successfully',
      product: result.product,
      publication: result.publication,
      brandStorefrontPublished: result.product.brandStorefrontPublished,
      marketplacePublished: result.product.marketplacePublished,
      isTryOnEligible: result.product.isTryOnEligible,
    };
  });

  // Delete Product
  app.delete('/api/v1/products/:id', { preHandler: brandWriteGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(ProductIdParamsSchema, request.params ?? {});
    const deleted = db.deleteProduct(id, tenant.id);
    if (!deleted) {
      throw new NotFoundException('Product not found in your tenant catalog.');
    }

    await recordAudit({
      actorId: request.authUser?.id || 'system',
      actorRole: request.authUser?.role || 'BRAND_OWNER',
      tenantId: tenant.id,
      action: 'PRODUCT_DELETED',
      entity: 'Product',
      entityId: id,
      correlationId: request.correlationId,
    });

    return { message: 'Product deleted successfully' };
  });
}
