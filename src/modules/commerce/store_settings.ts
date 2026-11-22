import { z } from 'zod';
import type { StoreSettings, Tenant } from '../../domain/types.js';

/**
 * Store settings a brand controls: whether the store is open, how much delivery costs,
 * and how the store looks in Google and when a link is shared.
 *
 * The defaults match what checkout did before these settings existed (delivery ৳15, free from ৳150),
 * so a brand that never saves anything sees no change.
 */
export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  open: true,
  shipping: { defaultFee: 15, freeOver: 150 },
  seo: { title: '', description: '' },
};

const text = (max: number) => z.string().trim().max(max);

export const StoreSettingsInputSchema = z
  .object({
    open: z.boolean(),
    shipping: z
      .object({
        defaultFee: z.number().min(0, 'Delivery fee cannot be negative.').max(100_000, 'That delivery fee is too high.'),
        // null means "never free".
        freeOver: z.number().min(0, 'The free-delivery amount cannot be negative.').max(10_000_000).nullable(),
      })
      .partial()
      .strict(),
    seo: z
      .object({
        title: text(70),
        description: text(160),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export type StoreSettingsInput = z.infer<typeof StoreSettingsInputSchema>;

/** Saved settings laid over the defaults, so a brand that never saved anything still gets a full set. */
export function resolveStoreSettings(tenant?: Tenant | null): StoreSettings {
  const stored = (tenant?.storefrontSettings?.store || {}) as Partial<StoreSettings>;
  return {
    open: stored.open ?? DEFAULT_STORE_SETTINGS.open,
    shipping: { ...DEFAULT_STORE_SETTINGS.shipping, ...(stored.shipping || {}) },
    seo: { ...DEFAULT_STORE_SETTINGS.seo, ...(stored.seo || {}) },
  };
}

export function mergeStoreSettings(current: StoreSettings, input: StoreSettingsInput): StoreSettings {
  return {
    open: input.open ?? current.open,
    shipping: { ...current.shipping, ...(input.shipping || {}) },
    seo: { ...current.seo, ...(input.seo || {}) },
  };
}

/** The delivery fee for an order: free once the items reach the free-delivery amount, otherwise the standard fee. */
export function shippingFeeFor(settings: StoreSettings, subtotal: number): number {
  const { defaultFee, freeOver } = settings.shipping;
  if (freeOver !== null && subtotal >= freeOver) return 0;
  return Number(defaultFee.toFixed(2));
}
