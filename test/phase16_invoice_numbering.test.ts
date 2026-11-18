import './setup_env.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isUniqueViolation, nextInvoiceNumber } from '../src/modules/billing/invoice_number.js';

// A tiny in-memory stand-in for Prisma, switched on per test. Real databases are never touched.
const fake = vi.hoisted(() => ({ prisma: null as any }));
vi.mock('../src/infrastructure/prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/prisma.js')>();
  return { ...actual, getGlobalPrisma: () => fake.prisma };
});

const YEAR = new Date().getUTCFullYear();
const noop = new Proxy({}, { get: () => async () => null });

interface Row {
  id: string; tenantId: string; invoiceNo: string; period: string; subtotal: number; taxAmount: number; total: number;
  currency: string; status: string; dueDate: Date; issuedAt: Date;
}

function makeFakePrisma(rows: Row[], opts: { beforeCreate?: (attempt: number) => void } = {}) {
  const calls = { createAttempts: 0, subscriptionUpdates: 0 };
  const prisma: any = new Proxy(
    {
      calls,
      invoiceRecord: {
        findMany: async () => [...rows].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
        create: async ({ data }: { data: Row }) => {
          calls.createAttempts += 1;
          opts.beforeCreate?.(calls.createAttempts);
          if (rows.some((r) => r.invoiceNo === data.invoiceNo)) {
            throw Object.assign(new Error('Unique constraint failed on invoice_no'), { code: 'P2002' });
          }
          rows.push({ ...data });
          return data;
        },
      },
      subscription: { updateMany: async () => { calls.subscriptionUpdates += 1; return { count: 1 }; } },
      plan: { findMany: async () => [], upsert: async () => null },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(noop),
    },
    { get: (t: any, p: string) => (p in t ? t[p] : noop) },
  );
  return prisma;
}

const seedRow = (invoiceNo: string, minutesAgo: number): Row => ({
  id: crypto.randomUUID(), tenantId: 'tenant_old', invoiceNo, period: '2026-11', subtotal: 10, taxAmount: 0.8, total: 10.8, currency: 'BDT',
  status: 'PAID', dueDate: new Date(), issuedAt: new Date(Date.now() - minutesAgo * 60_000),
});

/** Loads a fresh copy of the billing service, which is what a backend restart looks like (empty memory). */
async function freshBilling() {
  vi.resetModules();
  const svc = (await import('../src/modules/billing/billing.service.js')).billingCreditService;
  const db = (await import('../src/infrastructure/database.js')).db; // the same instance the service uses
  return { svc, db };
}

let tenantSeq = 0;
function newTenant(db: any) {
  const id = `tenant_inv_${Date.now()}_${tenantSeq++}`;
  db.createTenant({ id, name: id, slug: id, contactEmail: `${id}@x.test`, status: 'ACTIVE', createdAt: Date.now() } as any);
  // a real tenant always has a subscription row; the plan change updates it
  db.data.subscriptions.push({ tenantId: id, plan: 'STARTER', productLimit: 50, tryOnMonthlyQuota: 500, tryOnUsed: 0, status: 'ACTIVE', updatedAt: Date.now() });
  return id;
}
const change = (svc: any, tenantId: string, planSlug: 'STARTER' | 'PRO' = 'PRO') =>
  svc.changeTenantPlan({ tenantId, planSlug, actorId: 'user_admin', actorRole: 'SUPER_ADMIN' });

describe('Phase 16: invoice numbering', () => {
  beforeEach(() => {
    fake.prisma = null;
  });

  describe('nextInvoiceNumber', () => {
    it('starts at 1001 for a year with no invoices', () => {
      expect(nextInvoiceNumber([], 2026)).toBe('INV-2026-1001');
    });

    it('continues one above the highest number of that year', () => {
      expect(nextInvoiceNumber(['INV-2026-1001', 'INV-2026-1003', 'INV-2026-1002'], 2026)).toBe('INV-2026-1004');
    });

    it('ignores other years and malformed numbers, and resets each January', () => {
      expect(nextInvoiceNumber(['INV-2025-1500', 'INV-2026-abc', 'X-2026-9999', 'INV-2026-', 'INV-2026-1002x'], 2026)).toBe('INV-2026-1001');
      expect(nextInvoiceNumber(['INV-2025-1500'], 2026)).toBe('INV-2026-1001');
    });

    it('keeps counting past four digits', () => {
      expect(nextInvoiceNumber(['INV-2026-9999'], 2026)).toBe('INV-2026-10000');
    });
  });

  describe('isUniqueViolation', () => {
    it('recognises Prisma and Postgres unique violations only', () => {
      expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
      expect(isUniqueViolation({ code: '23505' })).toBe(true);
      expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
      expect(isUniqueViolation(new Error('boom'))).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
    });
  });

  it('gives concurrent plan changes unique, consecutive numbers (no database)', async () => {
    const { svc, db } = await freshBilling();
    const results = await Promise.all([change(svc, newTenant(db)), change(svc, newTenant(db)), change(svc, newTenant(db)), change(svc, newTenant(db)), change(svc, newTenant(db))]);
    const numbers = results.map((r: any) => r.invoice.invoiceNo).sort();
    expect(new Set(numbers).size).toBe(5);
    expect(numbers).toEqual([1001, 1002, 1003, 1004, 1005].map((n) => `INV-${YEAR}-${n}`));
  });

  it('keeps counting after a restart instead of reusing numbers (database has earlier invoices)', async () => {
    const rows = [seedRow(`INV-${YEAR}-1001`, 30), seedRow(`INV-${YEAR}-1002`, 20), seedRow(`INV-${YEAR}-1003`, 10)];
    fake.prisma = makeFakePrisma(rows);

    const { svc, db } = await freshBilling(); // memory is empty, exactly like after a restart
    const { invoice } = await change(svc, newTenant(db));

    expect(invoice.invoiceNo).toBe(`INV-${YEAR}-1004`);
    expect(rows.map((r) => r.invoiceNo)).toContain(`INV-${YEAR}-1004`);
    expect(fake.prisma.calls.createAttempts).toBe(1);
  });

  it('retries with the next number when another instance took it first, and still updates the plan', async () => {
    const rows = [seedRow(`INV-${YEAR}-1001`, 10)];
    let raced = false;
    fake.prisma = makeFakePrisma(rows, {
      beforeCreate: () => {
        // another backend instance stores 1002 between our read and our insert
        if (!raced) {
          raced = true;
          rows.push(seedRow(`INV-${YEAR}-1002`, 1));
        }
      },
    });

    const { svc, db } = await freshBilling();
    const { invoice } = await change(svc, newTenant(db));

    expect(invoice.invoiceNo).toBe(`INV-${YEAR}-1003`);
    expect(fake.prisma.calls.createAttempts).toBe(2); // first clashed, second succeeded
    expect(rows.filter((r) => r.invoiceNo === `INV-${YEAR}-1003`)).toHaveLength(1);
    // the plan update must not be skipped just because the invoice insert clashed once
    expect(fake.prisma.calls.subscriptionUpdates).toBe(1);
  });

  it('keeps the invoice in memory when the database fails for another reason', async () => {
    const rows: Row[] = [];
    fake.prisma = makeFakePrisma(rows);
    fake.prisma.invoiceRecord.create = async () => { throw new Error('connection reset'); };

    const { svc, db } = await freshBilling();
    const { invoice } = await change(svc, newTenant(db));

    expect(invoice.invoiceNo).toBe(`INV-${YEAR}-1001`);
    expect((await svc.listInvoicesDurable()).some((i: any) => i.invoiceNo === invoice.invoiceNo)).toBe(true);
  });
});
