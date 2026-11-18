export interface SeriesInvoice {
  total: number;
  status: string;
  issuedAt: string;
}

export interface SeriesGeneration {
  createdAt: number;
}

export interface MonthlySeriesPoint {
  /** UTC month, YYYY-MM */
  month: string;
  /** Short English month name, e.g. "Nov" */
  label: string;
  /** Sum of PAID invoice totals issued in the month */
  revenue: number;
  /** Number of PAID invoices issued in the month */
  invoiceCount: number;
  /** Number of try-on generation jobs created in the month */
  generations: number;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Real monthly figures for the last `months` calendar months (UTC), oldest first, ending with the month of `now`.
 * Months with no activity are kept as zeros so the chart axis is continuous. Nothing is estimated.
 */
export function buildMonthlySeries(input: {
  invoices: SeriesInvoice[];
  generations: SeriesGeneration[];
  months: number;
  now?: Date;
}): MonthlySeriesPoint[] {
  const count = Math.min(24, Math.max(1, Math.floor(input.months) || 6));
  const now = input.now ?? new Date();

  const points: MonthlySeriesPoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    points.push({ month: monthKey(d), label: MONTH_LABELS[d.getUTCMonth()], revenue: 0, invoiceCount: 0, generations: 0 });
  }
  const byMonth = new Map(points.map((p) => [p.month, p]));

  for (const inv of input.invoices) {
    if (inv.status !== 'PAID') continue;
    const issued = new Date(inv.issuedAt);
    if (Number.isNaN(issued.getTime())) continue;
    const p = byMonth.get(monthKey(issued));
    if (!p) continue;
    p.revenue += Number(inv.total) || 0;
    p.invoiceCount += 1;
  }
  for (const job of input.generations) {
    const created = new Date(job.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    const p = byMonth.get(monthKey(created));
    if (p) p.generations += 1;
  }
  for (const p of points) p.revenue = Number(p.revenue.toFixed(2));
  return points;
}
