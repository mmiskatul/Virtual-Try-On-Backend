import type { Fabric, Product } from '../../domain/types.js';
import { db } from '../../infrastructure/database.js';
import { cleanText, type GarmentInfo } from './tryon_prompt.js';

/**
 * Collect what the shop knows about a garment, from the product record, so the try-on prompt can describe it.
 * This is read on the server from the catalogue; the browser never decides what the garment is.
 */
export function garmentInfoFromProduct(
  product: Product | undefined | null,
  ctx: { imageUrl?: string; colour?: string; fabrics?: Fabric[] } = {}
): GarmentInfo | undefined {
  if (!product) return undefined;

  // The colour: the variant whose photo the shopper picked, otherwise a colour the client named.
  const variant = ctx.imageUrl
    ? (product.variants || []).find((v) => v.imageUrl === ctx.imageUrl || v.aiImageUrl === ctx.imageUrl)
    : undefined;
  const colour = cleanText(variant?.color || ctx.colour, 40);

  const fabrics = (ctx.fabrics || []).filter(Boolean);
  const fabric = fabrics
    .map((f) => [f.name, f.composition, f.stretch && f.stretch !== 'NONE' ? `${f.stretch.toLowerCase()} stretch` : '', f.thickness ? `${f.thickness.toLowerCase()} weight` : ''].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' / ');
  const pattern = fabrics.map((f) => f.pattern).find((p) => p && !/^(solid|plain|none)$/i.test(p));

  const specs: Record<string, string> = {};
  for (const [k, v] of Object.entries(product.specs || {})) {
    if (k.startsWith('_') || typeof v !== 'string') continue;
    specs[k] = v;
  }

  return {
    name: cleanText(product.name, 100),
    type: cleanText(product.subCategory || product.category, 60),
    colour: colour || undefined,
    fabric: cleanText(fabric, 120) || undefined,
    pattern: cleanText(pattern, 60) || undefined,
    details: cleanText(product.shortDescription || product.description, 240) || undefined,
    specs: Object.keys(specs).length ? specs : undefined,
    audience: product.audience === 'WOMEN' ? 'women' : product.audience === 'MEN' ? 'men' : product.audience === 'UNISEX' ? 'both' : undefined,
    tags: (product.tags || []).map((t) => cleanText(t, 30)).filter(Boolean),
  };
}

/** Look the product up and describe it. Returns nothing (and never throws) when the product is unknown. */
export function lookupGarmentInfo(productId: unknown, imageUrl?: string, colour?: unknown): GarmentInfo | undefined {
  if (typeof productId !== 'string' || !productId) return undefined;
  try {
    const product = db.getProductById(productId);
    if (!product) return undefined;
    const fabrics = (product.fabricIds || [])
      .map((id) => db.getFabricById(id, product.tenantId))
      .filter((f): f is Fabric => Boolean(f));
    return garmentInfoFromProduct(product, { imageUrl, colour: typeof colour === 'string' ? colour : undefined, fabrics });
  } catch {
    return undefined;
  }
}
