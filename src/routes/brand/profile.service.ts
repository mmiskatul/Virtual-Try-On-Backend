import { z } from 'zod';
import {
  STOREFRONT_HEADER_STYLES,
  StorefrontHeaderStyle,
  StorefrontSettings,
  Tenant,
  UserRole,
} from '../../domain/types.js';
import { db } from '../../infrastructure/database.js';
import { ForbiddenException, NotFoundException } from '../../infrastructure/errors.js';
import { isValidSafeHttpUrl, isValidSafeImageAsset } from './storefront.schemas.js';
import {
  BrandDetailsPatchInputSchema,
  BrandIdentityPatchInputSchema,
  BrandMediaSlot,
} from './profile.schemas.js';

const ALLOWED_HEADER_STYLES = new Set<string>(STOREFRONT_HEADER_STYLES);
const ALLOWED_BUTTON_STYLES = new Set(['pill', 'rounded', 'square']);
const HEX_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

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
  ['announcement', 300],
  ['aboutText', 3000],
  ['storefrontTitle', 160],
  ['slogan', 240],
  ['shortDescription', 600],
  ['headingFont', 80],
  ['bodyFont', 80],
  ['establishedYear', 8],
  ['registrationNumber', 120],
  ['categoryFocus', 300],
  ['ownerName', 120],
  ['legalName', 160],
  ['businessType', 120],
  ['phone', 40],
  ['city', 100],
  ['country', 100],
  ['address', 300],
  ['currency', 12],
];

export interface BrandActorContext {
  id: string;
  role: UserRole;
}

export function requireTenantContext(tenant?: Tenant): Tenant {
  if (!tenant) {
    throw new ForbiddenException('Brand tenant context is required for this endpoint.');
  }
  return tenant;
}

export function normalizeTenantForOutput(tenant: Tenant): Tenant {
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

export function sanitizeStorefrontSettings(raw: any, existing?: StorefrontSettings): StorefrontSettings {
  const next: StorefrontSettings = { ...(existing || {}) };

  for (const colorKey of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor', 'textColor'] as const) {
    if (typeof raw?.[colorKey] === 'string' && HEX_COLOR_RE.test(raw[colorKey].trim())) {
      next[colorKey] = raw[colorKey].trim();
    }
  }

  if (typeof raw?.buttonStyle === 'string' && ALLOWED_BUTTON_STYLES.has(raw.buttonStyle.trim())) {
    next.buttonStyle = raw.buttonStyle.trim() as StorefrontSettings['buttonStyle'];
  }

  if (typeof raw?.headerStyle === 'string' && ALLOWED_HEADER_STYLES.has(raw.headerStyle.trim())) {
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
    } else if (typeof raw?.[assetKey] === 'string' && isValidSafeImageAsset(raw[assetKey])) {
      next[assetKey] = raw[assetKey].trim();
    }
  }

  if (Array.isArray(raw?.categories)) {
    next.categories = Array.from(
      new Set<string>(
        raw.categories
          .filter((item: unknown): item is string => typeof item === 'string')
          .map((item: string) => item.trim().slice(0, 48))
          .filter(Boolean)
      )
    ).slice(0, 20);
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
      nextSocial.website = !trimmed ? '' : isValidSafeHttpUrl(trimmed) ? trimmed : prevSocial.website;
    }
    if (typeof raw.socialLinks.facebook === 'string') {
      nextSocial.facebook = raw.socialLinks.facebook.trim().slice(0, 160);
    }
    next.socialLinks = nextSocial;
  }

  return next;
}

