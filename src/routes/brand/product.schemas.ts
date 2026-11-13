import { z } from 'zod';
import {
  NormalizedCurrencyInputSchema,
  ProductOutputSchema,
  ProductVariantSchema,
  SafeImageAssetSchema,
} from './storefront.schemas.js';

export const PRODUCT_BULK_ACTIONS = [
  'PUBLISH_MARKETPLACE',
  'UNPUBLISH_MARKETPLACE',
  'SHOW_STOREFRONT',
  'HIDE_STOREFRONT',
  'ENABLE_TRYON',
  'DISABLE_TRYON',
  'ARCHIVE',
] as const;

export type ProductBulkAction = (typeof PRODUCT_BULK_ACTIONS)[number];

export const ProductIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'Product ID is required.').max(120),
});

export const ProductVariantDeleteParamsSchema = z.object({
  id: z.string().trim().min(1, 'Product ID is required.').max(120),
  variantId: z.string().trim().min(1, 'Variant ID is required.').max(120),
});

export const ProductListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(['ALL', 'MARKETPLACE', 'STOREFRONT_ONLY', 'DRAFT', 'TRYON']).optional(),
  sortBy: z.enum(['latest', 'price-asc', 'price-desc', 'sales', 'name']).optional(),
});

export const UpdateProductInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name cannot be empty.').max(160).optional(),
    description: z.string().trim().max(4000).optional(),
    category: z.string().trim().min(1, 'Category cannot be empty.').max(80).optional(),
    subCategory: z.string().trim().max(80).optional(),
    collection: z.string().trim().max(80).optional(),
    sku: z.string().trim().min(1, 'SKU cannot be empty.').max(120).optional(),
    currency: NormalizedCurrencyInputSchema.optional(),
    price: z.coerce
      .number()
      .finite('Product price must be a finite number.')
      .min(0, 'Product price must be non-negative.')
      .max(10_000_000)
      .optional(),
    compareAtPrice: z.union([z.coerce.number().finite().min(0).max(10_000_000), z.null()]).optional(),
    stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
    images: z.array(SafeImageAssetSchema).max(12).optional(),
    fabricIds: z.array(z.string().trim().min(1).max(120)).max(24).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    brandStorefrontPublished: z.boolean().optional(),
    marketplacePublished: z.boolean().optional(),
    isTryOnEligible: z.boolean().optional(),
    tryOnCategory: z.string().trim().min(1).max(60).optional(),
    specs: z.record(z.string(), z.string()).optional(),
    variants: z.array(ProductVariantSchema).max(100).optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one mutable product field must be provided for update.'
  );

export const ProductPublishInputSchema = z
  .object({
    channel: z.enum(['brandStorefrontPublished', 'marketplacePublished', 'isTryOnEligible']).optional(),
    published: z.boolean().optional(),
    brandStorefrontPublished: z.boolean().optional(),
    marketplacePublished: z.boolean().optional(),
    isTryOnEligible: z.boolean().optional(),
  })
  .refine(
    (data) =>
      (data.channel !== undefined && typeof data.published === 'boolean') ||
      typeof data.brandStorefrontPublished === 'boolean' ||
      typeof data.marketplacePublished === 'boolean' ||
      typeof data.isTryOnEligible === 'boolean',
    'Provide either (channel + published boolean) or at least one visibility boolean flag.'
  );

export const BulkProductActionInputSchema = z.object({
  productIds: z
    .array(z.string().trim().min(1))
    .min(1, 'Select at least one product.')
    .max(100, 'Cannot bulk update more than 100 products per request.'),
  action: z.enum(PRODUCT_BULK_ACTIONS),
});

export const BulkImportProductRowSchema = z.object({
  name: z.string().trim().min(1, 'Garment name is required.').max(160),
  sku: z.string().trim().min(1, 'SKU is required.').max(120),
  category: z.string().trim().min(1).max(80).default('Apparel'),
  price: z.coerce
    .number()
    .finite('Price must be a finite number.')
    .min(0, 'Price must be non-negative.')
    .max(10_000_000),
  stock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  subCategory: z.string().trim().max(80).optional(),
  collection: z.string().trim().max(80).optional(),
  description: z.string().trim().max(4000).optional(),
  tryOnCategory: z.string().trim().min(1).max(60).optional(),
  image: SafeImageAssetSchema.optional(),
  brandStorefrontPublished: z.boolean().optional(),
  marketplacePublished: z.boolean().optional(),
  isTryOnEligible: z.boolean().optional(),
});

export const BulkImportProductsInputSchema = z.object({
  rows: z
    .array(BulkImportProductRowSchema)
    .min(1, 'Provide at least one row to import.')
    .max(200, 'Bulk CSV import is limited to 200 rows per batch.'),
  skipDuplicateSkus: z.boolean().optional().default(true),
});

export const ProductExportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).optional().default('json'),
  category: z.string().trim().max(80).optional(),
  status: z.enum(['ALL', 'MARKETPLACE', 'STOREFRONT_ONLY', 'DRAFT', 'TRYON']).optional(),
});

export const CatalogEntityIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'ID is required.').max(120),
});

export const CategoryCreateSchema = z.object({
  name: z.string().trim().min(2, 'Category name must be at least 2 characters.').max(120),
  slug: z.string().trim().min(2).max(120).optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  seoTitle: z.string().trim().max(255).optional(),
  description: z.string().trim().max(1000).optional(),
  parentCategory: z.string().trim().max(120).optional(),
  tryOnCategory: z.enum(['tops', 'bottoms', 'dresses', 'outerwear', 'all', 'none']).optional().default('none'),
  active: z.boolean().optional().default(true),
});

