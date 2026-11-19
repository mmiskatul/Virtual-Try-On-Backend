import type { CatalogStatus, Product } from './types.js';

/**
 * Product fields that live together in one JSON column (`catalog_meta`) so every database adapter
 * stores and reads them the same way. Add a field here and it is persisted everywhere.
 */
export interface ProductMeta {
  shortDescription?: string;
  includeInBrandTryOn?: boolean;
  includeInMarketplaceTryOn?: boolean;
  aiReferenceImage?: string;
  costPrice?: number;
  lowStockThreshold?: number;
  warehouseLocation?: string;
  catalogStatus?: CatalogStatus;
}

const META_KEYS: Array<keyof ProductMeta> = [
  'shortDescription',
  'includeInBrandTryOn',
  'includeInMarketplaceTryOn',
  'aiReferenceImage',
  'costPrice',
  'lowStockThreshold',
  'warehouseLocation',
  'catalogStatus',
];

/** True when an update touches any meta field (even to clear it). */
export function hasProductMetaUpdate(updates: Partial<Product>): boolean {
  return META_KEYS.some((key) => key in updates);
}

/**
 * Builds the JSON stored in the database from a full product. Empty values are left out, so clearing a
 * field (setting it to undefined, null or an empty string) removes it.
 */
export function packProductMeta(product: Partial<Product>): ProductMeta {
  const meta: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    const value = product[key] as unknown;
    if (value === undefined || value === null || value === '') continue;
    meta[key] = value;
  }
  return meta as ProductMeta;
}

/** Reads the stored JSON back into product fields. Accepts a string, an object or nothing. */
export function unpackProductMeta(raw: unknown): ProductMeta {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    if (source[key] !== undefined && source[key] !== null) meta[key] = source[key];
  }
  return meta as ProductMeta;
}

const PRIVATE_PRODUCT_KEYS = [
  'costPrice',
  'lowStockThreshold',
  'warehouseLocation',
  'aiReferenceImage',
  'catalogStatus',
  'includeInBrandTryOn',
  'includeInMarketplaceTryOn',
] as const;

/**
 * The shopper-safe view of a product. Brand-private data (cost price, warehouse, low-stock alert, the AI
 * reference photo, catalog status) and system spec keys (starting with "_") never leave the brand's own
 * dashboard. Use this at every public boundary.
 */
export function toPublicProduct<T extends Partial<Product>>(product: T): T {
  const copy: Record<string, unknown> = { ...product };
  for (const key of PRIVATE_PRODUCT_KEYS) delete copy[key];
  if (Array.isArray(copy.variants)) {
    // The low-stock alert level of a size is brand-private.
    copy.variants = (copy.variants as Array<Record<string, unknown>>).map((variant) => {
      const { lowStockThreshold: _alert, aiImageUrl: _ai, ...shopperSafe } = variant;
      return shopperSafe;
    });
  }
  if (copy.specs && typeof copy.specs === 'object') {
    copy.specs = Object.fromEntries(
      Object.entries(copy.specs as Record<string, string>).filter(([key]) => !key.startsWith('_'))
    );
  }
  return copy as T;
}
