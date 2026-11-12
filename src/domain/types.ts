export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
export type UserRole = 'SUPER_ADMIN' | 'BRAND_OWNER' | 'STORE_MANAGER' | 'CUSTOMER';
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

export interface StorefrontSettings {
  primaryColor?: string;
  accentColor?: string;
  headerStyle?: StorefrontHeaderStyle;
  announcement?: string;
  aboutText?: string;
  bannerImage?: string;
  onboardingCompleted?: boolean;
  onboardingCompletedAt?: number;
  overviewChecklistIds?: string[];
  storefrontTitle?: string;
  slogan?: string;
  shortDescription?: string;
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
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
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
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
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
