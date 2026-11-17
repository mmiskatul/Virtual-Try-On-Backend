import { z } from 'zod';
import type { Tenant, TryOnSettings } from '../../domain/types.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const text = (max: number) => z.string().trim().max(max);
const safeUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || v.startsWith('/') || /^https:\/\/[^\s]+$/i.test(v), 'Use an https:// link or a path starting with /');

export const DEFAULT_TRYON_SETTINGS: TryOnSettings = {
  enabled: true,
  publicPageActive: true,
  requireConsent: true,
  retentionDays: 30,
  privacyPolicyUrl: '',
  termsUrl: '',
  dataProcessingNotice:
    'Uploaded photographs are used only to create your temporary try-on preview and are deleted according to our retention policy.',
  appearance: {
    pageTitle: 'Virtual Fitting Studio',
    pageDescription: 'Preview how our garments look on you before you order.',
    uploadInstructions: 'Upload a clear front-facing photo with even lighting and unobstructed shoulders.',
    primaryBtnText: 'Try It On',
    uploadBtnText: 'Upload Your Photo',
    generateBtnText: 'Generate My Look',
    retryBtnText: 'Try Another Outfit',
    loadingText: 'Creating your preview...',
    successText: 'Your preview is ready. Slide to compare with the original.',
    errorText: 'We could not finish your preview. Please try again with another photo.',
    accentColor: '#0F172A',
    backgroundColor: '#FFFFFF',
    gridStyle: '4-col',
    previewLayout: 'split',
    showPrices: true,
    showRatings: true,
  },
};

const AppearanceInput = z
  .object({
    pageTitle: text(80),
    pageDescription: text(300),
    uploadInstructions: text(300),
    primaryBtnText: text(32),
    uploadBtnText: text(32),
    generateBtnText: text(32),
    retryBtnText: text(32),
    loadingText: text(120),
    successText: text(160),
    errorText: text(200),
    accentColor: z.string().regex(HEX, 'Use a 6-digit hex color like #0F172A'),
    backgroundColor: z.string().regex(HEX, 'Use a 6-digit hex color like #FFFFFF'),
    gridStyle: z.enum(['3-col', '4-col', 'editorial']),
    previewLayout: z.enum(['split', 'centered']),
    showPrices: z.boolean(),
    showRatings: z.boolean(),
  })
  .partial()
  .strict();

/** PUT body: every field is optional, unknown fields are rejected. */
export const TryOnSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    publicPageActive: z.boolean(),
    requireConsent: z.boolean(),
    retentionDays: z.number().int().min(1).max(365),
    privacyPolicyUrl: safeUrl,
    termsUrl: safeUrl,
    dataProcessingNotice: text(1000),
    appearance: AppearanceInput,
  })
  .partial()
  .strict();

export type TryOnSettingsInput = z.infer<typeof TryOnSettingsInputSchema>;

/** Stored settings merged over the defaults (so a brand that never saved anything still gets a full config). */
export function resolveTryOnSettings(tenant?: Tenant | null): TryOnSettings {
  const stored = (tenant?.storefrontSettings?.tryOn || {}) as Partial<TryOnSettings>;
  return {
    ...DEFAULT_TRYON_SETTINGS,
    ...stored,
    appearance: { ...DEFAULT_TRYON_SETTINGS.appearance, ...(stored.appearance || {}) },
  };
}

export function mergeTryOnSettings(current: TryOnSettings, input: TryOnSettingsInput): TryOnSettings {
  const { appearance, ...rest } = input;
  return {
    ...current,
    ...rest,
    appearance: { ...current.appearance, ...(appearance || {}) },
  };
}
