import { z } from 'zod';
import {
  NormalizedCurrencyInputSchema,
  ProductOutputSchema,
  SafeImageAssetSchema,
} from './storefront.schemas.js';

/**
 * THE PRODUCT CONTRACT.
 *
 * Every field the brand dashboard's product form can send, with one fixed type and one set of limits.
 * Create and update both build on these same field rules, so a value that is valid for one is valid for
 * the other. The dashboard keeps an exact mirror in `src/lib/productContract.ts`; the numbers below are
 * also served at GET /api/v1/products/contract so the two can be compared.
 */
export const PRODUCT_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  categoryMax: 80,
  subCategoryMax: 80,
  collectionMax: 80,
  shortDescriptionMax: 160,
  descriptionMax: 4000,
  tagsMax: 20,
  tagMax: 30,
  imagesMax: 12,
  skuMin: 3,
  skuMax: 64,
  priceMax: 10_000_000,
  stockMax: 1_000_000,
  lowStockMax: 100_000,
  warehouseMax: 80,
  variantsMax: 100,
  variantSizeMax: 40,
  variantColorMax: 60,
  specsMax: 30,
  specKeyMax: 40,
  specValueMax: 120,
} as const;

export const TRY_ON_CATEGORIES = ['tops', 'bottoms', 'dresses', 'outerwear', 'all'] as const;
export const CATALOG_STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED'] as const;

/** Letters, numbers, dot, dash, underscore. No spaces, no emoji. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Tags: letters (any language), numbers, spaces, dash, underscore. No emoji or symbols. */
export const TAG_PATTERN = /^[\p{L}\p{N} _-]+$/u;
const SPEC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;

const twoDecimals = (value: number) => Math.round(value * 100) / 100 === value;

// ─── FIELD RULES ──────────────────────────────────────────────────────────────

const nameField = z
  .string()
  .trim()
  .min(PRODUCT_LIMITS.nameMin, `Product title must be at least ${PRODUCT_LIMITS.nameMin} characters.`)
  .max(PRODUCT_LIMITS.nameMax, `Product title cannot exceed ${PRODUCT_LIMITS.nameMax} characters.`);

const categoryField = z
  .string()
  .trim()
  .min(1, 'Category is required.')
  .max(PRODUCT_LIMITS.categoryMax, `Category cannot exceed ${PRODUCT_LIMITS.categoryMax} characters.`);

const subCategoryField = z.string().trim().max(PRODUCT_LIMITS.subCategoryMax);
const collectionField = z
  .string()
  .trim()
  .max(PRODUCT_LIMITS.collectionMax, `Collection cannot exceed ${PRODUCT_LIMITS.collectionMax} characters.`);
const shortDescriptionField = z
  .string()
  .trim()
  .max(PRODUCT_LIMITS.shortDescriptionMax, `Short summary cannot exceed ${PRODUCT_LIMITS.shortDescriptionMax} characters.`);
const descriptionField = z
  .string()
  .trim()
  .max(PRODUCT_LIMITS.descriptionMax, `Description cannot exceed ${PRODUCT_LIMITS.descriptionMax} characters.`);

const tagsField = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'Tags cannot be empty.')
      .max(PRODUCT_LIMITS.tagMax, `Each tag can be at most ${PRODUCT_LIMITS.tagMax} characters.`)
      .regex(TAG_PATTERN, 'Tags can only contain letters, numbers, spaces, "-" and "_".')
  )
  .max(PRODUCT_LIMITS.tagsMax, `Use at most ${PRODUCT_LIMITS.tagsMax} tags.`);

const imagesField = z
  .array(SafeImageAssetSchema)
  .max(PRODUCT_LIMITS.imagesMax, `Use at most ${PRODUCT_LIMITS.imagesMax} images.`);

