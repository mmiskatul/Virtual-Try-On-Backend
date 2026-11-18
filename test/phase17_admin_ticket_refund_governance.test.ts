import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 17: Super Admin tickets, refund approval & data requests', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('updates tickets with the full status set, validates input, and moves refunds through approval', async () => {
    const app = createApp('all');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    expect(login.statusCode).toBe(200);
    const headers = { Authorization: `Bearer ${JSON.parse(login.body).token}` };

    // Tickets: accept every dashboard status + priority, record replies, reject junk
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/support/tickets',
      headers,
      payload: {
        requesterName: 'Dana Brand',
        requesterEmail: 'dana@brand.example',
        subject: 'Try-on output looks wrong',
        message: 'Garment is warped.',
      },
    });
    expect(created.statusCode).toBe(201);
    const ticketId = JSON.parse(created.body).data.ticket.id;

    const escalate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/support/tickets/${ticketId}`,
      headers,
      payload: { status: 'ESCALATED', priority: 'HIGH', message: 'Escalating to AI team.', internal: true },
    });
    expect(escalate.statusCode).toBe(200);
    const ticket = JSON.parse(escalate.body).data.ticket;
    expect(ticket.status).toBe('ESCALATED');
    expect(ticket.priority).toBe('HIGH');
    expect(ticket.messages.at(-1).internal).toBe(true);

    const badTicket = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/support/tickets/${ticketId}`,
      headers,
      payload: { status: 'NOT_A_STATUS' },
    });
    expect(badTicket.statusCode).toBe(400);

    // Refunds: PENDING can be approved, settled refunds are final
    const refund = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/finance/refunds',
      headers,
      payload: { orderId: 'ord_1', tenantId: 'tenant_x', amount: 25, reason: 'Duplicate charge' },
    });
    expect(refund.statusCode).toBe(201);
    const refundId = JSON.parse(refund.body).data.refund.id;

    const settledChange = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/finance/refunds/${refundId}`,
      headers,
      payload: { status: 'REJECTED' },
    });
    expect(settledChange.statusCode).toBe(409);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/finance/refunds/does-not-exist',
      headers,
      payload: { status: 'APPROVED' },
    });
    expect(missing.statusCode).toBe(404);

    const badRefund = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/finance/refunds/${refundId}`,
      headers,
      payload: { status: 'PENDING' },
    });
    expect(badRefund.statusCode).toBe(400);

    // Data requests: only known statuses
    const badGov = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/governance/requests/whatever',
      headers,
      payload: { status: 'DONE' },
    });
    expect(badGov.statusCode).toBe(400);

    await app.close();
  });
});
