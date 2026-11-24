import { FastifyInstance, FastifyRequest } from 'fastify';
import { paginate } from '../../infrastructure/http.js';
import { db } from '../../infrastructure/database.js';
import { createBrandMiddleware } from '../../infrastructure/auth.guard.js';
import { NotFoundException } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { requireTenantContext } from './profile.service.js';
import type { Order } from '../../domain/types.js';

const guards = createBrandMiddleware(requirePermission('brand:orders', 'read'));

const round2 = (n: number) => Number(n.toFixed(2));
const isRevenue = (o: Order) => o.status !== 'CANCELLED' && o.paymentStatus !== 'FAILED' && o.paymentStatus !== 'REFUNDED';

function summarize(email: string, orders: Order[]) {
  const sorted = [...orders].sort((a, b) => b.createdAt - a.createdAt);
  const latest = sorted[0];
  const counted = orders.filter(isRevenue);
  return {
    email,
    name: latest?.shippingAddress?.fullName || email,
    city: latest?.shippingAddress?.city || '',
    country: latest?.shippingAddress?.country || '',
    orderCount: orders.length,
    totalSpent: round2(counted.reduce((s, o) => s + o.totalAmount, 0)),
    firstOrderAt: sorted[sorted.length - 1]?.createdAt ?? 0,
    lastOrderAt: latest?.createdAt ?? 0,
    group: orders.length >= 2 ? 'RETURNING' : 'NEW',
  };
}

/**
 * Customers are the people who bought from this brand. There is no separate customer table:
 * they are derived from the brand's own orders, so the list can never drift from reality and
 * one brand can never see another brand's shoppers.
 */
export async function brandCustomerRoutes(app: FastifyInstance) {
  app.get('/api/v1/brand/customers', { preHandler: guards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const byEmail = new Map<string, Order[]>();
    for (const o of db.getOrders().filter((x) => x.tenantId === tenant.id)) {
      const key = o.customerEmail.trim().toLowerCase();
      byEmail.set(key, [...(byEmail.get(key) || []), o]);
    }
    const customers = Array.from(byEmail.entries())
      .map(([email, orders]) => summarize(email, orders))
      .sort((a, b) => b.lastOrderAt - a.lastOrderAt);
    const { items: pageItems, page } = paginate(customers, request.query);
    return {
      customers: pageItems,
      ...(page ? { page } : {}),
      totals: {
        customers: customers.length,
        returning: customers.filter((c) => c.group === 'RETURNING').length,
        revenue: round2(customers.reduce((s, c) => s + c.totalSpent, 0)),
      },
    };
  });

  app.get('/api/v1/brand/customers/:email', { preHandler: guards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const email = decodeURIComponent((request.params as { email: string }).email).trim().toLowerCase();
    const orders = db.getOrders().filter((o) => o.tenantId === tenant.id && o.customerEmail.trim().toLowerCase() === email);
    if (orders.length === 0) throw new NotFoundException('Customer not found.');
    return {
      customer: summarize(email, orders),
      orders: [...orders]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((o) => ({
          id: o.id,
          status: o.status,
          paymentStatus: o.paymentStatus,
          totalAmount: o.totalAmount,
          itemCount: o.items?.reduce((s, i) => s + i.quantity, 0) ?? 0,
          createdAt: o.createdAt,
        })),
    };
  });
}
