import { z } from 'zod';

export const OVERVIEW_PERIODS = ['today', '7d', '30d', '90d', 'custom'] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

export const OVERVIEW_CHECKLIST_IDS = [
  'chk_profile',
  'chk_logo',
  'chk_cover',
  'chk_biz',
  'chk_product',
  'chk_variants',
  'chk_storefront',
  'chk_tryon',
  'chk_publish',
  'chk_test_tryon',
] as const;

export type OverviewChecklistId = (typeof OVERVIEW_CHECKLIST_IDS)[number];

export const OverviewTimeseriesQuerySchema = z
  .object({
    period: z.enum(OVERVIEW_PERIODS).default('7d'),
    startDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be formatted as YYYY-MM-DD.')
      .optional(),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be formatted as YYYY-MM-DD.')
      .optional(),
  })
  .refine(
    (q) => {
      if (!q.startDate || !q.endDate) return true;
      return new Date(q.startDate).getTime() <= new Date(q.endDate).getTime();
    },
    { message: 'startDate must be earlier than or equal to endDate.' }
  );

export const OverviewActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

export const OverviewChecklistUpdateInputSchema = z
  .object({
    toggleId: z.enum(OVERVIEW_CHECKLIST_IDS).optional(),
    completedIds: z.array(z.enum(OVERVIEW_CHECKLIST_IDS)).max(OVERVIEW_CHECKLIST_IDS.length).optional(),
  })
  .refine(
    (data) => Boolean(data.toggleId) || Array.isArray(data.completedIds),
    'Either toggleId or completedIds must be provided.'
  );

// ─── OUTPUT SCHEMAS ───────────────────────────────────────────────────────────

export const OverviewSummaryResponseSchema = z.object({
  currency: z.literal('BDT'),
  generatedAt: z.number().int().nonnegative(),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logoUrl: z.string().nullable().optional(),
    status: z.string(),
    plan: z.string(),
    storeStatus: z.enum(['LIVE', 'MAINTENANCE']),
    marketplaceStatus: z.enum(['CONNECTED', 'NOT_CONNECTED']),
    tryOnStatus: z.enum(['TRY-ON ACTIVE', 'PAUSED']),
  }),
  kpis: z.object({
    totalRevenue: z.number().nonnegative(),
    revenueChangeLabel: z.string(),
    totalOrders: z.number().int().nonnegative(),
    ordersChangeLabel: z.string(),
    totalProducts: z.number().int().nonnegative(),
    publishedStorefrontProducts: z.number().int().nonnegative(),
    publishedMarketplaceProducts: z.number().int().nonnegative(),
    totalCustomers: z.number().int().nonnegative(),
    marketplaceViews: z.number().int().nonnegative(),
    productSalesUnits: z.number().int().nonnegative(),
    tryOnSessionsCount: z.number().int().nonnegative(),
    tryOnUsed: z.number().int().nonnegative(),
    tryOnQuota: z.number().int().nonnegative(),
    tryOnCreditsLeft: z.number().int().nonnegative(),
  }),
  salesOverview: z.object({
    totalRevenue: z.number().nonnegative(),
    paidOrders: z.number().int().nonnegative(),
    pendingOrders: z.number().int().nonnegative(),
    cancelledOrders: z.number().int().nonnegative(),
    refundedOrders: z.number().int().nonnegative(),
    averageOrderValue: z.number().nonnegative(),
  }),
  tryOnPerformance: z.object({
    loggedSessions: z.number().int().nonnegative(),
    successful: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    processingOrQueued: z.number().int().nonnegative(),
    avgSpeedSec: z.number().nonnegative(),
    cartConversions: z.number().int().nonnegative(),
    attributedOrders: z.number().int().nonnegative(),
    attributedRevenue: z.number().nonnegative(),
    creditsUsed: z.number().int().nonnegative(),
  }),
  marketplaceActivity: z.object({
    publishedPosts: z.number().int().nonnegative(),
    draftOrScheduled: z.number().int().nonnegative(),
    totalClicks: z.number().int().nonnegative(),
    postRevenue: z.number().nonnegative(),
  }),
  topProducts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sku: z.string(),
      price: z.number().nonnegative(),
      stock: z.number().int().nonnegative(),
      lowStockThreshold: z.number().int().nonnegative(),
      salesCount: z.number().int().nonnegative(),
      image: z.string(),
    })
  ),
  lowStockProducts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sku: z.string(),
      stock: z.number().int().nonnegative(),
      lowStockThreshold: z.number().int().nonnegative(),
    })
  ),
  recentOrders: z.array(
    z.object({
      id: z.string(),
      customerName: z.string(),
      customerEmail: z.string(),
      total: z.number().nonnegative(),
      status: z.string(),
      paymentStatus: z.string(),
      itemCount: z.number().int().nonnegative(),
      date: z.string(),
      createdAt: z.number().int().nonnegative(),
    })
  ),
});

export const OverviewTimeseriesResponseSchema = z.object({
  currency: z.literal('BDT'),
  period: z.enum(OVERVIEW_PERIODS),
  rangeStart: z.number().int().nonnegative(),
  rangeEnd: z.number().int().nonnegative(),
  totals: z.object({
    revenue: z.number().nonnegative(),
    orders: z.number().int().nonnegative(),
    tryOns: z.number().int().nonnegative(),
  }),
  series: z.array(
    z.object({
      label: z.string(),
      revenue: z.number().nonnegative(),
      orders: z.number().int().nonnegative(),
      tryOns: z.number().int().nonnegative(),
    })
  ),
});

export const OverviewActivityResponseSchema = z.object({
  activities: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      entity: z.string(),
      details: z.string(),
      actor: z.string(),
      role: z.string(),
      timestamp: z.string(),
      createdAt: z.number().int().nonnegative(),
    })
  ),
});

export const OverviewChecklistResponseSchema = z.object({
  completedIds: z.array(z.enum(OVERVIEW_CHECKLIST_IDS)),
  autoCompletedIds: z.array(z.enum(OVERVIEW_CHECKLIST_IDS)),
  manualCompletedIds: z.array(z.enum(OVERVIEW_CHECKLIST_IDS)),
  completedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive(),
  completionPct: z.number().int().min(0).max(100),
  items: z.array(
    z.object({
      id: z.enum(OVERVIEW_CHECKLIST_IDS),
      label: z.string(),
      href: z.string(),
      completed: z.boolean(),
      autoCompleted: z.boolean(),
    })
  ),
});