export function computeBrandVerificationSummary(tenant: Tenant) {
  const s = tenant.storefrontSettings || {};
  const checks = [
    {
      key: 'brand_name',
      label: 'Registered display brand name',
      category: 'identity' as const,
      completed: Boolean(tenant.name?.trim()),
    },
    {
      key: 'contact_email',
      label: 'Verified business contact email',
      category: 'contact' as const,
      completed: Boolean(tenant.contactEmail?.trim() && tenant.contactEmail.includes('@')),
    },
    {
      key: 'legal_entity',
      label: 'Legal entity & owner name provided',
      category: 'legal' as const,
      completed: Boolean(s.legalName?.trim() && s.ownerName?.trim()),
    },
    {
      key: 'registration_number',
      label: 'Trade license / registration number',
      category: 'legal' as const,
      completed: Boolean(s.registrationNumber?.trim()),
    },
    {
      key: 'business_address',
      label: 'Registered business phone & studio address',
      category: 'contact' as const,
      completed: Boolean(s.phone?.trim() && s.city?.trim() && s.country?.trim()),
    },
    {
      key: 'brand_logo',
      label: 'Primary brand logo uploaded',
      category: 'media' as const,
      completed: Boolean(tenant.logoUrl?.trim()),
    },
    {
      key: 'hero_banner',
      label: 'Storefront hero banner configured',
      category: 'media' as const,
      completed: Boolean(tenant.bannerUrl?.trim() || s.bannerImage?.trim()),
    },
  ];

  const completedChecks = checks.filter((c) => c.completed).length;
  const totalChecks = checks.length;
  const verificationScore = Math.round((completedChecks / totalChecks) * 100);
  const missingRequirements = checks.filter((c) => !c.completed).map((c) => c.label);

  return {
    tenantId: tenant.id,
    status: tenant.status,
    storeActive: tenant.status === 'ACTIVE',
    verificationScore,
    completedChecks,
    totalChecks,
    registrationNumber: s.registrationNumber || 'Pending review',
    legalName: s.legalName || tenant.name,
    contactEmail: tenant.contactEmail,
    checks,
    missingRequirements,
    updatedAt: tenant.updatedAt,
  };
}

function recordBrandAudit(
  tenant: Tenant,
  action: string,
  summary: string,
  actor?: BrandActorContext
) {
  if (!actor) return;
  db.recordAuditLog({
    tenantId: tenant.id,
    actorId: actor.id,
    actorRole: actor.role,
    action,
    entity: 'Brand Profile',
    entityId: tenant.id,
    details: { summary },
  });
}

export function applyBrandDetailsUpdate(
  tenant: Tenant,
  input: z.infer<typeof BrandDetailsPatchInputSchema>,
  actor?: BrandActorContext
): Tenant {
  const settingsPatch: Partial<StorefrontSettings> = {};
  if (input.owner !== undefined) settingsPatch.ownerName = input.owner;
  if (input.legalName !== undefined) settingsPatch.legalName = input.legalName;
  if (input.businessType !== undefined) settingsPatch.businessType = input.businessType;
  if (input.registrationNumber !== undefined) settingsPatch.registrationNumber = input.registrationNumber;
  if (input.establishedYear !== undefined) settingsPatch.establishedYear = input.establishedYear;
  if (input.phone !== undefined) settingsPatch.phone = input.phone;
  if (input.city !== undefined) settingsPatch.city = input.city;
  if (input.country !== undefined) settingsPatch.country = input.country;
  if (input.address !== undefined) settingsPatch.address = input.address;
  if (input.categoryFocus !== undefined) settingsPatch.categoryFocus = input.categoryFocus;
  if (input.slogan !== undefined) settingsPatch.slogan = input.slogan;
  if (input.shortDescription !== undefined) settingsPatch.shortDescription = input.shortDescription;
  if (input.announcement !== undefined) settingsPatch.announcement = input.announcement;
  if (input.description !== undefined) settingsPatch.aboutText = input.description;
  if (input.socialLinks !== undefined) settingsPatch.socialLinks = input.socialLinks;

  const updates: Partial<Tenant> = {
    ...(input.name ? { name: input.name } : {}),
    ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    storefrontSettings: sanitizeStorefrontSettings(settingsPatch, tenant.storefrontSettings),
  };

  const updated = db.updateTenant(tenant.id, updates);
  if (!updated) throw new NotFoundException('Brand tenant not found.');

  recordBrandAudit(updated, 'BRAND_DETAILS_UPDATED', `Updated core profile & legal details for ${updated.name}`, actor);
  return updated;
}

