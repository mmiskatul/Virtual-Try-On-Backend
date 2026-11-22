import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import type { Order } from '../src/domain/types.js';
import { discountOf, percentChange, parsePeriod } from '../src/modules/reports/reports.service.js';
import { seedTestUsers } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => Date.now() - days * DAY;

function order(over: Partial<Order> & Pick<Order, 'id' | 'createdAt' | 'totalAmount' | 'customerEmail'>): Order {
  return {
    tenantId: 'tenant_aura',
    shippingAddress: { fullName: over.customerEmail.split('@')[0], street: '1 Test St', city: 'Dhaka', zipCode: '1200', country: 'BD' },
    items: [{ productId: 'prod_a', variantSku: 'A-M', productName: 'Linen Shirt', size: 'M', color: 'Ivory', quantity: 1, unitPrice: over.totalAmount, lineTotal: over.totalAmount }],
    subtotal: over.totalAmount,
    shippingFee: 0,
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    updatedAt: over.createdAt,
    ...over,
  } as Order;
}

describe('Brand reports and discount stats', () => {
  let token = '';
  let app: ReturnType<typeof createApp>;
  const get = (url: string, t = token) =>
    app.inject({ method: 'GET', url, headers: t ? { authorization: `Bearer ${t}` } : {} });

  beforeAll(async () => {
    db.reset();
    seedTestUsers();
    app = createApp('all');
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
    expect(login.statusCode).toBe(200);
    token = JSON.parse(login.body).token;

    // Start from no orders, so the demo orders that come with a fresh database do not change the numbers.
    db.getOrders().splice(0, db.getOrders().length);

    // Current 30-day period
    db.createOrder(order({ id: 'o1', customerEmail: 'rahim@example.com', createdAt: ago(2), totalAmount: 100 }));
    db.createOrder(order({ id: 'o2', customerEmail: 'rahim@example.com', createdAt: ago(5), totalAmount: 300, subtotal: 320, couponCode: 'EID10' }));
    db.createOrder(order({ id: 'o3', customerEmail: 'nadia@example.com', createdAt: ago(10), totalAmount: 200 }));
    db.createOrder(order({ id: 'o4', customerEmail: 'nadia@example.com', createdAt: ago(3), totalAmount: 999, status: 'CANCELLED' }));
    // Previous 30-day period (31 to 60 days ago), and another brand's order
    db.createOrder(order({ id: 'o5', customerEmail: 'old@example.com', createdAt: ago(40), totalAmount: 200 }));
    db.createOrder(order({ id: 'o6', customerEmail: 'rahim@example.com', createdAt: ago(45), totalAmount: 50 }));
    db.createOrder(order({ id: 'x1', tenantId: 'tenant_other', customerEmail: 'spy@example.com', createdAt: ago(1), totalAmount: 5000 }));
  });

  it('needs a login', async () => {
    const res = await get('/api/v1/brand/reports/sales', '');
    expect(res.statusCode).toBe(401);
  });

  it('sales: totals, change versus the last period, and a daily series', async () => {
    const res = await get('/api/v1/brand/reports/sales?period=30d');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.revenue).toBe(600); // o1 + o2 + o3; the cancelled order and other brands are left out
    expect(body.orders).toBe(3);
    expect(body.averageOrderValue).toBe(200);
    expect(body.previous.revenue).toBe(250); // o5 + o6
    expect(body.change.revenue).toBe(140);
    expect(body.discountsGiven).toBe(20); // o2: 320 subtotal, 300 paid
    expect(body.byStatus.CANCELLED).toBe(1);
    expect(body.series).toHaveLength(30);
    expect(body.series.reduce((s: number, d: { revenue: number }) => s + d.revenue, 0)).toBe(600);
  });

  it('uses 30 days when the period is missing or unknown, and 7 or 90 when asked', async () => {
    expect(parsePeriod(undefined)).toBe('30d');
    expect(parsePeriod('nonsense')).toBe('30d');
    const week = JSON.parse((await get('/api/v1/brand/reports/sales?period=7d')).body);
    expect(week.revenue).toBe(400); // o1 + o2
    expect(week.series).toHaveLength(7);
    const quarter = JSON.parse((await get('/api/v1/brand/reports/sales?period=90d')).body);
    expect(quarter.series.length).toBeGreaterThan(10); // weekly buckets
    expect(quarter.revenue).toBe(850);
  });

  it('products: ranks what sold and never includes cancelled orders', async () => {
    const body = JSON.parse((await get('/api/v1/brand/reports/products?period=30d')).body);
    expect(body.top[0]).toMatchObject({ productId: 'prod_a', name: 'Linen Shirt', units: 3, revenue: 600 });
    expect(body.totalUnits).toBe(3);
    expect(Array.isArray(body.notSold)).toBe(true);
  });

  it('customers: best customers, and new versus returning buyers', async () => {
    const body = JSON.parse((await get('/api/v1/brand/reports/customers?period=30d')).body);
    expect(body.totalCustomers).toBe(2);
    expect(body.top[0]).toMatchObject({ email: 'rahim@example.com', orders: 2, spent: 400 });
    expect(body.returningBuyers).toBe(1); // Rahim also bought 45 days ago
    expect(body.newBuyers).toBe(1); // Nadia's first sale is in this period
    expect(JSON.stringify(body)).not.toContain('spy@example.com');
  });

  it('try-on: counts sessions, success rate and the most tried garments', async () => {
    const make = (productId: string) => {
      const r = db.reserveGeneration({ tenantId: 'tenant_aura', productId, category: 'tops' });
      if (!r.ok) throw new Error('could not reserve');
      return r.job.id;
    };
    db.finalizeGeneration(make('prod_a'), 'COMPLETED');
    db.finalizeGeneration(make('prod_a'), 'COMPLETED');
    db.finalizeGeneration(make('prod_b'), 'FAILED', 'BAD_PHOTO');
    make('prod_b'); // still queued

    const body = JSON.parse((await get('/api/v1/brand/reports/try-on?period=7d')).body);
    expect(body.total).toBe(4);
    expect(body.completed).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.inProgress).toBe(1);
    expect(body.successRate).toBeCloseTo(66.67, 1);
    expect(body.series).toHaveLength(7);
    expect(body.topProducts[0].count).toBe(2);
  });

  it('discount stats: orders, sales and money given for each code', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/discounts',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: 'eid10', type: 'PERCENT', value: 10 },
    });
    expect(created.statusCode).toBe(201);

    const res = await get('/api/v1/brand/discounts/stats');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const row = body.stats.find((s: { code: string }) => s.code === 'EID10');
    expect(row).toMatchObject({ orders: 1, revenue: 300, discountGiven: 20 });
    expect(body.totals.discountGiven).toBe(20);
  });

  it('helper maths', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(discountOf({ subtotal: 100, shippingFee: 10, totalAmount: 90 } as Order)).toBe(20);
    expect(discountOf({ subtotal: 100, shippingFee: 0, totalAmount: 100 } as Order)).toBe(0);
  });
});
