import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware } from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { billingCreditService } from '../../modules/billing/billing.service.js';
import { GenerationJob, Order, Product, Tenant } from '../../domain/types.js';
import { formatZodValidationError, validateZodOutput } from './storefront.schemas.js';
import {
  OVERVIEW_CHECKLIST_IDS,
  OverviewActivityQuerySchema,
  OverviewActivityResponseSchema,
  OverviewChecklistId,
  OverviewChecklistResponseSchema,
  OverviewChecklistUpdateInputSchema,
  OverviewPeriod,
  OverviewSummaryResponseSchema,
  OverviewTimeseriesQuerySchema,
  OverviewTimeseriesResponseSchema,
} from './overview.schemas.js';

const brandOverviewReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandOverviewWriteGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));

const LOW_STOCK_THRESHOLD = 5;
const FALLBACK_PRODUCT_IMAGE =
  'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800&auto=format&fit=crop&q=80';

const CHECKLIST_CATALOG: ReadonlyArray<{
  id: OverviewChecklistId;
  label: string;
  href: string;
}> = [
  { id: 'chk_profile', label: 'Complete brand profile & story', href: '/dashboard/brand/profile' },
  { id: 'chk_logo', label: 'Upload main logo & brand assets', href: '/dashboard/brand/media' },
  { id: 'chk_cover', label: 'Configure storefront cover & theme', href: '/dashboard/brand/media' },
  { id: 'chk_biz', label: 'Add legal & business contact details', href: '/dashboard/settings/business' },
  { id: 'chk_product', label: 'Create first apparel product', href: '/dashboard/products/addproduct' },
  { id: 'chk_variants', label: 'Configure sizes, colors & variants', href: '/dashboard/products' },
  { id: 'chk_storefront', label: 'Publish dedicated brand storefront', href: '/dashboard/brand' },
  { id: 'chk_tryon', label: 'Configure Virtual Try-On experience', href: '/dashboard/virtual-try-on/configuration' },
  { id: 'chk_publish', label: 'Publish first product to global marketplace', href: '/dashboard/marketplace/create' },
  { id: 'chk_test_tryon', label: 'Test public Virtual Try-On studio', href: '/dashboard/virtual-try-on/studio' },
];

function isActiveRevenueOrder(order: Order): boolean {
  return order.status !== 'CANCELLED' && order.paymentStatus !== 'REFUNDED';
}

function getProductStock(product: Product): number {
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    return 0;
  }
  return product.variants.reduce((sum, v) => sum + Math.max(0, Number(v.stockQuantity) || 0), 0);
}

function formatPeriodDeltaPct(currentValue: number, previousValue: number): string {
  if (previousValue <= 0) {
    return currentValue > 0 ? '+100.0%' : '0.0%';
  }
  const pct = ((currentValue - previousValue) / previousValue) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function buildBucketSeries(
  period: OverviewPeriod,
  orders: Order[],
  generations: GenerationJob[],
  customStartStr?: string,
  customEndStr?: string
): {
  rangeStart: number;
  rangeEnd: number;
  series: Array<{ label: string; revenue: number; orders: number; tryOns: number }>;
} {
  const now = Date.now();
  const activeOrders = orders.filter(isActiveRevenueOrder);

  if (period === 'today') {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const startMs = dayStart.getTime();
    const bucketMs = 3 * 60 * 60 * 1000;
    const labels = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
    const series = labels.map((label, idx) => {
      const bStart = startMs + idx * bucketMs;
      const bEnd = bStart + bucketMs;
      const bucketOrders = activeOrders.filter((o) => o.createdAt >= bStart && o.createdAt < bEnd);
      const bucketGens = generations.filter((g) => g.createdAt >= bStart && g.createdAt < bEnd);
      return {
        label,
        revenue: Number(bucketOrders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2)),
        orders: bucketOrders.length,
        tryOns: bucketGens.length,
      };
    });
    return { rangeStart: startMs, rangeEnd: now, series };
  }

  let rangeStart: number;
  let rangeEnd: number;
  let bucketCount: number;

  if (period === 'custom' && customStartStr && customEndStr) {
    const start = new Date(`${customStartStr}T00:00:00.000Z`).getTime();
    const end = new Date(`${customEndStr}T23:59:59.999Z`).getTime();
    rangeStart = Number.isFinite(start) ? start : now - 14 * 24 * 60 * 60 * 1000;
    rangeEnd = Number.isFinite(end) ? end : now;
    bucketCount = 7;
  } else if (period === '30d' || period === 'custom') {
    rangeEnd = now;
    rangeStart = now - 30 * 24 * 60 * 60 * 1000;
    bucketCount = 6;
  } else if (period === '90d') {
    rangeEnd = now;
    rangeStart = now - 90 * 24 * 60 * 60 * 1000;
    bucketCount = 6;
  } else {
    // Default 7d: exact 7 daily buckets ending today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    rangeStart = todayStart.getTime() - 6 * 24 * 60 * 60 * 1000;
    rangeEnd = todayStart.getTime() + 24 * 60 * 60 * 1000 - 1;
    bucketCount = 7;
  }

  const totalSpan = Math.max(1, rangeEnd - rangeStart);
  const stepMs = totalSpan / bucketCount;
  const series = Array.from({ length: bucketCount }, (_, idx) => {
    const bStart = rangeStart + idx * stepMs;
    const bEnd = idx === bucketCount - 1 ? rangeEnd + 1 : rangeStart + (idx + 1) * stepMs;
    const d = new Date(bStart);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const bucketOrders = activeOrders.filter((o) => o.createdAt >= bStart && o.createdAt < bEnd);
    const bucketGens = generations.filter((g) => g.createdAt >= bStart && g.createdAt < bEnd);
    return {
      label,
      revenue: Number(bucketOrders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2)),
      orders: bucketOrders.length,
      tryOns: bucketGens.length,
    };
  });

  return { rangeStart: Math.floor(rangeStart), rangeEnd: Math.floor(rangeEnd), series };
}