export const CategoryUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'Category name must be at least 2 characters.').max(120).optional(),
    slug: z.string().trim().min(2).max(120).optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    seoTitle: z.string().trim().max(255).optional(),
    description: z.string().trim().max(1000).optional(),
    parentCategory: z.string().trim().max(120).optional(),
    tryOnCategory: z.enum(['tops', 'bottoms', 'dresses', 'outerwear', 'all', 'none']).optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one category field to update.');

export const CheckCategorySlugQuerySchema = z.object({
  slug: z.string().trim().max(120).optional(),
  name: z.string().trim().max(120).optional(),
});

export const CheckCategorySlugResponseSchema = z.object({
  available: z.boolean(),
  slug: z.string(),
  suggestedSlug: z.string().optional(),
  message: z.string(),
});

export const CategoryFormOptionsResponseSchema = z.object({
  presets: z.array(z.string()),
  tryOnClasses: z.array(z.string()),
  existingCategories: z.array(z.string()),
  existingCount: z.number(),
  defaultSortOrder: z.number(),
});

export const CollectionCreateSchema = z.object({
  title: z.string().trim().min(2, 'Collection title must be at least 2 characters.').max(120),
  slug: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
});

export const CollectionUpdateSchema = z
  .object({
    title: z.string().trim().min(2, 'Collection title must be at least 2 characters.').max(120).optional(),
    slug: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one collection field to update.');

export const VariantUpsertSchema = z.object({
  sku: z.string().trim().min(2, 'Variant SKU must be at least 2 characters.').max(120),
  size: z.string().trim().min(1).max(32).default('M'),
  color: z.string().trim().min(1).max(64).default('Default'),
  priceOverride: z.coerce.number().finite().nonnegative().optional(),
  stockQuantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  available: z.boolean().default(true),
});

export const ModerateProductSchema = z.object({
  moderationStatus: z.enum(['APPROVED', 'PENDING_REVIEW', 'FLAGGED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
  featured: z.boolean().optional(),
  sponsored: z.boolean().optional(),
});

export const FabricIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'Fabric ID is required.').max(120),
});

export const CreateFabricInputSchema = z.object({
  name: z.string().trim().min(2, 'Fabric name must be at least 2 characters.').max(120),
  composition: z.string().trim().min(2, 'Fabric composition is required.').max(200),
  color: z.string().trim().max(64).optional(),
  pattern: z.string().trim().max(64).optional(),
  textureUrl: SafeImageAssetSchema.optional(),
  weightGsm: z.coerce.number().finite().positive().max(2000).optional(),
  stretch: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional(),
  transparency: z.enum(['OPAQUE', 'SEMI_SHEER', 'SHEER']).optional(),
  thickness: z.enum(['LIGHT', 'MEDIUM', 'HEAVY']).optional(),
  careInstructions: z.string().trim().max(300).optional(),
  care: z.string().trim().max(300).optional(),
});

export const UpdateFabricInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Fabric name must be at least 2 characters.').max(120).optional(),
    composition: z.string().trim().min(2, 'Composition must be at least 2 characters.').max(200).optional(),
    color: z.string().trim().max(64).optional(),
    pattern: z.string().trim().max(64).optional(),
    textureUrl: SafeImageAssetSchema.optional(),
    weightGsm: z.coerce.number().finite().positive().max(2000).optional(),
    stretch: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional(),
    transparency: z.enum(['OPAQUE', 'SEMI_SHEER', 'SHEER']).optional(),
    thickness: z.enum(['LIGHT', 'MEDIUM', 'HEAVY']).optional(),
    careInstructions: z.string().trim().max(300).optional(),
    care: z.string().trim().max(300).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Provide at least one fabric field to update.');

export const ProductExportJsonResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  exportedAt: z.string(),
  products: z.array(ProductOutputSchema),
});

export const BulkProductActionResponseSchema = z.object({
  message: z.string(),
  action: z.enum(PRODUCT_BULK_ACTIONS),
  updatedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  products: z.array(ProductOutputSchema),
  errors: z.array(
    z.object({
      productId: z.string(),
      code: z.string(),
      message: z.string(),
    })
  ),
});

export const BulkImportProductsResponseSchema = z.object({
  message: z.string(),
  importedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  importedProducts: z.array(ProductOutputSchema),
  skipped: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      sku: z.string(),
      reason: z.string(),
    })
  ),
});

export const CheckSkuQuerySchema = z.object({
  sku: z.string().trim().min(1, 'SKU query parameter is required.').max(120),
  excludeProductId: z.string().trim().max(120).optional(),
});

export const CheckSkuResponseSchema = z.object({
  sku: z.string(),
  available: z.boolean(),
  message: z.string(),
});

export const AddProductFormOptionsResponseSchema = z.object({
  categories: z.array(z.string()),
  collections: z.array(z.string()),
  fabrics: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      composition: z.string(),
    })
  ),
  tryOnCategories: z.array(z.enum(['tops', 'bottoms', 'dresses', 'outerwear', 'all'])),
  defaultCurrency: z.literal('BDT'),
  suggestedSkuPrefix: z.string(),
  quota: z.object({
    plan: z.string(),
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
});

