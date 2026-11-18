import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';
import { buildMonthlySeries } from '../src/modules/admin/analytics_series.js';
import { billingCreditService } from '../src/modules/billing/billing.service.js';
import { db } from '../src/infrastructure/database.js';

const NOW = new Date(Date.UTC(2026, 10, 18, 12, 0, 0)); // 18 Nov 2026

describe('Phase 15: admin analytics series (real revenue and generations)', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  describe('buildMonthlySeries', () => {
    it('returns N continuous UTC months ending with the current month, oldest first', () => {
      const pts = buildMonthlySeries({ invoices: [], generations: [], months: 6, now: NOW });
      expect(pts.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
      expect(pts.map((p) => p.label)).toEqual(['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']);
      expect(pts.every((p) => p.revenue === 0 && p.generations === 0 && p.invoiceCount === 0)).toBe(true);
    });

    it('crosses a year boundary correctly', () => {
      const pts = buildMonthlySeries({ invoices: [], generations: [], months: 3, now: new Date(Date.UTC(2027, 0, 5)) });
      expect(pts.map((p) => p.month)).toEqual(['2026-11', '2026-12', '2027-01']);
    });

    it('sums only PAID invoices into the month they were issued, and counts generations by creation month', () => {
      const pts = buildMonthlySeries({
        invoices: [
          { total: 99, status: 'PAID', issuedAt: '2026-11-02T10:00:00.000Z' },
          { total: 51.5, status: 'PAID', issuedAt: '2026-11-17T23:59:59.000Z' },
          { total: 500, status: 'OPEN', issuedAt: '2026-11-03T10:00:00.000Z' },
          { total: 700, status: 'VOID', issuedAt: '2026-11-04T10:00:00.000Z' },
          { total: 49, status: 'PAID', issuedAt: '2026-09-30T23:59:59.000Z' },
          { total: 1000, status: 'PAID', issuedAt: '2025-01-01T00:00:00.000Z' }, // outside the window
          { total: 5, status: 'PAID', issuedAt: 'not a date' },
        ],
        generations: [
          { createdAt: Date.UTC(2026, 10, 1) },
          { createdAt: Date.UTC(2026, 10, 18) },
          { createdAt: Date.UTC(2026, 8, 15) },
          { createdAt: Date.UTC(2024, 0, 1) }, // outside the window
        ],
        months: 6,
        now: NOW,
      });
      const nov = pts.find((p) => p.month === '2026-11')!;
      const sep = pts.find((p) => p.month === '2026-09')!;
      expect(nov.revenue).toBe(150.5);
      expect(nov.invoiceCount).toBe(2);
      expect(nov.generations).toBe(2);
      expect(sep.revenue).toBe(49);
      expect(sep.generations).toBe(1);
      expect(pts.reduce((s, p) => s + p.revenue, 0)).toBe(199.5);
    });

    it('clamps the number of months to 1..24 and defaults to 6', () => {
      expect(buildMonthlySeries({ invoices: [], generations: [], months: 0, now: NOW })).toHaveLength(6);
      expect(buildMonthlySeries({ invoices: [], generations: [], months: 999, now: NOW })).toHaveLength(24);
      expect(buildMonthlySeries({ invoices: [], generations: [], months: 1, now: NOW })).toHaveLength(1);
    });
  });

  describe('GET /api/v1/admin/analytics/series', () => {
    it('rejects anonymous callers and returns real figures to the super admin', async () => {
      const app = createApp('all');

      const anon = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/series' });
      expect(anon.statusCode).toBe(401);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
      });
      expect(login.statusCode).toBe(200);
      const headers = { Authorization: `Bearer ${JSON.parse(login.body).token}` };

      const before = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/series?months=3', headers });
      expect(before.statusCode).toBe(200);
      const beforePoints = JSON.parse(before.body).data.points as Array<{ month: string; revenue: number }>;
      expect(beforePoints).toHaveLength(3);
      const thisMonth = new Date().toISOString().slice(0, 7);
      expect(beforePoints[2].month).toBe(thisMonth);
      const revenueBefore = beforePoints[2].revenue;

      // A real plan change creates a PAID invoice (subtotal + 8% tax) issued now.
      const tenantId = `tenant_series_${Date.now()}`;
      db.createTenant({ id: tenantId, name: 'Series Test Brand', slug: tenantId, contactEmail: 'series@test.example', status: 'ACTIVE', createdAt: Date.now() } as any);
      const changed = await billingCreditService.changeTenantPlan({
        tenantId,
        planSlug: 'PRO',
        actorId: 'user_admin',
        actorRole: 'SUPER_ADMIN',
      });
      expect(changed.invoice.status).toBe('PAID');

      const after = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/series?months=3', headers });
      const afterPoints = JSON.parse(after.body).data.points as Array<{ month: string; revenue: number; invoiceCount: number }>;
      expect(afterPoints[2].revenue).toBeCloseTo(revenueBefore + changed.invoice.total, 2);
      expect(afterPoints[2].invoiceCount).toBeGreaterThanOrEqual(1);

      // The overview no longer reports invented telemetry.
      const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/overview', headers });
      const tele = JSON.parse(overview.body).aiTelemetry;
      expect(tele.totalTryOnInvocations).toBe(db.getAllGenerations().length);
      expect(tele).not.toHaveProperty('gpuAllocated');
      expect(tele).not.toHaveProperty('avgInferenceLatencySec');
      expect(tele).not.toHaveProperty('modelReady');

      // The control-plane snapshot exposes the same invoices the dashboard turns into transactions.
      const snap = await app.inject({ method: 'GET', url: '/api/v1/admin/control-plane/snapshot', headers });
      expect(snap.statusCode).toBe(200);
      const invoices = JSON.parse(snap.body).data.invoices as Array<{ invoiceNo: string }>;
      expect(invoices.some((i) => i.invoiceNo === changed.invoice.invoiceNo)).toBe(true);
    });
  });
});