const skuField = z
  .string()
  .trim()
  .min(PRODUCT_LIMITS.skuMin, `SKU must be at least ${PRODUCT_LIMITS.skuMin} characters.`)
  .max(PRODUCT_LIMITS.skuMax, `SKU cannot exceed ${PRODUCT_LIMITS.skuMax} characters.`)
  .regex(SKU_PATTERN, 'SKU can only contain letters, numbers, ".", "-" and "_" (no spaces).');

const priceField = z.coerce
  .number()
  .finite('Price must be a number.')
  .gt(0, 'Selling price must be greater than 0.')
  .max(PRODUCT_LIMITS.priceMax, `Price cannot exceed ${PRODUCT_LIMITS.priceMax}.`)
  .refine(twoDecimals, 'Price can have at most 2 decimal places.');

const compareAtField = z.coerce
  .number()
  .finite()
  .gt(0, 'Compare-at price must be greater than 0.')
  .max(PRODUCT_LIMITS.priceMax)
  .refine(twoDecimals, 'Compare-at price can have at most 2 decimal places.');

const costPriceField = z.coerce
  .number()
  .finite('Cost price must be a number.')
  .min(0, 'Cost price cannot be negative.')
  .max(PRODUCT_LIMITS.priceMax)
  .refine(twoDecimals, 'Cost price can have at most 2 decimal places.');

const stockField = z.coerce
  .number()
  .int('Stock must be a whole number.')
  .min(0, 'Stock cannot be negative.')
  .max(PRODUCT_LIMITS.stockMax, `Stock cannot exceed ${PRODUCT_LIMITS.stockMax}.`);

const lowStockField = z.coerce
  .number()
  .int('Low-stock alert must be a whole number.')
  .min(0, 'Low-stock alert cannot be negative.')
  .max(PRODUCT_LIMITS.lowStockMax);

const warehouseField = z
  .string()
  .trim()
  .max(PRODUCT_LIMITS.warehouseMax, `Warehouse cannot exceed ${PRODUCT_LIMITS.warehouseMax} characters.`);

const tryOnCategoryField = z.enum(TRY_ON_CATEGORIES, {
  error: `Try-On category must be one of: ${TRY_ON_CATEGORIES.join(', ')}.`,
});
const catalogStatusField = z.enum(CATALOG_STATUSES, {
  error: `Catalog status must be one of: ${CATALOG_STATUSES.join(', ')}.`,
});

/** Specifications: short text values only. Keys starting with "_" are reserved for the system. */
const specsField = z
  .record(
    z
      .string()
      .max(PRODUCT_LIMITS.specKeyMax)
      .regex(SPEC_KEY_PATTERN, 'Specification names must start with a letter and use letters, numbers, spaces, "-" or "_".'),
    z.string().trim().max(PRODUCT_LIMITS.specValueMax, `Specification values can be at most ${PRODUCT_LIMITS.specValueMax} characters.`)
  )
  .refine((value) => Object.keys(value).length <= PRODUCT_LIMITS.specsMax, `Use at most ${PRODUCT_LIMITS.specsMax} specifications.`);

/** One size/colour combination a brand enters in the form. */
export const ProductVariantInputSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  sku: skuField,
  size: z.string().trim().min(1, 'Size is required.').max(PRODUCT_LIMITS.variantSizeMax),
  color: z.string().trim().min(1, 'Colour is required.').max(PRODUCT_LIMITS.variantColorMax),
  stockQuantity: stockField,
  available: z.boolean(),
});

const variantsField = z
  .array(ProductVariantInputSchema)
  .max(PRODUCT_LIMITS.variantsMax, `Use at most ${PRODUCT_LIMITS.variantsMax} variants.`)
  .superRefine((variants, ctx) => {
    const seenCombos = new Set<string>();
    const seenSkus = new Set<string>();
    variants.forEach((variant, index) => {
      const combo = `${variant.size.toLowerCase()}|${variant.color.toLowerCase()}`;
      if (seenCombos.has(combo)) {
        ctx.addIssue({ code: 'custom', path: [index, 'size'], message: `Size ${variant.size} / ${variant.color} is listed twice.` });
      }
      seenCombos.add(combo);
      const sku = variant.sku.toLowerCase();
      if (seenSkus.has(sku)) {
        ctx.addIssue({ code: 'custom', path: [index, 'sku'], message: `Variant SKU ${variant.sku} is used twice.` });
      }
      seenSkus.add(sku);
    });
  });