function computeChecklistState(
  tenant: Tenant,
  products: Product[],
  generations: GenerationJob[]
) {
  const ss = tenant.storefrontSettings || {};
  const autoSet = new Set<OverviewChecklistId>();

  if (Boolean(tenant.description?.trim() || ss.aboutText?.trim() || ss.shortDescription?.trim())) {
    autoSet.add('chk_profile');
  }
  if (Boolean(tenant.logoUrl?.trim())) {
    autoSet.add('chk_logo');
  }
  if (Boolean(tenant.bannerUrl?.trim() || ss.bannerImage?.trim() || ss.headerStyle)) {
    autoSet.add('chk_cover');
  }
  if (Boolean(ss.legalName?.trim() || ss.phone?.trim() || ss.address?.trim())) {
    autoSet.add('chk_biz');
  }
  if (products.length > 0) {
    autoSet.add('chk_product');
  }
  if (products.some((p) => Array.isArray(p.variants) && p.variants.length > 0)) {
    autoSet.add('chk_variants');
  }
  if (Boolean(ss.onboardingCompleted) && (products.some((p) => p.brandStorefrontPublished) || tenant.status === 'ACTIVE')) {
    autoSet.add('chk_storefront');
  }
  if (products.some((p) => p.isTryOnEligible)) {
    autoSet.add('chk_tryon');
  }
  if (products.some((p) => p.marketplacePublished)) {
    autoSet.add('chk_publish');
  }
  if (generations.length > 0) {
    autoSet.add('chk_test_tryon');
  }

  const validManualSet = new Set<OverviewChecklistId>(
    (Array.isArray(ss.overviewChecklistIds) ? ss.overviewChecklistIds : []).filter(
      (id): id is OverviewChecklistId =>
        (OVERVIEW_CHECKLIST_IDS as readonly string[]).includes(id)
    )
  );

  const combinedSet = new Set<OverviewChecklistId>([...autoSet, ...validManualSet]);
  const items = CHECKLIST_CATALOG.map((item) => ({
    id: item.id,
    label: item.label,
    href: item.href,
    completed: combinedSet.has(item.id),
    autoCompleted: autoSet.has(item.id),
  }));

  const completedIds = items.filter((i) => i.completed).map((i) => i.id);
  const autoCompletedIds = items.filter((i) => i.autoCompleted).map((i) => i.id);
  const manualCompletedIds = Array.from(validManualSet);
  const totalCount = items.length;
  const completedCount = completedIds.length;
  const completionPct = Math.round((completedCount / totalCount) * 100);

  return {
    completedIds,
    autoCompletedIds,
    manualCompletedIds,
    completedCount,
    totalCount,
    completionPct,
    items,
  };
}

const TECHNICAL_ACTIVITY_KEYS = new Set([
  'ipMasked',
  'ipAddress',
  'ip',
  'correlationId',
  'sessionId',
  'actorId',
  'userId',
  'tenantId',
  'tokenId',
  'refreshTokenId',
  'jti',
  'requestId',
  'userAgent',
]);

