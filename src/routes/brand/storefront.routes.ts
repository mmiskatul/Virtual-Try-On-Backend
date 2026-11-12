import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import {
  createAdminMiddleware,
  createBrandMiddleware,
  requireRole,
} from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  STOREFRONT_HEADER_STYLES,
  StorefrontHeaderStyle,
  StorefrontSettings,
  Tenant,
} from '../../domain/types.js';
import {
  BrandAnalyticsResponseSchema,
  BrandProfileGetResponseSchema,
  BrandProfileMutationResponseSchema,
  BrandProfileUpdateInputSchema,
  BrandSlugParamsSchema,
  PublicStorefrontResponseSchema,
  StorefrontSettingsInputSchema,
  formatZodValidationError,
  validateZodOutput,
} from './storefront.schemas.js';

const brandReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandAnalyticsGuards = createBrandMiddleware(requirePermission('brand:analytics', 'read'));
const brandOwnerGuards = createBrandMiddleware(requireRole('BRAND_OWNER'));
const superAdminInternalGuards = createAdminMiddleware(requireRole('SUPER_ADMIN'));

function isSafeHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i;
const ALLOWED_HEADER_STYLES = new Set<string>(STOREFRONT_HEADER_STYLES);

function isSafeImageAssetUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return (
    (trimmed.length <= 2_500_000 && SAFE_DATA_IMAGE_RE.test(trimmed)) ||
    trimmed.startsWith('/') ||
    isSafeHttpUrl(trimmed)
  );
}

function normalizeTenantForOutput(tenant: Tenant): Tenant {
  if (!tenant.storefrontSettings) return tenant;
  const rawSettings = tenant.storefrontSettings;
  const cleanHeaderStyle: StorefrontHeaderStyle | undefined =
    rawSettings.headerStyle && ALLOWED_HEADER_STYLES.has(rawSettings.headerStyle)
      ? rawSettings.headerStyle
      : rawSettings.headerStyle
      ? 'split'
      : undefined;
  return {
    ...tenant,
    storefrontSettings: {
      ...rawSettings,
      ...(cleanHeaderStyle ? { headerStyle: cleanHeaderStyle } : {}),
      ...(rawSettings.currency ? { currency: 'BDT' } : {}),
    },
  };
}

type StorefrontTextField = Exclude<
  keyof StorefrontSettings,
  | 'primaryColor'
  | 'secondaryColor'
  | 'accentColor'
  | 'backgroundColor'
  | 'textColor'
  | 'buttonStyle'
  | 'headerStyle'
  | 'bannerImage'
  | 'lightLogoUrl'
  | 'socialImageUrl'
  | 'onboardingCompleted'
  | 'onboardingCompletedAt'
  | 'socialLinks'
  | 'categories'
  | 'overviewChecklistIds'
>;

const STOREFRONT_TEXT_FIELD_LIMITS: ReadonlyArray<[StorefrontTextField, number]> = [
  ['announcement', 200],
  ['aboutText', 2000],
  ['storefrontTitle', 160],
  ['slogan', 200],
  ['shortDescription', 320],
  ['headingFont', 80],
  ['bodyFont', 80],
  ['establishedYear', 8],
  ['registrationNumber', 120],
  ['categoryFocus', 240],
  ['ownerName', 120],
  ['legalName', 160],
  ['businessType', 80],
  ['phone', 50],
  ['city', 80],
  ['country', 80],
  ['address', 240],
  ['currency', 12],
];

const HEX_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const ALLOWED_BUTTON_STYLES = new Set(['pill', 'rounded', 'square']);

