import crypto from 'node:crypto';
import { Product } from '../../domain/types.js';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { recordAudit } from '../audit/audit.service.js';

export type ModerationState = 'APPROVED' | 'PENDING_REVIEW' | 'FLAGGED' | 'REJECTED';

export interface CategoryDto {
  id: string;
  tenantId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
  active: boolean;
  seoTitle?: string;
}

export interface CollectionDto {
  id: string;
  tenantId: string | null;
  title: string;
  slug: string;
  description?: string;
  active: boolean;
  sponsored: boolean;
}

export interface PublicationMeta {
  productId: string;
  tenantId: string;
  status: 'DRAFT' | 'PUBLISHED';
  moderationStatus: ModerationState;
  moderationNote?: string;
  featured: boolean;
  sponsored: boolean;
  publishedAt?: string;
}

const memoryCategories = new Map<string, CategoryDto>();
const memoryCollections = new Map<string, CollectionDto>();
const memoryPublications = new Map<string, PublicationMeta>();

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';
}

export class CatalogRepository {
  public async listCategories(tenantId?: string): Promise<CategoryDto[]> {
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const rows = await prisma.category.findMany({
          where: tenantId ? { OR: [{ tenantId }, { tenantId: null }], active: true } : { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            id: r.id,
            tenantId: r.tenantId,
            name: r.name,
            slug: r.slug,
            sortOrder: r.sortOrder,
            active: r.active,
            seoTitle: r.seoTitle ?? undefined,
          }));
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'catalog.list_categories_prisma_warning');
      }
    }

    const list = Array.from(memoryCategories.values()).filter(
      (c) => c.active && (!tenantId || c.tenantId === tenantId || c.tenantId === null)
    );
    return list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  public async upsertCategory(input: {
    tenantId?: string | null;
    name: string;
    slug?: string;
    sortOrder?: number;
    seoTitle?: string;
  }): Promise<CategoryDto> {
    const cleanSlug = slugify(input.slug || input.name);
    const tenantId = input.tenantId ?? null;
    const dto: CategoryDto = {
      id: crypto.randomUUID(),
      tenantId,
      name: input.name.trim(),
      slug: cleanSlug,
      sortOrder: input.sortOrder ?? 0,
      active: true,
      seoTitle: input.seoTitle?.trim(),
    };

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const existing = await prisma.category.findFirst({
          where: { tenantId, slug: cleanSlug },
        });
        const row = existing
          ? await prisma.category.update({
              where: { id: existing.id },
              data: { name: dto.name, sortOrder: dto.sortOrder, seoTitle: dto.seoTitle ?? null, active: true },
            })
          : await prisma.category.create({
              data: {
                id: dto.id,
                tenantId,
                name: dto.name,
                slug: cleanSlug,
                sortOrder: dto.sortOrder,
                seoTitle: dto.seoTitle ?? null,
                active: true,
              },
            });
        dto.id = row.id;
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'catalog.upsert_category_prisma_warning');
      }
    }

    const memKey = `${tenantId ?? 'platform'}::${cleanSlug}`;
    const prev = memoryCategories.get(memKey);
    if (prev && !prisma) dto.id = prev.id;
    memoryCategories.set(memKey, dto);
    return dto;
  }

  public async listCollections(tenantId?: string): Promise<CollectionDto[]> {
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const rows = await prisma.collection.findMany({
          where: tenantId ? { OR: [{ tenantId }, { tenantId: null }], active: true } : { active: true },
          orderBy: { createdAt: 'desc' },
        });
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            id: r.id,
            tenantId: r.tenantId,
            title: r.title,
            slug: r.slug,
            description: r.description ?? undefined,
            active: r.active,
            sponsored: r.sponsored,
          }));
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'catalog.list_collections_prisma_warning');
      }
    }

    return Array.from(memoryCollections.values()).filter(
      (c) => c.active && (!tenantId || c.tenantId === tenantId || c.tenantId === null)
    );
  }

  public async upsertCollection(input: {
    tenantId?: string | null;
    title: string;
    slug?: string;
    description?: string;
    sponsored?: boolean;
  }): Promise<CollectionDto> {
    const cleanSlug = slugify(input.slug || input.title);
    const tenantId = input.tenantId ?? null;
    const dto: CollectionDto = {
      id: crypto.randomUUID(),
      tenantId,
      title: input.title.trim(),
      slug: cleanSlug,
      description: input.description?.trim(),
      active: true,
      sponsored: Boolean(input.sponsored),
    };

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const existing = await prisma.collection.findFirst({
          where: { tenantId, slug: cleanSlug },
        });
        const row = existing
          ? await prisma.collection.update({
              where: { id: existing.id },
              data: {
                title: dto.title,
                description: dto.description ?? null,
                sponsored: dto.sponsored,
                active: true,
              },
            })
          : await prisma.collection.create({
              data: {
                id: dto.id,
                tenantId,
                title: dto.title,
                slug: cleanSlug,
                description: dto.description ?? null,
                sponsored: dto.sponsored,
                active: true,
              },
            });
        dto.id = row.id;
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'catalog.upsert_collection_prisma_warning');
      }
    }

    const memKey = `${tenantId ?? 'platform'}::${cleanSlug}`;
    const prev = memoryCollections.get(memKey);
    if (prev && !prisma) dto.id = prev.id;
    memoryCollections.set(memKey, dto);
    return dto;
  }

  public async syncProductRelations(product: Product): Promise<void> {
    const existingPub = memoryPublications.get(product.id);
    const nextPub: PublicationMeta = {
      productId: product.id,
      tenantId: product.tenantId,
      status: product.marketplacePublished ? 'PUBLISHED' : 'DRAFT',
      moderationStatus: existingPub?.moderationStatus ?? 'APPROVED',
      moderationNote: existingPub?.moderationNote,
      featured: existingPub?.featured ?? false,
      sponsored: existingPub?.sponsored ?? false,
      publishedAt: product.marketplacePublished
        ? existingPub?.publishedAt || new Date().toISOString()
        : existingPub?.publishedAt,
    };
    memoryPublications.set(product.id, nextPub);

    const prisma = getGlobalPrisma();
    if (!prisma) return;

    try {
      await prisma.marketplacePublication.upsert({
        where: { productId: product.id },
        update: {
          status: nextPub.status,
          publishedAt: nextPub.publishedAt ? new Date(nextPub.publishedAt) : null,
        },
        create: {
          productId: product.id,
          tenantId: product.tenantId,
          status: nextPub.status,
          moderationStatus: nextPub.moderationStatus,
          featured: nextPub.featured,
          sponsored: nextPub.sponsored,
          publishedAt: nextPub.publishedAt ? new Date(nextPub.publishedAt) : null,
        },
      });

      for (const v of product.variants || []) {
        const variantAny = v as any;
        await prisma.productVariantRecord.upsert({
          where: { tenantId_sku: { tenantId: product.tenantId, sku: v.sku } },
          update: {
            size: v.size,
            color: v.color,
            stockQuantity: Number(v.stockQuantity ?? 0),
            available: v.available !== false,
            priceOverride: variantAny.priceOverride != null ? variantAny.priceOverride : null,
          },
          create: {
            productId: product.id,
            tenantId: product.tenantId,
            sku: v.sku,
            size: v.size,
            color: v.color,
            stockQuantity: Number(v.stockQuantity ?? 0),
            available: v.available !== false,
            priceOverride: variantAny.priceOverride != null ? variantAny.priceOverride : null,
          },
        });
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, productId: product.id }, 'catalog.sync_product_relations_warning');
    }
  }

  public async getPublicationMeta(productId: string, tenantId: string): Promise<PublicationMeta> {
    const mem = memoryPublications.get(productId);
    if (mem) return mem;

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const row = await prisma.marketplacePublication.findUnique({ where: { productId } });
        if (row) {
          const meta: PublicationMeta = {
            productId: row.productId,
            tenantId: row.tenantId,
            status: row.status as 'DRAFT' | 'PUBLISHED',
            moderationStatus: row.moderationStatus as ModerationState,
            moderationNote: row.moderationNote ?? undefined,
            featured: row.featured,
            sponsored: row.sponsored,
            publishedAt: row.publishedAt?.toISOString(),
          };
          memoryPublications.set(productId, meta);
          return meta;
        }
      } catch {
        // ignore
      }
    }

    return {
      productId,
      tenantId,
      status: 'DRAFT',
      moderationStatus: 'APPROVED',
      featured: false,
      sponsored: false,
    };
  }

  public async setPublicationState(input: {
    productId: string;
    tenantId: string;
    brandStorefrontPublished?: boolean;
    marketplacePublished?: boolean;
  }): Promise<{ ok: true; product: Product; publication: PublicationMeta } | { ok: false; code: string; message: string }> {
    const product = db.getProductById(input.productId, input.tenantId);
    if (!product) {
      return { ok: false, code: 'NotFound', message: 'Product not found in tenant catalog.' };
    }

    const currentMeta = await this.getPublicationMeta(input.productId, input.tenantId);
    if (input.marketplacePublished === true && currentMeta.moderationStatus === 'REJECTED') {
      return {
        ok: false,
        code: 'ModerationBlocked',
        message: currentMeta.moderationNote
          ? `Cannot publish to marketplace while rejected by moderation: ${currentMeta.moderationNote}`
          : 'Cannot publish to marketplace while product listing is rejected by platform moderation.',
      };
    }

    const updates: Partial<Product> = {};
    if (typeof input.brandStorefrontPublished === 'boolean') {
      updates.brandStorefrontPublished = input.brandStorefrontPublished;
    }
    if (typeof input.marketplacePublished === 'boolean') {
      updates.marketplacePublished = input.marketplacePublished;
    }

    const updated = db.updateProduct(input.productId, input.tenantId, updates);
    if (!updated) {
      return { ok: false, code: 'NotFound', message: 'Product update failed.' };
    }

    await this.syncProductRelations(updated);
    const publication = await this.getPublicationMeta(updated.id, updated.tenantId);
    return { ok: true, product: updated, publication };
  }

  public async moderateProduct(input: {
    productId: string;
    moderatorId: string;
    moderatorRole: string;
    moderationStatus: ModerationState;
    note?: string;
    featured?: boolean;
    sponsored?: boolean;
    correlationId?: string;
  }): Promise<{ product: Product; publication: PublicationMeta } | null> {
    const product = db.getProducts().find((p) => p.id === input.productId);
    if (!product) return null;

    const existing = await this.getPublicationMeta(product.id, product.tenantId);
    const shouldHideMarketplace = input.moderationStatus === 'REJECTED';

    const updatedProduct = shouldHideMarketplace
      ? db.updateProduct(product.id, product.tenantId, { marketplacePublished: false }) || product
      : product;

    const nextMeta: PublicationMeta = {
      productId: product.id,
      tenantId: product.tenantId,
      status: updatedProduct.marketplacePublished ? 'PUBLISHED' : 'DRAFT',
      moderationStatus: input.moderationStatus,
      moderationNote: input.note ?? existing.moderationNote,
      featured: typeof input.featured === 'boolean' ? input.featured : existing.featured,
      sponsored: typeof input.sponsored === 'boolean' ? input.sponsored : existing.sponsored,
      publishedAt: updatedProduct.marketplacePublished
        ? existing.publishedAt || new Date().toISOString()
        : existing.publishedAt,
    };
    memoryPublications.set(product.id, nextMeta);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.marketplacePublication.upsert({
          where: { productId: product.id },
          update: {
            status: nextMeta.status,
            moderationStatus: nextMeta.moderationStatus,
            moderationNote: nextMeta.moderationNote ?? null,
            featured: nextMeta.featured,
            sponsored: nextMeta.sponsored,
          },
          create: {
            productId: product.id,
            tenantId: product.tenantId,
            status: nextMeta.status,
            moderationStatus: nextMeta.moderationStatus,
            moderationNote: nextMeta.moderationNote ?? null,
            featured: nextMeta.featured,
            sponsored: nextMeta.sponsored,
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'catalog.moderate_prisma_warning');
      }
    }

    await recordAudit({
      actorId: input.moderatorId,
      actorRole: input.moderatorRole,
      tenantId: product.tenantId,
      action: `MARKETPLACE_MODERATION_${input.moderationStatus}`,
      entity: 'Product',
      entityId: product.id,
      reason: input.note,
      correlationId: input.correlationId,
      details: {
        moderationStatus: input.moderationStatus,
        featured: nextMeta.featured,
        sponsored: nextMeta.sponsored,
        marketplacePublished: updatedProduct.marketplacePublished,
      },
    });

    return { product: updatedProduct, publication: nextMeta };
  }

  public isModeratedOut(productId: string): boolean {
    const pub = memoryPublications.get(productId);
    return pub?.moderationStatus === 'REJECTED';
  }

  public async getPublicMarketplaceProducts(filters: {
    search?: string;
    category?: string;
    brand?: string;
    tryOnOnly?: boolean;
    featuredOnly?: boolean;
    sort?: string;
    page?: number;
    limit?: number;
  }) {
    const activeTenants = new Map(db.getTenants().filter((t) => t.status === 'ACTIVE').map((t) => [t.id, t]));
    let products = db
      .getProducts()
      .filter((p) => p.marketplacePublished && activeTenants.has(p.tenantId) && !this.isModeratedOut(p.id));

    if (filters.category && filters.category.toLowerCase() !== 'all') {
      const cat = filters.category.toLowerCase();
      products = products.filter(
        (p) => p.category.toLowerCase() === cat || p.subCategory?.toLowerCase() === cat
      );
    }

    if (filters.brand) {
      const bLower = filters.brand.toLowerCase();
      products = products.filter((p) => {
        const tenant = activeTenants.get(p.tenantId);
        return tenant?.slug.toLowerCase() === bLower || p.tenantId === filters.brand;
      });
    }

    if (filters.tryOnOnly) {
      products = products.filter((p) => p.isTryOnEligible);
    }

    if (filters.featuredOnly) {
      products = products.filter((p) => memoryPublications.get(p.id)?.featured === true);
    }

    if (filters.search) {
      const q = filters.search.toLowerCase().trim();
      products = products.filter((p) => {
        const tenant = activeTenants.get(p.tenantId);
        return (
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          (tenant?.name.toLowerCase().includes(q) ?? false) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      });
    }

    if (filters.sort === 'price_asc') {
      products.sort((a, b) => a.price - b.price);
    } else if (filters.sort === 'price_desc') {
      products.sort((a, b) => b.price - a.price);
    } else {
      products.sort((a, b) => b.createdAt - a.createdAt);
    }

    const total = products.length;
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 24));
    const offset = (page - 1) * limit;
    const paged = products.slice(offset, offset + limit).map((p) => {
      const tenant = activeTenants.get(p.tenantId);
      const pub = memoryPublications.get(p.id);
      return {
        ...p,
        brandName: tenant?.name || 'Partner Brand',
        brandSlug: tenant?.slug || 'brand',
        brandLogo: tenant?.logoUrl,
        featured: pub?.featured ?? false,
        sponsored: pub?.sponsored ?? false,
        moderationStatus: pub?.moderationStatus ?? 'APPROVED',
      };
    });

    return { items: paged, total, page, limit };
  }

  public async getPublicBrandStorefront(slug: string) {
    const tenant = db.getTenantBySlug(slug);
    if (!tenant || tenant.status !== 'ACTIVE') return null;

    const products = db
      .getProductsByTenant(tenant.id)
      .filter((p) => p.brandStorefrontPublished && !this.isModeratedOut(p.id));
    const [categories, collections] = await Promise.all([
      this.listCategories(tenant.id),
      this.listCollections(tenant.id),
    ]);

    return { tenant, categories, collections, products };
  }
}

export const catalogRepository = new CatalogRepository();
