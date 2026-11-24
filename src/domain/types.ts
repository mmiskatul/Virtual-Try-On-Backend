export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
export type UserRole =
  | 'SUPER_ADMIN'
  | 'BRAND_OWNER'
  | 'BRAND_ADMIN'
  | 'CATALOG_MANAGER'
  | 'INVENTORY_MANAGER'
  | 'ORDER_MANAGER'
  | 'SUPPORT_AGENT'
  | 'ANALYTICS_VIEWER'
  | 'STORE_MANAGER'
  | 'CUSTOMER';
export type AuthPortal = 'marketplace' | 'brand' | 'admin';
export type AuthTokenType = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
export type TryOnCategory = 'tops' | 'bottoms' | 'dresses' | 'outerwear' | 'all';
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';
export type SubscriptionPlan = 'STARTER' | 'PRO' | 'ENTERPRISE';

export const STOREFRONT_HEADER_STYLES = [
  'split',
  'split-reverse',
  'minimal',
  'centered',
  'cover',
  'magazine',
  'grid-showcase',
  'noir-boutique',
] as const;

export type StorefrontHeaderStyle = (typeof STOREFRONT_HEADER_STYLES)[number];

/** Public try-on experience settings saved per brand (inside storefrontSettings, no extra column needed). */
export interface TryOnSettings {
  enabled: boolean;
  publicPageActive: boolean;
  requireConsent: boolean;
  retentionDays: number;
  privacyPolicyUrl: string;
  termsUrl: string;
  dataProcessingNotice: string;
  appearance: {
    pageTitle: string;
    pageDescription: string;
    uploadInstructions: string;
    primaryBtnText: string;
    uploadBtnText: string;
    generateBtnText: string;
    retryBtnText: string;
    loadingText: string;
    successText: string;
    errorText: string;
    accentColor: string;
    backgroundColor: string;
    gridStyle: '3-col' | '4-col' | 'editorial';
    previewLayout: 'split' | 'centered';
    showPrices: boolean;
    showRatings: boolean;
  };
}

/** A discount / coupon code a brand offers at checkout. Stored inside storefrontSettings. */
export interface DiscountRecord {
  id: string;
  code: string; // always upper case
  description?: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  minOrder: number;
  maxUses: number | null;
  usedCount: number;
  startsAt: number | null;
  endsAt: number | null;
  active: boolean;
  createdAt: number;
}

/** A pending / past team invitation. Only a hash of the token is stored. */
export interface TeamInviteRecord {
  id: string;
  email: string;
  role: UserRole;
  tokenHash: string;
  invitedBy: string;
  invitedAt: number;
  expiresAt: number;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  settledAt?: number;
}

export type ApiScope = 'products:read' | 'products:write' | 'orders:read' | 'orders:write';
export const API_SCOPES: ApiScope[] = ['products:read', 'products:write', 'orders:read', 'orders:write'];

/** A server-generated API key. Only a hash is stored: the key itself is shown once, at creation. */
export interface ApiKeyRecord {
  id: string;
  name: string;
  last4: string;
  hash: string;
  scopes: ApiScope[];
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
  lastUsedAt: number | null;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt?: number;
}

export type WebhookEventType = 'order.created' | 'order.status_changed' | 'inventory.low_stock' | 'ping';
export const WEBHOOK_EVENTS: Exclude<WebhookEventType, 'ping'>[] = ['order.created', 'order.status_changed', 'inventory.low_stock'];

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  description?: string;
  events: Exclude<WebhookEventType, 'ping'>[];
  secretEnc: string; // encrypted at rest; never returned by the API after creation
  active: boolean;
  createdAt: number;
  consecutiveFailures: number;
  lastDeliveryAt: number | null;
  lastStatus: 'SUCCESS' | 'FAILED' | null;
  disabledReason?: string;
}

/** Extra access and sign-in state for one team member (see modules/team/team_access.ts). */
export interface TeamAccessRecord {
  extraPermissions: string[];
  mustChangePassword: boolean;
  disabled: boolean;
}

/** Store settings a brand controls (see modules/commerce/store_settings.ts). */
export interface StoreSettings {
  open: boolean;
  shipping: { defaultFee: number; freeOver: number | null };
  seo: { title: string; description: string };
  /** Who the whole store is for. UNISEX means both: shoppers choose on the try-on page. */
  audience: ProductAudience;
  /** The return policy shoppers read. `windowDays` null means no set return window. */
  returns: { policy: string; windowDays: number | null };
}

export interface StorefrontSettings {
  tryOn?: TryOnSettings;
  store?: StoreSettings;
  teamAccess?: Record<string, TeamAccessRecord>;
  apiKeys?: ApiKeyRecord[];
  webhooks?: WebhookEndpointRecord[];
  discounts?: DiscountRecord[];
  teamInvites?: TeamInviteRecord[];
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  headingFont?: string;
  bodyFont?: string;
  buttonStyle?: 'pill' | 'rounded' | 'square';
  headerStyle?: StorefrontHeaderStyle;
  announcement?: string;
  aboutText?: string;
  bannerImage?: string;
  lightLogoUrl?: string;
  socialImageUrl?: string;
  onboardingCompleted?: boolean;
  onboardingCompletedAt?: number;
  overviewChecklistIds?: string[];
  storefrontTitle?: string;
  slogan?: string;
  shortDescription?: string;
  establishedYear?: string;
  registrationNumber?: string;
  categoryFocus?: string;
  categories?: string[];
  ownerName?: string;
  legalName?: string;
  businessType?: string;
  phone?: string;
  city?: string;
  country?: string;
  address?: string;
  currency?: string;
  socialLinks?: {
    instagram?: string;
    website?: string;
    facebook?: string;
  };
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  logoUrl?: string;
  bannerUrl?: string;
  description?: string;
  contactEmail: string;
  storefrontSettings?: StorefrontSettings;
  createdAt: number;
  updatedAt: number;
}