function sanitizeStorefrontSettings(raw: any, existing?: StorefrontSettings): StorefrontSettings {
  const next: StorefrontSettings = { ...(existing || {}) };
  for (const colorKey of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor', 'textColor'] as const) {
    if (typeof raw?.[colorKey] === 'string' && HEX_COLOR_RE.test(raw[colorKey].trim())) {
      next[colorKey] = raw[colorKey].trim();
    }
  }
  if (typeof raw?.buttonStyle === 'string' && ALLOWED_BUTTON_STYLES.has(raw.buttonStyle.trim())) {
    next.buttonStyle = raw.buttonStyle.trim() as StorefrontSettings['buttonStyle'];
  }
  if (typeof raw?.headerStyle === 'string' && ALLOWED_HEADER_STYLES.has(raw.headerStyle.trim() as any)) {
    next.headerStyle = raw.headerStyle.trim() as StorefrontSettings['headerStyle'];
  }
  for (const [field, maxLen] of STOREFRONT_TEXT_FIELD_LIMITS) {
    if (typeof raw?.[field] === 'string') {
      next[field] = raw[field].trim().slice(0, maxLen);
    }
  }
  if (typeof next.currency === 'string' && next.currency.trim()) {
    next.currency = 'BDT';
  }
  for (const assetKey of ['bannerImage', 'lightLogoUrl', 'socialImageUrl'] as const) {
    if (typeof raw?.[assetKey] === 'string' && !raw[assetKey].trim()) {
      next[assetKey] = '';
    } else if (isSafeImageAssetUrl(raw?.[assetKey])) {
      next[assetKey] = raw[assetKey].trim();
    }
  }
  if (Array.isArray(raw?.categories)) {
    const cleaned = Array.from(
      new Set<string>(
        raw.categories
          .filter((item: unknown): item is string => typeof item === 'string')
          .map((item: string) => item.trim().slice(0, 48))
          .filter(Boolean)
      )
    ).slice(0, 12);
    next.categories = cleaned;
  }
  if (typeof raw?.onboardingCompleted === 'boolean') {
    next.onboardingCompleted = raw.onboardingCompleted;
    if (raw.onboardingCompleted && !next.onboardingCompletedAt) {
      next.onboardingCompletedAt = Date.now();
    }
  }
  if (typeof raw?.onboardingCompletedAt === 'number' && Number.isFinite(raw.onboardingCompletedAt)) {
    next.onboardingCompletedAt = raw.onboardingCompletedAt;
  }
  if (raw?.socialLinks && typeof raw.socialLinks === 'object') {
    const prevSocial = next.socialLinks || {};
    const nextSocial = { ...prevSocial };
    if (typeof raw.socialLinks.instagram === 'string') {
      nextSocial.instagram = raw.socialLinks.instagram.trim().slice(0, 120);
    }
    if (typeof raw.socialLinks.website === 'string') {
      const trimmed = raw.socialLinks.website.trim();
      nextSocial.website = !trimmed ? '' : isSafeHttpUrl(trimmed) ? trimmed : prevSocial.website;
    }
    if (typeof raw.socialLinks.facebook === 'string') {
      nextSocial.facebook = raw.socialLinks.facebook.trim().slice(0, 160);
    }
    next.socialLinks = nextSocial;
  }
  return next;
}

