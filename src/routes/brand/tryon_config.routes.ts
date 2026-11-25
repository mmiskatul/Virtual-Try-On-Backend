import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import {
  TryOnSettingsInputSchema,
  mergeTryOnSettings,
  resolveTryOnSettings,
} from '../../modules/tryon/tryon_settings.js';
import { requireTenantContext } from './profile.service.js';
import { z } from 'zod';
import { garmentInfoFromProduct } from '../../modules/tryon/garment_info.js';
import { parseShopperFit } from '../../modules/tryon/shopper_fit.js';
import { tryOnEngine } from '../../modules/tryon/tryon.engine.js';
import {
  PROMPT_VERSION,
  STYLE_OPTIONS,
  buildTryOnPrompt,
  garmentRegion,
  promptStyleForModel,
  resolveStyleOptions,
  styleOptionsFor,
} from '../../modules/tryon/tryon_prompt.js';

const PromptPreviewSchema = z.object({
  productId: z.string().min(1),
  /** The colour photo the shopper would pick (its address), so the preview can name the colour. */
  garmentImageUrl: z.string().optional(),
  colour: z.string().max(40).optional(),
  gender: z.string().optional(),
  size: z.string().optional(),
  garmentSize: z.string().optional(),
  styleOptions: z.array(z.string().max(30)).max(12).optional(),
});

const readGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const ownerGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

export async function brandTryOnConfigRoutes(app: FastifyInstance) {
  // Brand: read the saved try-on experience settings
  app.get('/api/v1/brand/try-on-config', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { config: resolveTryOnSettings(tenant) };
  });

  // Brand owner: save the try-on experience settings
  app.put('/api/v1/brand/try-on-config', { preHandler: ownerGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(TryOnSettingsInputSchema, request.body ?? {});
    const merged = mergeTryOnSettings(resolveTryOnSettings(tenant), input);
    const updated = db.updateTenant(tenant.id, {
      storefrontSettings: { ...(tenant.storefrontSettings || {}), tryOn: merged },
    });
    if (!updated) throw new NotFoundException('Brand tenant not found.');
    await recordAudit({
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      tenantId: tenant.id,
      action: 'BRAND_TRYON_CONFIG_UPDATED',
      entity: 'TryOnSettings',
      entityId: tenant.id,
      correlationId: request.correlationId,
    });
    return { message: 'Try-on settings saved.', config: resolveTryOnSettings(updated) };
  });

  /**
   * Show the exact prompt a try-on would send for a product, a size and some styling, WITHOUT calling the AI.
   * It costs nothing, so brands and admins can check and tune the wording as often as they like.
   */
  app.post('/api/v1/brand/try-on/prompt-preview', { preHandler: readGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(PromptPreviewSchema, request.body ?? {});
    const product = db.getProductById(input.productId, tenant.id);
    if (!product) throw new NotFoundException('Product not found.');

    const fabrics = (product.fabricIds || []).map((id) => db.getFabricById(id, tenant.id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const garment = garmentInfoFromProduct(product, { imageUrl: input.garmentImageUrl, colour: input.colour, fabrics });
    const category = product.tryOnCategory && product.tryOnCategory !== 'all' ? product.tryOnCategory : 'tops';
    const shopper = parseShopperFit({ gender: input.gender, size: input.size, garmentSize: input.garmentSize });
    const model = tryOnEngine.imageModel();
    const style = promptStyleForModel(model);
    const region = garmentRegion(garment, category);
    const base = { category, garment, shopper, styleOptions: input.styleOptions, style } as const;
    const full = buildTryOnPrompt(base);
    const compact = buildTryOnPrompt({ ...base, compact: true });

    return {
      note: 'This is a preview only. No picture was made and nothing was charged.',
      model,
      promptStyle: style,
      promptVersion: PROMPT_VERSION,
      garmentKind: region,
      prompt: { full, compact },
      length: { full: full.length, compact: compact.length },
      usedStyleOptions: resolveStyleOptions(input.styleOptions, region),
      availableStyleOptions: styleOptionsFor(region).map((id) => ({ id, text: STYLE_OPTIONS[id].text })),
      garment,
    };
  });

  // Public: what the shopper-facing try-on page needs (nothing private lives in these settings)
  app.get('/api/v1/brands/:slug/try-on-config', async (request: FastifyRequest) => {
    const { slug } = request.params as { slug: string };
    const tenant = db.getTenantBySlug(String(slug || '').toLowerCase());
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException('Brand not found.');
    }
    return { config: resolveTryOnSettings(tenant) };
  });
}
