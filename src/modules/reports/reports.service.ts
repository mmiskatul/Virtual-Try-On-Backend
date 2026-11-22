import type { DiscountRecord, GenerationJob, Order, Product } from '../../domain/types.js';

/**
 * Read-only reports for one brand. Everything here is a pure function of the brand's own
 * orders, products and try-on jobs, so it can be tested without a server.
 */
export type ReportPeriod = '7d' | '30d' | '90d';

const DAY = 24 * 60 * 60 * 1000;

export function parsePeriod(raw: unknown): ReportPeriod {
  return raw === '7d' || raw === '90d' ? raw : '30d';
}

const periodDays = (p: ReportPeriod) => (p === '7d' ? 7 : p === '90d' ? 90 : 30);

export interface Range {
  start: number;
  end: number;
}

/** The period ending now, and the same-length period just before it (for "compared to last time"). */
export function periodRanges(period: ReportPeriod, now = Date.now()): { current: Range; previous: Range } {
  const span = periodDays(period) * DAY;
  return {
    current: { start: now - span, end: now },
    previous: { start: now - 2 * span, end: now - span },
  };
}

/** An order counts as sales unless it was cancelled or refunded. */
export const isSale = (o: Order): boolean => o.status !== 'CANCELLED' && o.paymentStatus !== 'REFUNDED';

const inRange = (t: number, r: Range) => t >= r.start && t < r.end;

const round2 = (n: number) => Number(n.toFixed(2));

/** The percent change from `before` to `now`; null when there is nothing to compare with. */
export function percentChange(now: number, before: number): number | null {
  if (!before) return null;
  return round2(((now - before) / before) * 100);
}

/** What the customer saved on an order (the database does not store it, so work it out). */
export function discountOf(o: Order): number {
  if (typeof o.discountAmount === 'number') return Math.max(0, o.discountAmount);
  return Math.max(0, round2(o.subtotal + o.shippingFee - o.totalAmount));
}