export async function brandStorefrontRoutes(app: FastifyInstance) {
  // Brand Profile & Storefront Customization
  app.get('/api/v1/brand/profile', { preHandler: brandReadGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const payload = validateZodOutput(
      BrandProfileGetResponseSchema,
      { tenant: normalizeTenantForOutput(request.tenant) },
      'GET /api/v1/brand/profile'
    );
    return payload;
  });

  app.put('/api/v1/brand/profile', { preHandler: brandOwnerGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const parsedBody = BrandProfileUpdateInputSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send(formatZodValidationError(parsedBody.error));
    }
    const body = parsedBody.data;
    const updates: Partial<Tenant> = {
      name: body.name && body.name.trim() ? body.name.trim() : request.tenant.name,
      description: typeof body.description === 'string' ? body.description : request.tenant.description,
      contactEmail:
        typeof body.contactEmail === 'string' && body.contactEmail.includes('@')
          ? body.contactEmail.trim()
          : request.tenant.contactEmail,
      storefrontSettings: sanitizeStorefrontSettings(
        body.storefrontSettings,
        request.tenant.storefrontSettings
      ),
    };
    if (typeof body.logoUrl === 'string' && !body.logoUrl.trim()) {
      updates.logoUrl = '';
    } else if (isSafeImageAssetUrl(body.logoUrl)) {
      updates.logoUrl = body.logoUrl.trim();
    }
    if (typeof body.bannerUrl === 'string' && !body.bannerUrl.trim()) {
      updates.bannerUrl = '';
    } else if (isSafeImageAssetUrl(body.bannerUrl)) {
      updates.bannerUrl = body.bannerUrl.trim();
    }

    const updated = db.updateTenant(request.tenant.id, updates);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Brand tenant not found.' });
    }
    if (request.authUser) {
      db.recordAuditLog({
        tenantId: updated.id,
        actorId: request.authUser.id,
        actorRole: request.authUser.role,
        action: 'BRAND_PROFILE_UPDATED',
        entity: 'Brand Profile',
        entityId: updated.id,
        details: {
          summary: `Updated brand profile, theme tokens, or media assets for ${updated.name}`,
        },
      });
    }
    return validateZodOutput(
      BrandProfileMutationResponseSchema,
      {
        message: 'Brand profile updated successfully',
        tenant: normalizeTenantForOutput(updated),
      },
      'PUT /api/v1/brand/profile'
    );
  });

  // Dedicated storefront settings update
  app.put('/api/v1/brand/storefront-settings', { preHandler: brandOwnerGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const parsedSettings = StorefrontSettingsInputSchema.safeParse(request.body ?? {});
    if (!parsedSettings.success) {
      return reply.status(400).send(formatZodValidationError(parsedSettings.error));
    }
    const updated = db.updateTenant(request.tenant.id, {
      storefrontSettings: sanitizeStorefrontSettings(
        parsedSettings.data,
        request.tenant.storefrontSettings
      ),
    });
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Brand tenant not found.' });
    }
    return validateZodOutput(
      BrandProfileMutationResponseSchema,
      {
        message: 'Storefront settings updated successfully',
        tenant: normalizeTenantForOutput(updated),
      },
      'PUT /api/v1/brand/storefront-settings'
    );
  });

  // Brand Analytics
  app.get('/api/v1/brand/analytics', { preHandler: brandAnalyticsGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const tenantId = request.tenant.id;
    const products = db.getProductsByTenant(tenantId);
    const orders = db.getOrdersByTenant(tenantId);
    const subscription = db.getSubscription(tenantId);

    const totalRevenue = orders
      .filter(o => o.paymentStatus === 'PAID')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    const lowStockVariants = products.flatMap(p =>
      p.variants.filter(v => v.stockQuantity < 5).map(v => ({
        productName: p.name,
        sku: v.sku,
        size: v.size,
        color: v.color,
        stock: v.stockQuantity
      }))
    );

    return validateZodOutput(
      BrandAnalyticsResponseSchema,
      {
        tenantId,
        totalProducts: products.length,
        storefrontPublishedCount: products.filter(p => p.brandStorefrontPublished).length,
        marketplacePublishedCount: products.filter(p => p.marketplacePublished).length,
        totalOrders: orders.length,
        totalRevenue,
        lowStockWarnings: lowStockVariants,
        tryOnUsage: {
          used: subscription?.tryOnUsed || 0,
          quota: subscription?.tryOnMonthlyQuota || 1000,
          plan: subscription?.plan || 'PRO'
        }
      },
      'GET /api/v1/brand/analytics'
    );
  });

  // Public Storefront Discovery (returns only public storefront fields, never private contactEmail)
  app.get('/api/v1/internal/storefront/:brandSlug', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsedParams = BrandSlugParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.status(400).send(formatZodValidationError(parsedParams.error));
    }
    const { brandSlug } = parsedParams.data;
    const tenant = db.getTenantBySlug(brandSlug);
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(404).send({ error: 'NotFound', message: 'Storefront not found or inactive.' });
    }
    const normalizedTenant = normalizeTenantForOutput(tenant);
    const products = db.getStorefrontProducts(tenant.id);
    return validateZodOutput(
      PublicStorefrontResponseSchema,
      {
        tenant: {
          id: normalizedTenant.id,
          name: normalizedTenant.name,
          slug: normalizedTenant.slug,
          status: normalizedTenant.status,
          logoUrl: normalizedTenant.logoUrl,
          bannerUrl: normalizedTenant.bannerUrl,
          description: normalizedTenant.description,
          storefrontSettings: normalizedTenant.storefrontSettings,
        },
        products,
      },
      'GET /api/v1/internal/storefront/:brandSlug'
    );
  });

  // Internal Tenants Directory (protected by SUPER_ADMIN bearer token)
  app.get(
    '/api/v1/internal/tenants',
    { preHandler: superAdminInternalGuards },
    async () => {
      return { tenants: db.getTenants() };
    }
  );
}