// ─── WRITE SCHEMAS (CREATE + UPDATE SHARE THE SAME FIELD RULES) ────────────────

const writableShape = {
  name: nameField,
  category: categoryField,
  subCategory: subCategoryField,
  collection: collectionField,
  shortDescription: shortDescriptionField,
  description: descriptionField,
  tags: tagsField,
  images: imagesField,
  /** Clear flat photo for the AI try-on model. `null` removes it. */
  aiReferenceImage: SafeImageAssetSchema.nullable(),
  currency: NormalizedCurrencyInputSchema,
  price: priceField,
  /** `null` removes the compare-at price. */
  compareAtPrice: compareAtField.nullable(),
  /** `null` removes the cost price. */
  costPrice: costPriceField.nullable(),
  sku: skuField,
  stock: stockField,
  lowStockThreshold: lowStockField,
  warehouseLocation: warehouseField,
  variants: variantsField,
  brandStorefrontPublished: z.boolean(),
  marketplacePublished: z.boolean(),
  isTryOnEligible: z.boolean(),
  includeInBrandTryOn: z.boolean(),
  includeInMarketplaceTryOn: z.boolean(),
  tryOnCategory: tryOnCategoryField,
  catalogStatus: catalogStatusField,
  specs: specsField,
  fabricIds: z.array(z.string().trim().min(1).max(120)).max(24),
} as const;

type CrossCheckable = {
  price?: number;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  stock?: number;
  variants?: Array<{ stockQuantity: number }>;
};

/** Sizes & colours share out the total stock: what is assigned to them must add up to it exactly. */
export function variantStockMessage(totalStock: number, assigned: number): string | null {
  if (assigned === totalStock) return null;
  return assigned < totalStock
    ? `Assign all ${totalStock} items to sizes and colours (${totalStock - assigned} left).`
    : `Sizes and colours add up to ${assigned}, which is ${assigned - totalStock} more than the total stock of ${totalStock}.`;
}

function crossFieldChecks(data: CrossCheckable, ctx: z.RefinementCtx) {
  if (data.variants && data.variants.length > 0 && typeof data.stock === 'number') {
    const assigned = data.variants.reduce((sum, v) => sum + v.stockQuantity, 0);
    const message = variantStockMessage(data.stock, assigned);
    if (message) ctx.addIssue({ code: 'custom', path: ['variants'], message });
  }
  if (typeof data.compareAtPrice === 'number' && typeof data.price === 'number' && data.compareAtPrice <= data.price) {
    ctx.addIssue({
      code: 'custom',
      path: ['compareAtPrice'],
      message: 'Compare-at price must be higher than the selling price.',
    });
  }
}

