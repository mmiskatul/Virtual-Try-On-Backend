import type { Product } from './types.js';

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface LowSize {
  size: string;
  /** Pieces left in this size, added up across all its colours. */
  stock: number;
  /** The alert level the brand set for this size. */
  threshold: number;
}

/** Pieces per size, added up across colours. */
export function sizeStockTotals(product: Pick<Product, 'variants'>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const v of product.variants || []) totals.set(v.size, (totals.get(v.size) ?? 0) + (v.stockQuantity || 0));
  return totals;
}

/** The alert level a brand set for a size (all colours of a size share one). Undefined when none was set. */
export function sizeAlertLevel(product: Pick<Product, 'variants'>, size: string): number | undefined {
  const own = (product.variants || []).find((v) => v.size === size && typeof v.lowStockThreshold === 'number');
  return own?.lowStockThreshold;
}

/** Sizes that are below the alert level the brand set for them. Sizes without their own level are not listed. */
export function lowStockSizes(product: Pick<Product, 'variants'>): LowSize[] {
  const out: LowSize[] = [];
  for (const [size, stock] of sizeStockTotals(product)) {
    const threshold = sizeAlertLevel(product, size);
    if (threshold !== undefined && stock < threshold) out.push({ size, stock, threshold });
  }
  return out;
}
