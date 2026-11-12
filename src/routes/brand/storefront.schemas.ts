import { z } from 'zod';
import { STOREFRONT_HEADER_STYLES } from '../../domain/types.js';

export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RELATIVE_ASSET_PATH_RE = /^\/(?!\/)[^\s"'<>]+$/;

export function isValidSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isValidSafeImageAsset(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true; // Empty string clears an uploaded asset
  if (trimmed.length <= 2_500_000 && SAFE_DATA_IMAGE_RE.test(trimmed)) return true;
  if (RELATIVE_ASSET_PATH_RE.test(trimmed)) return true;
  return isValidSafeHttpUrl(trimmed);
}

export const HeaderStyleSchema = z.enum(STOREFRONT_HEADER_STYLES);

export const HexColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR_RE, 'Color must be a valid hex value such as #0F172A.');

export const SafeImageAssetSchema = z
  .string()
  .trim()
  .max(2_500_000, 'Image URL or encoded payload exceeds maximum allowed size.')
  .refine((val) => isValidSafeImageAsset(val), {
    message: 'Image must be a valid HTTP(S) URL, relative asset path, or PNG/JPG/WEBP data URI.',
  });

export const SafeExternalUrlSchema = z
  .string()
  .trim()
  .max(500, 'URL must be 500 characters or fewer.')
  .refine((val) => val === '' || isValidSafeHttpUrl(val), {
    message: 'URL must start with http:// or https://.',
  });

export const NormalizedCurrencyInputSchema = z
  .string()
  .trim()
  .min(2, 'Currency code is too short.')
  .max(12, 'Currency code is too long.')
  .regex(/^[A-Za-z]{2,10}$/, 'Currency must be an alphabetic currency code (normalized to BDT).')
  .transform(() => 'BDT' as const);

export const SocialLinksInputSchema = z
  .object({
    instagram: z.string().trim().max(120).optional(),
    website: SafeExternalUrlSchema.optional(),
    facebook: z.string().trim().max(160).optional(),
  })
  .strict();

export const ButtonStyleSchema = z.enum(['pill', 'rounded', 'square']);

export const StorefrontSettingsInputSchema = z
  .object({
    primaryColor: HexColorSchema.optional(),
    secondaryColor: HexColorSchema.optional(),
    accentColor: HexColorSchema.optional(),
    backgroundColor: HexColorSchema.optional(),
    textColor: HexColorSchema.optional(),
    headingFont: z.string().trim().min(1).max(80).optional(),
    bodyFont: z.string().trim().min(1).max(80).optional(),
    buttonStyle: ButtonStyleSchema.optional(),
    headerStyle: HeaderStyleSchema.optional(),
    announcement: z.string().trim().max(300).optional(),
    aboutText: z.string().trim().max(4000).optional(),
    bannerImage: SafeImageAssetSchema.optional(),
    lightLogoUrl: SafeImageAssetSchema.optional(),
    socialImageUrl: SafeImageAssetSchema.optional(),
    onboardingCompleted: z.boolean().optional(),
    onboardingCompletedAt: z.number().finite().optional(),
    storefrontTitle: z.string().trim().max(160).optional(),
    slogan: z.string().trim().max(240).optional(),
    shortDescription: z.string().trim().max(600).optional(),
    establishedYear: z
      .string()
      .trim()
      .regex(/^(\d{4})?$/, 'Established year must be a 4-digit year (e.g. 2022).')
      .optional(),
    registrationNumber: z.string().trim().max(120).optional(),
    categoryFocus: z.string().trim().max(300).optional(),
    categories: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    ownerName: z.string().trim().max(120).optional(),
    legalName: z.string().trim().max(160).optional(),
    businessType: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    city: z.string().trim().max(100).optional(),
    country: z.string().trim().max(100).optional(),
    address: z.string().trim().max(300).optional(),
    currency: NormalizedCurrencyInputSchema.optional(),
    socialLinks: SocialLinksInputSchema.optional(),
  })
  .passthrough();

export const BrandProfileUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Brand name cannot be empty.').max(120).optional(),
    description: z.string().trim().max(3000).optional(),
    logoUrl: SafeImageAssetSchema.optional(),
    bannerUrl: SafeImageAssetSchema.optional(),
    contactEmail: z
      .union([z.literal(''), z.string().trim().email('contactEmail must be a valid email address.').max(160)])
      .optional(),
    storefrontSettings: StorefrontSettingsInputSchema.optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one brand profile field must be provided for update.'
  );

export const BrandSlugParamsSchema = z.object({
  brandSlug: z
    .string()
    .trim()
    .min(1, 'brandSlug is required.')
    .max(120)
    .regex(/^[a-z0-9-]+$/i, 'brandSlug must contain only letters, numbers, and hyphens.'),
});

export const UploadJsonInputSchema = z.object({
  imageBase64: z
    .string()
    .trim()
    .min(16, 'imageBase64 payload is required.')
    .max(14_000_000, 'Uploaded image exceeds maximum encoded size.')
    .refine((val) => /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(val), {
      message: 'Only valid PNG, JPG, JPEG, or WEBP base64 data URI uploads are allowed.',
    }),
  filename: z.string().trim().min(1).max(180).optional(),
  folder: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9/_-]+$/i, 'folder contains invalid characters.')
    .optional(),
});

export const ProductVariantSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  sku: z.string().trim().min(1).max(120),
  size: z.string().trim().min(1).max(40),
  color: z.string().trim().min(1).max(60),
  stockQuantity: z.coerce.number().finite().min(0).max(1_000_000),
  available: z.boolean(),
});