export interface User {
  id: string;
  tenantId?: string; // Optional for SUPER_ADMIN or CUSTOMER
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  emailVerified?: boolean;
  emailVerifiedAt?: number;
  updatedAt?: number;
  createdAt: number;
}

export interface AuthToken {
  id: string;
  userId: string;
  email: string;
  type: AuthTokenType;
  tokenHash: string;
  otpCodeHash?: string;
  portal: AuthPortal;
  expiresAt: number;
  usedAt?: number;
  createdAt: number;
}

export interface ProductVariant {
  id: string;
  sku: string;
  size: string;
  color: string;
  stockQuantity: number;
  available: boolean;
  /** Price for this size. When missing, the product's own price applies. */
  price?: number;
  /** Photo of this colour (the same for every size of that colour). */
  imageUrl?: string;
  /** Brand-private: alert when this size (all colours together) falls below this many pieces. */
  lowStockThreshold?: number;
  /** Brand-private: clear flat photo of this colour for the AI try-on. Falls back to the product's aiReferenceImage. */
  aiImageUrl?: string;
}

export type CatalogStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED';

/** Who a garment is made for. UNISEX means both men and women. */
export const PRODUCT_AUDIENCES = ['WOMEN', 'MEN', 'UNISEX'] as const;
export type ProductAudience = (typeof PRODUCT_AUDIENCES)[number];

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  /** Short catalog-card summary (max 160 chars). */
  shortDescription?: string;
  description: string;
  category: string;
  subCategory?: string;
  collection?: string;
  sku: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  fabricIds: string[];
  tags: string[];
  brandStorefrontPublished: boolean;
  marketplacePublished: boolean;
  isTryOnEligible: boolean;
  tryOnCategory: TryOnCategory;
  /** Show this product on the brand's own try-on page. */
  includeInBrandTryOn?: boolean;
  /** Show this product in the marketplace try-on (only when also published to the marketplace). */
  includeInMarketplaceTryOn?: boolean;
  /** Clear flat photo of the garment given to the AI model. Never shown to shoppers. */
  aiReferenceImage?: string;
  /** Brand-private: what the garment costs the brand. Never exposed publicly. */
  costPrice?: number;
  /** Brand-private: alert when stock falls below this number. */
  lowStockThreshold?: number;
  /** Brand-private: where the stock is kept. */
  warehouseLocation?: string;
  catalogStatus?: CatalogStatus;
  /** Who this garment is for: women, men, or both. Older products without a value count as both. */
  audience?: ProductAudience;
  specs?: Record<string, string>;
  variants: ProductVariant[];
  createdAt: number;
  updatedAt: number;
}

export interface Fabric {
  id: string;
  tenantId: string;
  name: string;
  composition: string;
  color: string;
  pattern: string;
  textureUrl?: string;
  weightGsm?: number;
  stretch?: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  transparency?: 'OPAQUE' | 'SEMI_SHEER' | 'SHEER';
  thickness?: 'LIGHT' | 'MEDIUM' | 'HEAVY';
  careInstructions?: string;
  createdAt: number;
}

export interface InventoryLog {
  id: string;
  tenantId: string;
  productId: string;
  variantSku: string;
  change: number;
  newStock: number;
  reason: string;
  timestamp: number;
}

export interface OrderItem {
  productId: string;
  variantSku: string;
  productName: string;
  size: string;
  color: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  imageUrl?: string;
}

export interface ShippingAddress {
  fullName: string;
  street: string;
  city: string;
  state?: string;
  zipCode: string;
  country: string;
}

export interface Order {
  id: string;
  tenantId: string; // Enforces single-seller order requirement
  customerId?: string;
  customerEmail: string;
  shippingAddress: ShippingAddress;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  totalAmount: number;
  discountAmount?: number; // not stored in the database: derivable as subtotal + shippingFee - totalAmount
  couponCode?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Subscription {
  tenantId: string;
  plan: SubscriptionPlan;
  productLimit: number;
  tryOnMonthlyQuota: number;
  tryOnUsed: number;
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELLED';
  /** Epoch ms when a trial ends. Only meaningful while status is TRIALING. */
  trialEndsAt?: number;
  updatedAt: number;
}

export interface AuditLog {
  id: string;
  tenantId?: string;
  actorId: string;
  actorRole: UserRole;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, any>;
  timestamp: number;
}

export interface AuthTokenPayload {
  userId: string;
  role: UserRole;
  tenantId?: string;
  email?: string;
}

export type GenerationStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type LedgerStatus = 'RESERVED' | 'CONSUMED' | 'RELEASED';

export interface GenerationJob {
  id: string;
  tenantId: string; // always derived server-side from the product, never from the client
  productId: string;
  category: string;
  status: GenerationStatus;
  accessTokenHash: string; // hash of the secret returned to the originating guest session
  idempotencyKey?: string;
  providerJobId?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UsageLedgerEntry {
  id: string;
  generationId: string; // unique: one ledger entry per generation
  tenantId: string;
  billingPeriod: string; // YYYY-MM
  reservedUnits: number;
  finalUnits?: number;
  status: LedgerStatus;
  createdAt: number;
  updatedAt: number;
}
