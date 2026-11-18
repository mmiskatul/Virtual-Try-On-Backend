import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 18: subscription lifecycle, tenant notes & support agent', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('extends a trial, cancels once, and stores attributed tenant notes and the support agent', async () => {
    const app = createApp('all');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    expect(login.statusCode).toBe(200);
    const headers = { Authorization: `Bearer ${JSON.parse(login.body).token}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers,
      payload: { name: 'Trial Atelier', slug: `trial-${Date.now()}`, contactEmail: 'owner@trial.example' },
    });
    expect(created.statusCode).toBe(201);
    const tenantId = JSON.parse(created.body).data.tenant.id;

    // Trial: starts from now, then stacks on the current end date
    const first = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/extend-trial`, headers, payload: { days: 14 } });
    expect(first.statusCode).toBe(200);
    const firstSub = JSON.parse(first.body).data.subscription;
    expect(firstSub.status).toBe('TRIALING');
    expect(firstSub.trialEndsAt).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const second = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/extend-trial`, headers, payload: { days: 7 } });
    expect(JSON.parse(second.body).data.subscription.trialEndsAt).toBeGreaterThan(firstSub.trialEndsAt + 6 * 86_400_000);

    const badDays = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/extend-trial`, headers, payload: { days: 500 } });
    expect(badDays.statusCode).toBe(400);

    // Cancel: needs a reason, works once, then conflicts
    const noReason = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/cancel`, headers, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/cancel`, headers, payload: { reason: 'Brand closed' } });
    expect(cancel.statusCode).toBe(200);
    expect(JSON.parse(cancel.body).data.subscription.status).toBe('CANCELLED');
    const again = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/cancel`, headers, payload: { reason: 'Brand closed' } });
    expect(again.statusCode).toBe(409);
    const trialAfter = await app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${tenantId}/extend-trial`, headers, payload: { days: 5 } });
    expect(trialAfter.statusCode).toBe(409);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/admin/subscriptions/nope/cancel', headers, payload: { reason: 'Brand closed' } });
    expect(missing.statusCode).toBe(404);

    // Notes: attributed, newest first
    const emptyNote = await app.inject({ method: 'POST', url: `/api/v1/admin/tenants/${tenantId}/notes`, headers, payload: { note: '   ' } });
    expect(emptyNote.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/v1/admin/tenants/${tenantId}/notes`, headers, payload: { note: 'Asked for invoice copy.' } });
    const second2 = await app.inject({ method: 'POST', url: `/api/v1/admin/tenants/${tenantId}/notes`, headers, payload: { note: 'Called back, resolved.' } });
    expect(second2.statusCode).toBe(201);
    const ctx = JSON.parse(second2.body).data;
    expect(ctx.notes.map((n: any) => n.note)).toEqual(['Called back, resolved.', 'Asked for invoice copy.']);
    expect(ctx.notes[0].author).toBeTruthy();

    // Support agent must be platform staff
    const users = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers })).body).data.users;
    const staff = users.find((u: any) => u.email === 'admin@vton-platform.io');
    const customer = users.find((u: any) => u.role === 'CUSTOMER') || users.find((u: any) => u.role === 'BRAND_OWNER');
    const notStaff = await app.inject({ method: 'PUT', url: `/api/v1/admin/tenants/${tenantId}/support-agent`, headers, payload: { agentId: customer.id } });
    expect(notStaff.statusCode).toBe(400);
    const assigned = await app.inject({ method: 'PUT', url: `/api/v1/admin/tenants/${tenantId}/support-agent`, headers, payload: { agentId: staff.id } });
    expect(assigned.statusCode).toBe(200);
    expect(JSON.parse(assigned.body).data.assignedSupportAgent.id).toBe(staff.id);

    const read = await app.inject({ method: 'GET', url: `/api/v1/admin/tenants/${tenantId}/admin-context`, headers });
    expect(JSON.parse(read.body).data.notes).toHaveLength(2);

    await app.close();
  });
});
