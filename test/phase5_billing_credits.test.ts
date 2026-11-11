import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';
import { billingCreditService } from '../src/modules/billing/billing.service.js';

describe('Phase 5: Plans, Entitlements, Invoices & Atomic Credit Accounting', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('prevents negative credit overdrafts under concurrent reservations and settles promo credits first', async () => {
    const tenantId = `tenant_race_${Date.now()}`;
    const balStart = await billingCreditService.getCreditBalance(tenantId);
    // Normalize account to exact 3 promo credits by deducting base then granting 3 promo
    await billingCreditService.adjustCredits({
      tenantId,
      delta: -balStart.availableCredits,
      promo: false,
      reason: 'Zero baseline for concurrency unit test',
      actorId: 'test_admin',
      actorRole: 'SUPER_ADMIN',
    });
    await billingCreditService.adjustCredits({
      tenantId,
      delta: 3,
      promo: true,
      reason: 'Grant 3 promo units for race check',
      actorId: 'test_admin',
      actorRole: 'SUPER_ADMIN',
    });

    // Fire 5 concurrent credit reservations for cost = 1 each; strictly 3 must win, 2 fail
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        billingCreditService.reserveCredits({
          tenantId,
          units: 1,
          generationId: `gen_race_${i}_${Date.now()}`,
          actor: 'customer_1',
        })
      )
    );

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    expect(okCount).toBe(3);
    expect(failCount).toBe(2);

    const balAfter = await billingCreditService.getCreditBalance(tenantId);
    expect(balAfter.promoCredits).toBe(0);
    expect(balAfter.availableCredits).toBe(0);
    expect(balAfter.reservedCredits).toBe(3);
  });

  it('supports brand subscription upgrades, invoice creation, and admin promo credit grants', async () => {
    const app = createApp('all');

    const plansRes = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(plansRes.statusCode).toBe(200);
    const plans = JSON.parse(plansRes.body).data.plans;
    expect(plans.length).toBeGreaterThanOrEqual(3);

    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    const { token: brandToken, tenant } = JSON.parse(brandLogin.body);

    const subRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/billing/subscribe',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { planSlug: 'ENTERPRISE', billingInterval: 'ANNUAL' },
    });
    expect(subRes.statusCode).toBe(200);
    const subBody = JSON.parse(subRes.body).data;
    expect(subBody.subscription.plan).toBe('ENTERPRISE');
    expect(subBody.invoice.invoiceNo).toMatch(/^INV-/);
    expect(subBody.invoice.status).toBe('PAID');

    // Admin grants +250 promo credits with mandatory audit reason
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    const adminToken = JSON.parse(adminLogin.body).token;

    const grantRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${tenant.id}/credits/grant`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { delta: 250, promo: true, reason: 'Launch partner campaign credit boost' },
    });
    expect(grantRes.statusCode).toBe(200);
    const grantData = JSON.parse(grantRes.body).data;
    expect(grantData.account.promoCredits).toBeGreaterThanOrEqual(250);

    const billingRes = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/billing',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(billingRes.statusCode).toBe(200);
    const billingData = JSON.parse(billingRes.body).data;
    expect(billingData.invoices.length).toBeGreaterThanOrEqual(1);
    expect(billingData.ledger.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});

