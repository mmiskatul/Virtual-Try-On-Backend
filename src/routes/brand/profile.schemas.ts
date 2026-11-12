import { z } from 'zod';
import {
  ButtonStyleSchema,
  HeaderStyleSchema,
  HexColorSchema,
  SafeImageAssetSchema,
  SocialLinksInputSchema,
  TenantOutputSchema,
  isValidSafeImageAsset,
} from './storefront.schemas.js';

export const BRAND_MEDIA_SLOTS = ['logo', 'banner', 'lightLogo', 'socialImage'] as const;
export type BrandMediaSlot = (typeof BRAND_MEDIA_SLOTS)[number];

export const BrandMediaSlotSchema = z.enum(BRAND_MEDIA_SLOTS, {
  message: `Media slot must be one of: ${BRAND_MEDIA_SLOTS.join(', ')}.`,
});

export const EstablishedYearSchema = z
  .string()
  .trim()
  .refine(
    (val) => {
      if (val === '') return true;
      if (!/^\d{4}$/.test(val)) return false;
      const year = Number(val);
      return year >= 1850 && year <= new Date().getFullYear() + 1;
    },
    {
      message: `Established year must be a 4-digit year between 1850 and ${new Date().getFullYear() + 1}.`,
    }
  );

export const PhoneNumberSchema = z
  .string()
  .trim()
  .max(40, 'Phone number must be 40 characters or fewer.')
  .refine((val) => val === '' || /^[+\d\s()./-]{5,40}$/.test(val), {
    message: 'Phone number contains invalid characters.',
  });

export const BrandDetailsPatchInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Brand name cannot be empty.').max(120, 'Brand name max length is 120.').optional(),
    contactEmail: z
      .union([z.literal(''), z.string().trim().email('contactEmail must be a valid email address.').max(160)])
      .optional(),
    owner: z.string().trim().max(120, 'Owner name max length is 120.').optional(),
    legalName: z.string().trim().max(160, 'Legal entity name max length is 160.').optional(),
    businessType: z.string().trim().max(120, 'Business type max length is 120.').optional(),
    registrationNumber: z.string().trim().max(120, 'Registration number max length is 120.').optional(),
    establishedYear: EstablishedYearSchema.optional(),
    phone: PhoneNumberSchema.optional(),
    city: z.string().trim().max(100, 'City max length is 100.').optional(),
    country: z.string().trim().max(100, 'Country max length is 100.').optional(),
    address: z.string().trim().max(300, 'Address max length is 300.').optional(),
    categoryFocus: z.string().trim().max(300, 'Category focus max length is 300.').optional(),
    slogan: z.string().trim().max(240, 'Slogan max length is 240.').optional(),
    shortDescription: z.string().trim().max(600, 'Short description max length is 600.').optional(),
    description: z.string().trim().max(3000, 'Description max length is 3000.').optional(),
    announcement: z.string().trim().max(300, 'Announcement max length is 300.').optional(),
    socialLinks: SocialLinksInputSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one brand profile detail field must be provided.',
  });

export const BrandIdentityPatchInputSchema = z
  .object({
    storefrontTitle: z
      .string()
      .trim()
      .min(1, 'Storefront title cannot be blank when provided.')
      .max(160, 'Storefront title max length is 160.')
      .optional(),
    primaryColor: HexColorSchema.optional(),
    secondaryColor: HexColorSchema.optional(),
    accentColor: HexColorSchema.optional(),
    backgroundColor: HexColorSchema.optional(),
    textColor: HexColorSchema.optional(),
    headingFont: z.string().trim().min(1, 'Heading font cannot be empty.').max(80).optional(),
    bodyFont: z.string().trim().min(1, 'Body font cannot be empty.').max(80).optional(),
    buttonStyle: ButtonStyleSchema.optional(),
    headerStyle: HeaderStyleSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one theme or identity field must be provided.',
  });

export const BrandMediaSlotParamsSchema = z.object({
  slot: BrandMediaSlotSchema,
});

export const BrandMediaSlotPutInputSchema = z
  .object({
    url: SafeImageAssetSchema.refine((val) => val.trim().length > 0, {
      message: 'A non-empty valid image URL or uploaded asset path is required. Use DELETE to remove.',
    }).refine((val) => isValidSafeImageAsset(val), {
      message: 'Asset URL must be a valid HTTP(S) URL, relative upload path, or image data URI.',
    }),
  })
  .strict();

export const BrandVerificationCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.enum(['identity', 'legal', 'contact', 'media']),
  completed: z.boolean(),
});

export const BrandVerificationResponseSchema = z.object({
  tenantId: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION']),
  storeActive: z.boolean(),
  verificationScore: z.number().int().min(0).max(100),
  completedChecks: z.number().int().min(0),
  totalChecks: z.number().int().min(1),
  registrationNumber: z.string(),
  legalName: z.string(),
  contactEmail: z.string(),
  checks: z.array(BrandVerificationCheckSchema),
  missingRequirements: z.array(z.string()),
  updatedAt: z.number(),
});

export const BrandSectionMutationResponseSchema = z.object({
  message: z.string(),
  section: z.enum(['profile', 'identity', 'media']),
  tenant: TenantOutputSchema,
  verification: BrandVerificationResponseSchema.optional(),
});

export const BrandMediaMutationResponseSchema = z.object({
  message: z.string(),
  slot: BrandMediaSlotSchema,
  url: z.string(),
  tenant: TenantOutputSchema,
});