export function applyBrandIdentityUpdate(
  tenant: Tenant,
  input: z.infer<typeof BrandIdentityPatchInputSchema>,
  actor?: BrandActorContext
): Tenant {
  const updated = db.updateTenant(tenant.id, {
    storefrontSettings: sanitizeStorefrontSettings(input, tenant.storefrontSettings),
  });
  if (!updated) throw new NotFoundException('Brand tenant not found.');

  recordBrandAudit(
    updated,
    'BRAND_IDENTITY_UPDATED',
    `Updated theme palette, typography, and layout identity for ${updated.name}`,
    actor
  );
  return updated;
}

export function applyBrandMediaSlotUpdate(
  tenant: Tenant,
  slot: BrandMediaSlot,
  url: string,
  actor?: BrandActorContext
): Tenant {
  const cleanUrl = url.trim();
  const updates: Partial<Tenant> = {};

  switch (slot) {
    case 'logo':
      updates.logoUrl = cleanUrl;
      break;
    case 'banner':
      updates.bannerUrl = cleanUrl;
      updates.storefrontSettings = sanitizeStorefrontSettings({ bannerImage: cleanUrl }, tenant.storefrontSettings);
      break;
    case 'lightLogo':
      updates.storefrontSettings = sanitizeStorefrontSettings({ lightLogoUrl: cleanUrl }, tenant.storefrontSettings);
      break;
    case 'socialImage':
      updates.storefrontSettings = sanitizeStorefrontSettings({ socialImageUrl: cleanUrl }, tenant.storefrontSettings);
      break;
  }

  const updated = db.updateTenant(tenant.id, updates);
  if (!updated) throw new NotFoundException('Brand tenant not found.');

  const action = cleanUrl ? 'BRAND_MEDIA_UPDATED' : 'BRAND_MEDIA_REMOVED';
  const verb = cleanUrl ? 'Updated' : 'Removed';
  recordBrandAudit(updated, action, `${verb} ${slot} brand media asset for ${updated.name}`, actor);
  return updated;
}

export function applyBrandAggregateUpdate(
  tenant: Tenant,
  body: {
    name?: string;
    description?: string;
    contactEmail?: string;
    logoUrl?: string;
    bannerUrl?: string;
    storefrontSettings?: StorefrontSettings;
  },
  actor?: BrandActorContext
): Tenant {
  const updates: Partial<Tenant> = {
    name: body.name && body.name.trim() ? body.name.trim() : tenant.name,
    description: typeof body.description === 'string' ? body.description : tenant.description,
    contactEmail:
      typeof body.contactEmail === 'string' && body.contactEmail.includes('@')
        ? body.contactEmail.trim()
        : tenant.contactEmail,
    storefrontSettings: sanitizeStorefrontSettings(body.storefrontSettings, tenant.storefrontSettings),
  };

  if (typeof body.logoUrl === 'string' && !body.logoUrl.trim()) {
    updates.logoUrl = '';
  } else if (typeof body.logoUrl === 'string' && isValidSafeImageAsset(body.logoUrl)) {
    updates.logoUrl = body.logoUrl.trim();
  }

  if (typeof body.bannerUrl === 'string' && !body.bannerUrl.trim()) {
    updates.bannerUrl = '';
  } else if (typeof body.bannerUrl === 'string' && isValidSafeImageAsset(body.bannerUrl)) {
    updates.bannerUrl = body.bannerUrl.trim();
  }

  const updated = db.updateTenant(tenant.id, updates);
  if (!updated) throw new NotFoundException('Brand tenant not found.');

  recordBrandAudit(
    updated,
    'BRAND_PROFILE_UPDATED',
    `Updated brand profile, theme tokens, or media assets for ${updated.name}`,
    actor
  );
  return updated;
}