function bucketize(range: Range, period: ReportPeriod): Array<{ start: number; end: number; label: string; date: string }> {
  // 7 and 30 days are shown day by day; 90 days is shown week by week.
  const step = period === '90d' ? 7 * DAY : DAY;
  const out: Array<{ start: number; end: number; label: string; date: string }> = [];
  for (let s = range.start; s < range.end; s += step) {
    const d = new Date(s);
    out.push({
      start: s,
      end: Math.min(s + step, range.end),
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }
  return out;
}

export function salesReport(orders: Order[], period: ReportPeriod, now = Date.now()) {
  const { current, previous } = periodRanges(period, now);
  const cur = orders.filter((o) => inRange(o.createdAt, current));
  const prev = orders.filter((o) => inRange(o.createdAt, previous));

  const summarize = (list: Order[]) => {
    const sales = list.filter(isSale);
    const revenue = round2(sales.reduce((s, o) => s + o.totalAmount, 0));
    return { revenue, orders: sales.length, averageOrderValue: sales.length ? round2(revenue / sales.length) : 0 };
  };
  const c = summarize(cur);
  const p = summarize(prev);

  const sales = cur.filter(isSale);
  const series = bucketize(current, period).map((b) => {
    const inBucket = sales.filter((o) => o.createdAt >= b.start && o.createdAt < b.end);
    return { date: b.date, label: b.label, revenue: round2(inBucket.reduce((s, o) => s + o.totalAmount, 0)), orders: inBucket.length };
  });

  const byStatus: Record<string, number> = { PENDING: 0, PROCESSING: 0, SHIPPED: 0, DELIVERED: 0, CANCELLED: 0 };
  for (const o of cur) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  return {
    period,
    range: current,
    ...c,
    previous: p,
    change: {
      revenue: percentChange(c.revenue, p.revenue),
      orders: percentChange(c.orders, p.orders),
      averageOrderValue: percentChange(c.averageOrderValue, p.averageOrderValue),
    },
    discountsGiven: round2(sales.reduce((s, o) => s + discountOf(o), 0)),
    byStatus,
    series,
  };
}

export function productsReport(orders: Order[], products: Product[], period: ReportPeriod, now = Date.now(), limit = 10) {
  const { current } = periodRanges(period, now);
  const sales = orders.filter((o) => isSale(o) && inRange(o.createdAt, current));

  const perProduct = new Map<string, { productId: string; name: string; imageUrl?: string; units: number; revenue: number }>();
  for (const o of sales) {
    for (const item of o.items || []) {
      const row = perProduct.get(item.productId) || { productId: item.productId, name: item.productName, imageUrl: item.imageUrl, units: 0, revenue: 0 };
      row.units += item.quantity;
      row.revenue = round2(row.revenue + item.lineTotal);
      perProduct.set(item.productId, row);
    }
  }
  const ranked = Array.from(perProduct.values());
  const soldIds = new Set(ranked.map((r) => r.productId));
  return {
    period,
    top: ranked.sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, limit),
    notSold: products
      .filter((p) => !soldIds.has(p.id) && p.catalogStatus !== 'ARCHIVED' && p.catalogStatus !== 'DRAFT')
      .slice(0, limit)
      .map((p) => ({ productId: p.id, name: p.name, imageUrl: p.images?.[0] })),
    totalUnits: ranked.reduce((s, r) => s + r.units, 0),
  };
}

export function customersReport(orders: Order[], period: ReportPeriod, now = Date.now(), limit = 10) {
  const { current } = periodRanges(period, now);
  const allSales = orders.filter(isSale);

  // Everyone's first sale ever, to tell new buyers from returning ones.
  const firstSeen = new Map<string, number>();
  for (const o of allSales) {
    const key = o.customerEmail.toLowerCase();
    const prev = firstSeen.get(key);
    if (prev === undefined || o.createdAt < prev) firstSeen.set(key, o.createdAt);
  }

  const inPeriod = allSales.filter((o) => inRange(o.createdAt, current));
  const perCustomer = new Map<string, { email: string; name: string; orders: number; spent: number; lastOrderAt: number }>();
  for (const o of inPeriod) {
    const key = o.customerEmail.toLowerCase();
    const row = perCustomer.get(key) || { email: o.customerEmail, name: o.shippingAddress?.fullName || o.customerEmail, orders: 0, spent: 0, lastOrderAt: 0 };
    row.orders += 1;
    row.spent = round2(row.spent + o.totalAmount);
    row.lastOrderAt = Math.max(row.lastOrderAt, o.createdAt);
    perCustomer.set(key, row);
  }

  let newBuyers = 0;
  let returningBuyers = 0;
  for (const email of perCustomer.keys()) {
    const first = firstSeen.get(email);
    if (first !== undefined && inRange(first, current)) newBuyers += 1;
    else returningBuyers += 1;
  }

  return {
    period,
    totalCustomers: perCustomer.size,
    newBuyers,
    returningBuyers,
    top: Array.from(perCustomer.values()).sort((a, b) => b.spent - a.spent).slice(0, limit),
  };
}

export function tryOnReport(jobs: GenerationJob[], products: Product[], period: ReportPeriod, now = Date.now(), limit = 5) {
  const { current, previous } = periodRanges(period, now);
  const cur = jobs.filter((j) => inRange(j.createdAt, current));
  const prev = jobs.filter((j) => inRange(j.createdAt, previous));

  const completed = cur.filter((j) => j.status === 'COMPLETED').length;
  const failed = cur.filter((j) => j.status === 'FAILED').length;
  const inProgress = cur.length - completed - failed;
  const finished = completed + failed;

  const series = bucketize(current, period).map((b) => ({
    date: b.date,
    label: b.label,
    tryOns: cur.filter((j) => j.createdAt >= b.start && j.createdAt < b.end).length,
  }));

  const perProduct = new Map<string, number>();
  for (const j of cur) perProduct.set(j.productId, (perProduct.get(j.productId) || 0) + 1);
  const names = new Map(products.map((p) => [p.id, p.name]));

  return {
    period,
    total: cur.length,
    completed,
    failed,
    inProgress,
    successRate: finished > 0 ? round2((completed / finished) * 100) : null,
    change: { total: percentChange(cur.length, prev.length) },
    series,
    topProducts: Array.from(perProduct.entries())
      .map(([productId, count]) => ({ productId, name: names.get(productId) || 'Removed product', count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit),
  };
}

export function discountStats(orders: Order[], discounts: DiscountRecord[]) {
  const sales = orders.filter(isSale);
  const stats = discounts.map((d) => {
    const used = sales.filter((o) => (o.couponCode || '').toUpperCase() === d.code.toUpperCase());
    return {
      id: d.id,
      code: d.code,
      orders: used.length,
      revenue: round2(used.reduce((s, o) => s + o.totalAmount, 0)),
      discountGiven: round2(used.reduce((s, o) => s + discountOf(o), 0)),
    };
  });
  return {
    stats,
    totals: {
      orders: stats.reduce((s, r) => s + r.orders, 0),
      revenue: round2(stats.reduce((s, r) => s + r.revenue, 0)),
      discountGiven: round2(stats.reduce((s, r) => s + r.discountGiven, 0)),
    },
  };
}