const SILENT_ACTIVITY_ACTIONS = new Set([
  'AUTH_REFRESH',
  'TOKEN_REFRESH',
  'TOKEN_REFRESHED',
  'SESSION_REFRESHED',
]);

function toTitleCaseFromConst(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function toHumanFieldLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (ch) => ch.toUpperCase());
}

function formatActivityTitle(action: string, rawEntity: string): string {
  const normalized = action.toUpperCase();
  if (normalized === 'BRAND_LOGIN' || normalized === 'LOGIN_SUCCESS') return 'Workspace Sign-In';
  if (normalized === 'BRAND_REGISTERED') return 'Brand Workspace Created';
  if (normalized === 'EMAIL_VERIFIED') return 'Email Verified';
  if (normalized === 'BRAND_LOGOUT' || normalized === 'USER_LOGOUT') return 'Workspace Sign-Out';
  if (normalized === 'OVERVIEW_CHECKLIST_UPDATED') return 'Getting Started Checklist';
  if (normalized.includes('STOREFRONT')) return 'Storefront Design';
  if (normalized.includes('MODERATION')) return 'Marketplace Moderation';
  if (normalized.includes('PRODUCT')) return 'Catalog Product';
  if (normalized.includes('CATEGORY')) return 'Product Category';
  if (normalized.includes('COLLECTION')) return 'Product Collection';
  if (normalized.includes('ORDER')) return 'Customer Order';

  if (rawEntity && rawEntity !== 'User' && rawEntity !== 'Tenant') {
    return rawEntity;
  }
  return toTitleCaseFromConst(action);
}