export const CreateProductInputSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required.').max(160),
  category: z.string().trim().min(1, 'Product category is required.').max(80),
  price: z.coerce.number().finite('Product price must be a finite number.').min(0, 'Product price must be non-negative.').max(10_000_000),
  sku: z.string().trim().min(1, 'Product SKU is required.').max(120),
  description: z.string().trim().max(4000).optional(),
  subCategory: z.string().trim().max(80).optional(),
  collection: z.string().trim().max(80).optional(),
  currency: NormalizedCurrencyInputSchema.optional(),
  compareAtPrice: z.coerce.number().finite().min(0).max(10_000_000).optional(),
  images: z.array(SafeImageAssetSchema).max(12).optional(),
  fabricIds: z.array(z.string().trim().min(1).max(120)).max(24).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  brandStorefrontPublished: z.boolean().optional(),
  marketplacePublished: z.boolean().optional(),
  isTryOnEligible: z.boolean().optional(),
  tryOnCategory: z.string().trim().min(1).max(60).optional(),
  specs: z.record(z.string(), z.string()).optional(),
  variants: z.array(ProductVariantSchema).max(100).optional(),
});

// ─── OUTPUT SCHEMAS ───────────────────────────────────────────────────────────

export const StorefrontSettingsOutputSchema = z
  .object({
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    accentColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    headingFont: z.string().optional(),
    bodyFont: z.string().optional(),
    buttonStyle: ButtonStyleSchema.optional(),
    headerStyle: HeaderStyleSchema.optional(),
    announcement: z.string().optional(),
    aboutText: z.string().optional(),
    bannerImage: z.string().optional(),
    lightLogoUrl: z.string().optional(),
    socialImageUrl: z.string().optional(),
    onboardingCompleted: z.boolean().optional(),
    onboardingCompletedAt: z.number().optional(),
    overviewChecklistIds: z.array(z.string()).optional(),
    storefrontTitle: z.string().optional(),
    slogan: z.string().optional(),
    shortDescription: z.string().optional(),
    establishedYear: z.string().optional(),
    registrationNumber: z.string().optional(),
    categoryFocus: z.string().optional(),
    categories: z.array(z.string()).optional(),
    ownerName: z.string().optional(),
    legalName: z.string().optional(),
    businessType: z.string().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    address: z.string().optional(),
    currency: z.literal('BDT').optional(),
    socialLinks: z
      .object({
        instagram: z.string().optional(),
        website: z.string().optional(),
        facebook: z.string().optional(),
      })
      .optional(),
  })
  .strip();

export const TenantOutputSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    logoUrl: z.string().nullable().optional(),
    bannerUrl: z.string().nullable().optional(),
    description: z.string().optional(),
    contactEmail: z.string(),
    storefrontSettings: StorefrontSettingsOutputSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strip();

export const BrandProfileGetResponseSchema = z.object({
  tenant: TenantOutputSchema,
});

export const BrandProfileMutationResponseSchema = z.object({
  message: z.string(),
  tenant: TenantOutputSchema,
});

export const BrandAnalyticsResponseSchema = z.object({
  tenantId: z.string(),
  totalProducts: z.number().int().nonnegative(),
  storefrontPublishedCount: z.number().int().nonnegative(),
  marketplacePublishedCount: z.number().int().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  lowStockWarnings: z.array(
    z.object({
      productName: z.string(),
      sku: z.string(),
      size: z.string(),
      color: z.string(),
      stock: z.number().int(),
    })
  ),
  tryOnUsage: z.object({
    used: z.number().int().nonnegative(),
    quota: z.number().int().nonnegative(),
    plan: z.string(),
  }),
});

export const PublicStorefrontTenantSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    logoUrl: z.string().nullable().optional(),
    bannerUrl: z.string().nullable().optional(),
    description: z.string().optional(),
    storefrontSettings: StorefrontSettingsOutputSchema.optional(),
  })
  .strip();

export const ProductOutputSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    category: z.string(),
    subCategory: z.string().optional(),
    collection: z.string().optional(),
    sku: z.string(),
    price: z.number(),
    compareAtPrice: z.number().optional(),
    images: z.array(z.string()),
    fabricIds: z.array(z.string()),
    tags: z.array(z.string()),
    brandStorefrontPublished: z.boolean(),
    marketplacePublished: z.boolean(),
    isTryOnEligible: z.boolean(),
    tryOnCategory: z.string(),
    specs: z.record(z.string(), z.string()).optional(),
    variants: z.array(ProductVariantSchema),
    moderationStatus: z.string().optional(),
    moderationNote: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strip();

export const PublicStorefrontResponseSchema = z.object({
  tenant: PublicStorefrontTenantSchema,
  products: z.array(ProductOutputSchema),
});

export const UploadStatusResponseSchema = z.object({
  provider: z.enum(['cloudinary', 'local_fallback']),
  cloudinaryConfigured: z.boolean(),
  cloudName: z.string().optional(),
  folder: z.string(),
  status: z.literal('ready'),
});

export const UploadResponseSchema = z.object({
  success: z.literal(true),
  provider: z.enum(['cloudinary', 'local_memory_fallback']),
  url: z.string().min(1),
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});

export const ProductListResponseSchema = z.object({
  products: z.array(ProductOutputSchema),
});

export const ProductCreateResponseSchema = z.object({
  message: z.string(),
  product: ProductOutputSchema,
});

export function formatZodValidationError(error: z.ZodError): {
  error: 'ValidationError';
  message: string;
  issues: Array<{ path: string; message: string }>;
} {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
  return {
    error: 'ValidationError',
    message: issues.map((i) => `${i.path}: ${i.message}`).join('; '),
    issues,
  };
}

export function validateZodOutput<T>(schema: z.ZodType<T>, payload: unknown, routeLabel: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Response output validation failed on ${routeLabel}: ${details}`);
  }
  return parsed.data;
}