export const CreateProductInputSchema = z
  .object({
    name: writableShape.name,
    category: writableShape.category,
    price: writableShape.price,
    sku: writableShape.sku,
    subCategory: writableShape.subCategory.optional(),
    collection: writableShape.collection.optional(),
    shortDescription: writableShape.shortDescription.optional(),
    description: writableShape.description.optional(),
    tags: writableShape.tags.optional(),
    images: writableShape.images.optional(),
    aiReferenceImage: writableShape.aiReferenceImage.optional(),
    currency: writableShape.currency.optional(),
    compareAtPrice: writableShape.compareAtPrice.optional(),
    costPrice: writableShape.costPrice.optional(),
    stock: writableShape.stock.optional(),
    lowStockThreshold: writableShape.lowStockThreshold.optional(),
    warehouseLocation: writableShape.warehouseLocation.optional(),
    variants: writableShape.variants.optional(),
    brandStorefrontPublished: writableShape.brandStorefrontPublished.optional(),
    marketplacePublished: writableShape.marketplacePublished.optional(),
    isTryOnEligible: writableShape.isTryOnEligible.optional(),
    includeInBrandTryOn: writableShape.includeInBrandTryOn.optional(),
    includeInMarketplaceTryOn: writableShape.includeInMarketplaceTryOn.optional(),
    tryOnCategory: writableShape.tryOnCategory.optional(),
    catalogStatus: writableShape.catalogStatus.optional(),
    specs: writableShape.specs.optional(),
    fabricIds: writableShape.fabricIds.optional(),
  })
  .strict()
  .superRefine(crossFieldChecks);

export const UpdateProductInputSchema = z
  .object({
    name: writableShape.name.optional(),
    category: writableShape.category.optional(),
    price: writableShape.price.optional(),
    sku: writableShape.sku.optional(),
    subCategory: writableShape.subCategory.optional(),
    collection: writableShape.collection.optional(),
    shortDescription: writableShape.shortDescription.optional(),
    description: writableShape.description.optional(),
    tags: writableShape.tags.optional(),
    images: writableShape.images.optional(),
    aiReferenceImage: writableShape.aiReferenceImage.optional(),
    currency: writableShape.currency.optional(),
    compareAtPrice: writableShape.compareAtPrice.optional(),
    costPrice: writableShape.costPrice.optional(),
    stock: writableShape.stock.optional(),
    lowStockThreshold: writableShape.lowStockThreshold.optional(),
    warehouseLocation: writableShape.warehouseLocation.optional(),
    variants: writableShape.variants.optional(),
    brandStorefrontPublished: writableShape.brandStorefrontPublished.optional(),
    marketplacePublished: writableShape.marketplacePublished.optional(),
    isTryOnEligible: writableShape.isTryOnEligible.optional(),
    includeInBrandTryOn: writableShape.includeInBrandTryOn.optional(),
    includeInMarketplaceTryOn: writableShape.includeInMarketplaceTryOn.optional(),
    tryOnCategory: writableShape.tryOnCategory.optional(),
    catalogStatus: writableShape.catalogStatus.optional(),
    specs: writableShape.specs.optional(),
    fabricIds: writableShape.fabricIds.optional(),
  })
  .strict()
  .superRefine(crossFieldChecks)
  .refine((data) => Object.keys(data).length > 0, 'At least one product field must be provided for update.');

export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductInputSchema>;

// ─── RESPONSE SCHEMAS ─────────────────────────────────────────────────────────

/** What the brand sees: everything the public sees plus the brand-private fields. */
export const BrandProductOutputSchema = ProductOutputSchema.extend({
  catalogStatus: z.enum(CATALOG_STATUSES).optional(),
  includeInBrandTryOn: z.boolean().optional(),
  includeInMarketplaceTryOn: z.boolean().optional(),
  aiReferenceImage: z.string().optional(),
  costPrice: z.number().optional(),
  lowStockThreshold: z.number().int().optional(),
  warehouseLocation: z.string().optional(),
}).strip();

export const BrandProductListResponseSchema = z.object({
  products: z.array(BrandProductOutputSchema),
});

export const BrandProductCreateResponseSchema = z.object({
  message: z.string(),
  product: BrandProductOutputSchema,
});

/** The same numbers as PRODUCT_LIMITS, for GET /api/v1/products/contract. */
export function describeProductContract() {
  return {
    limits: PRODUCT_LIMITS,
    tryOnCategories: TRY_ON_CATEGORIES,
    catalogStatuses: CATALOG_STATUSES,
    skuPattern: SKU_PATTERN.source,
    tagPattern: TAG_PATTERN.source,
  };
}