function formatActivityDetails(
  action: string,
  details?: Record<string, unknown>,
  actorName = 'Team member'
): string {
  const normalized = action.toUpperCase();
  if (normalized === 'BRAND_LOGIN' || normalized === 'LOGIN_SUCCESS') {
    const provider = typeof details?.provider === 'string' ? details.provider : '';
    return provider === 'google_oauth'
      ? `${actorName} signed in with Google`
      : `${actorName} signed in to the brand dashboard`;
  }
  if (normalized === 'BRAND_REGISTERED') {
    const brandName = typeof details?.brandName === 'string' ? details.brandName.trim() : '';
    return brandName
      ? `${actorName} created workspace "${brandName}"`
      : `${actorName} registered the brand workspace`;
  }
  if (normalized === 'EMAIL_VERIFIED') {
    return `${actorName} verified their workspace email address`;
  }
  if (normalized === 'BRAND_LOGOUT' || normalized === 'USER_LOGOUT') {
    return `${actorName} signed out of the brand dashboard`;
  }

  if (details && typeof details.summary === 'string' && details.summary.trim()) {
    const summaryText = details.summary.trim();
    const matchedChecklist = CHECKLIST_CATALOG.find((item) => summaryText.includes(item.id));
    if (matchedChecklist) {
      return `Updated milestone: "${matchedChecklist.label}"`;
    }
    return summaryText;
  }
  if (details && typeof details.message === 'string' && details.message.trim()) {
    return details.message.trim();
  }

  const safeEntries = Object.entries(details || {}).filter(
    ([key, val]) => !TECHNICAL_ACTIVITY_KEYS.has(key) && val !== undefined && val !== null && val !== ''
  );

  if (safeEntries.length === 0) {
    return `${actorName} completed ${toTitleCaseFromConst(action).toLowerCase()}`;
  }

  return safeEntries
    .slice(0, 4)
    .map(([k, v]) => `${toHumanFieldLabel(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' • ');
}

export async function brandOverviewRoutes(app: FastifyInstance) {
  // 1. Overview KPIs, Sales Breakdown, Try-On Metrics, Marketplace & Top Products
  app.get(
    '/api/v1/brand/overview',
    { preHandler: brandOverviewReadGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant;
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
      }

      const tenantId = tenant.id;
      const products = db.getProductsByTenant(tenantId);
      const orders = db.getOrdersByTenant(tenantId);
      const generations = db.getGenerationsByTenant(tenantId);
      const usageLedger = db.getUsageLedger(tenantId);
      const subscription = db.getSubscription(tenantId);
      const creditBalance = await billingCreditService.getCreditBalance(tenantId).catch(() => null);

      const activeOrders = orders.filter(isActiveRevenueOrder);
      const totalRevenue = Number(
        activeOrders.reduce((sum, o) => sum + o.totalAmount, 0).toFixed(2)
      );

      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const currentWeekOrders = activeOrders.filter((o) => o.createdAt >= now - weekMs);
      const prevWeekOrders = activeOrders.filter(
        (o) => o.createdAt >= now - 2 * weekMs && o.createdAt < now - weekMs
      );
      const currentWeekRev = currentWeekOrders.reduce((s, o) => s + o.totalAmount, 0);
      const prevWeekRev = prevWeekOrders.reduce((s, o) => s + o.totalAmount, 0);

      const paidOrders = orders.filter((o) => o.paymentStatus === 'PAID').length;
      const pendingOrders = orders.filter(
        (o) => o.status === 'PENDING' || o.status === 'PROCESSING'
      ).length;
      const cancelledOrders = orders.filter((o) => o.status === 'CANCELLED').length;
      const refundedOrders = orders.filter((o) => o.paymentStatus === 'REFUNDED').length;
      const averageOrderValue =
        activeOrders.length > 0 ? Number((totalRevenue / activeOrders.length).toFixed(2)) : 0;

      const uniqueCustomers = new Set(
        orders.map((o) => o.customerEmail.trim().toLowerCase()).filter(Boolean)
      );

      // Compute per-product unit sales strictly from tenant orders
      const salesByProduct = new Map<string, number>();
      let productSalesUnits = 0;
      for (const order of activeOrders) {
        for (const item of order.items || []) {
          const qty = Math.max(0, Number(item.quantity) || 0);
          productSalesUnits += qty;
          salesByProduct.set(item.productId, (salesByProduct.get(item.productId) || 0) + qty);
        }
      }

      const publishedStorefrontProducts = products.filter((p) => p.brandStorefrontPublished).length;
      const publishedMarketplaceProducts = products.filter((p) => p.marketplacePublished).length;

      const successfulTryOns = generations.filter((g) => g.status === 'COMPLETED').length;
      const failedTryOns = generations.filter((g) => g.status === 'FAILED').length;
      const processingOrQueuedTryOns = generations.filter(
        (g) => g.status === 'QUEUED' || g.status === 'PROCESSING'
      ).length;
      const avgLatencyMs =
        successfulTryOns > 0
          ? generations
              .filter((g) => g.status === 'COMPLETED')
              .reduce((sum, g) => sum + Math.max(0, g.updatedAt - g.createdAt), 0) /
            successfulTryOns
          : 0;

      const creditsUsedFromLedger = usageLedger
        .filter((u) => u.status === 'CONSUMED')
        .reduce((sum, u) => sum + (u.finalUnits ?? u.reservedUnits), 0);

      const tryOnQuota = subscription?.tryOnMonthlyQuota ?? 500;
      const tryOnUsed = subscription?.tryOnUsed ?? generations.length;
      const tryOnCreditsLeft =
        creditBalance && typeof creditBalance.availableCredits === 'number' && creditBalance.availableCredits > 0
          ? creditBalance.availableCredits
          : Math.max(0, tryOnQuota - tryOnUsed);

      const marketplaceProductIds = new Set(
        products.filter((p) => p.marketplacePublished).map((p) => p.id)
      );
      const marketplaceOrderRevenue = Number(
        activeOrders
          .reduce(
            (sum, o) =>
              sum +
              (o.items || [])
                .filter((item) => marketplaceProductIds.has(item.productId))
                .reduce((itemSum, item) => itemSum + (Number(item.lineTotal) || 0), 0),
            0
          )
          .toFixed(2)
      );

      const enrichedProducts = products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: Number(p.price) || 0,
        stock: getProductStock(p),
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        salesCount: salesByProduct.get(p.id) || 0,
        image: p.images?.[0] || FALLBACK_PRODUCT_IMAGE,
      }));

      const topProducts = [...enrichedProducts]
        .sort((a, b) => b.salesCount - a.salesCount || b.price - a.price)
        .slice(0, 4);

      const lowStockProducts = enrichedProducts
        .filter((p) => p.stock < p.lowStockThreshold)
        .slice(0, 6)
        .map(({ id, name, sku, stock, lowStockThreshold }) => ({
          id,
          name,
          sku,
          stock,
          lowStockThreshold,
        }));

      const recentOrders = [...orders]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map((o) => ({
          id: o.id,
          customerName: o.shippingAddress?.fullName || o.customerEmail || 'Customer',
          customerEmail: o.customerEmail,
          total: Number(o.totalAmount) || 0,
          status: o.status,
          paymentStatus: o.paymentStatus,
          itemCount:
            (o.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 1), 0) || 1,
          date: new Date(o.createdAt).toISOString().slice(0, 10),
          createdAt: o.createdAt,
        }));

      return validateZodOutput(
        OverviewSummaryResponseSchema,
        {
          currency: 'BDT',
          generatedAt: now,
          workspace: {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            logoUrl: tenant.logoUrl || null,
            status: tenant.status,
            plan: subscription?.plan || 'STARTER',
            storeStatus: tenant.status === 'ACTIVE' ? 'LIVE' : 'MAINTENANCE',
            marketplaceStatus: publishedMarketplaceProducts > 0 ? 'CONNECTED' : 'NOT_CONNECTED',
            tryOnStatus:
              tryOnCreditsLeft > 0 || products.some((p) => p.isTryOnEligible)
                ? 'TRY-ON ACTIVE'
                : 'PAUSED',
          },
          kpis: {
            totalRevenue,
            revenueChangeLabel: formatPeriodDeltaPct(currentWeekRev, prevWeekRev),
            totalOrders: orders.length,
            ordersChangeLabel: formatPeriodDeltaPct(currentWeekOrders.length, prevWeekOrders.length),
            totalProducts: products.length,
            publishedStorefrontProducts,
            publishedMarketplaceProducts,
            totalCustomers: uniqueCustomers.size,
            marketplaceViews: publishedMarketplaceProducts * 0,
            productSalesUnits,
            tryOnSessionsCount: Math.max(generations.length, tryOnUsed),
            tryOnUsed,
            tryOnQuota,
            tryOnCreditsLeft,
          },
          salesOverview: {
            totalRevenue,
            paidOrders,
            pendingOrders,
            cancelledOrders,
            refundedOrders,
            averageOrderValue,
          },
          tryOnPerformance: {
            loggedSessions: generations.length,
            successful: successfulTryOns,
            failed: failedTryOns,
            processingOrQueued: processingOrQueuedTryOns,
            avgSpeedSec: Number((avgLatencyMs / 1000).toFixed(2)),
            cartConversions: 0,
            attributedOrders: 0,
            attributedRevenue: 0,
            creditsUsed: Math.max(creditsUsedFromLedger, tryOnUsed),
          },
          marketplaceActivity: {
            publishedPosts: publishedMarketplaceProducts,
            draftOrScheduled: Math.max(0, products.length - publishedMarketplaceProducts),
            totalClicks: 0,
            postRevenue: marketplaceOrderRevenue,
          },
          topProducts,
          lowStockProducts,
          recentOrders,
        },
        'GET /api/v1/brand/overview'
      );
    }
  );

  // 2. Time-Series Analytics (Today, 7d, 30d, 90d, custom)
  app.get(
    '/api/v1/brand/overview/timeseries',
    { preHandler: brandOverviewReadGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant;
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
      }

      const parsedQuery = OverviewTimeseriesQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply.status(400).send(formatZodValidationError(parsedQuery.error));
      }

      const { period, startDate, endDate } = parsedQuery.data;
      const orders = db.getOrdersByTenant(tenant.id);
      const generations = db.getGenerationsByTenant(tenant.id);

      const { rangeStart, rangeEnd, series } = buildBucketSeries(
        period,
        orders,
        generations,
        startDate,
        endDate
      );

      const totals = {
        revenue: Number(series.reduce((sum, pt) => sum + pt.revenue, 0).toFixed(2)),
        orders: series.reduce((sum, pt) => sum + pt.orders, 0),
        tryOns: series.reduce((sum, pt) => sum + pt.tryOns, 0),
      };

      return validateZodOutput(
        OverviewTimeseriesResponseSchema,
        {
          currency: 'BDT',
          period,
          rangeStart,
          rangeEnd,
          totals,
          series,
        },
        'GET /api/v1/brand/overview/timeseries'
      );
    }
  );

  // 3. Recent Brand Activity Feed (Audit Logs + Inventory Adjustments)
  app.get(
    '/api/v1/brand/overview/activity',
    { preHandler: brandOverviewReadGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant;
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
      }

      const parsedQuery = OverviewActivityQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply.status(400).send(formatZodValidationError(parsedQuery.error));
      }

      const { limit } = parsedQuery.data;
      const tenantId = tenant.id;
      const auditEvents = db
        .getAuditLogs(tenantId)
        .filter((log) => !SILENT_ACTIVITY_ACTIONS.has(log.action.toUpperCase()))
        .map((log) => {
          const actorUser = log.actorId ? db.getUserById(log.actorId) : undefined;
          const actorName =
            actorUser?.name ||
            (String(log.actorRole) === 'SYSTEM' ? 'System' : 'Team member');
          return {
            id: log.id,
            action: log.action,
            entity: formatActivityTitle(log.action, log.entity),
            details: formatActivityDetails(log.action, log.details, actorName),
            actor: actorName,
            role: log.actorRole,
            timestamp: new Date(log.timestamp).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            createdAt: log.timestamp,
          };
        });

      const inventoryEvents = db.getInventoryLogs(tenantId).map((inv) => ({
        id: inv.id,
        action: 'INVENTORY_ADJUSTED',
        entity: `Inventory • ${inv.variantSku || inv.productId}`,
        details: `${inv.change >= 0 ? '+' : ''}${inv.change} units • ${inv.reason} (Stock: ${inv.newStock})`,
        actor: 'Inventory',
        role: 'SYSTEM',
        timestamp: new Date(inv.timestamp).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        createdAt: inv.timestamp,
      }));

      const merged = [...auditEvents, ...inventoryEvents]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);

      return validateZodOutput(
        OverviewActivityResponseSchema,
        { activities: merged },
        'GET /api/v1/brand/overview/activity'
      );
    }
  );

  // 4. Getting Started Overview Checklist (Computed Milestones + Persisted Toggles)
  app.get(
    '/api/v1/brand/overview/checklist',
    { preHandler: brandOverviewReadGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant;
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
      }

      const products = db.getProductsByTenant(tenant.id);
      const generations = db.getGenerationsByTenant(tenant.id);
      const checklist = computeChecklistState(tenant, products, generations);

      return validateZodOutput(
        OverviewChecklistResponseSchema,
        checklist,
        'GET /api/v1/brand/overview/checklist'
      );
    }
  );

  // 5. Update Overview Checklist Milestones (Persisted in Tenant storefrontSettings)
  app.put(
    '/api/v1/brand/overview/checklist',
    { preHandler: brandOverviewWriteGuards },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant;
      if (!tenant) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
      }

      const parsedBody = OverviewChecklistUpdateInputSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.status(400).send(formatZodValidationError(parsedBody.error));
      }

      const currentIds = new Set<OverviewChecklistId>(
        (Array.isArray(tenant.storefrontSettings?.overviewChecklistIds)
          ? tenant.storefrontSettings.overviewChecklistIds
          : []
        ).filter((id): id is OverviewChecklistId =>
          (OVERVIEW_CHECKLIST_IDS as readonly string[]).includes(id)
        )
      );

      if (parsedBody.data.toggleId) {
        if (currentIds.has(parsedBody.data.toggleId)) {
          currentIds.delete(parsedBody.data.toggleId);
        } else {
          currentIds.add(parsedBody.data.toggleId);
        }
      }

      if (Array.isArray(parsedBody.data.completedIds)) {
        currentIds.clear();
        for (const id of parsedBody.data.completedIds) {
          currentIds.add(id);
        }
      }

      const nextManualIds = Array.from(currentIds);
      const updatedTenant = db.updateTenant(tenant.id, {
        storefrontSettings: {
          ...(tenant.storefrontSettings || {}),
          overviewChecklistIds: nextManualIds,
        },
      });

      if (!updatedTenant) {
        return reply.status(404).send({ error: 'NotFound', message: 'Brand tenant not found.' });
      }

      db.recordAuditLog({
        tenantId: tenant.id,
        actorId: request.authUser?.id || 'brand_user',
        actorRole: request.authUser?.role || 'BRAND_OWNER',
        action: 'OVERVIEW_CHECKLIST_UPDATED',
        entity: 'WorkspaceChecklist',
        entityId: tenant.id,
        details: {
          summary: `Updated workspace setup checklist (${nextManualIds.length} manual items marked)`,
          completedIds: nextManualIds,
        },
      });

      const products = db.getProductsByTenant(updatedTenant.id);
      const generations = db.getGenerationsByTenant(updatedTenant.id);
      const checklist = computeChecklistState(updatedTenant, products, generations);

      return validateZodOutput(
        OverviewChecklistResponseSchema,
        checklist,
        'PUT /api/v1/brand/overview/checklist'
      );
    }
  );
}

