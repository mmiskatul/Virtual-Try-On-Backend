import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 7: Commerce Cart, Orders, Favorites, Verified Reviews, Support & Privacy Governance', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  it('supports server-side cart, favorites, reviews with tenant-scoped brand replies, support routing, and GDPR export/deletion', async () => {
    const app = createApp('all');

    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    const brandToken = JSON.parse(brandLogin.body).token;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Cashmere Drape Coat',
        category: 'Outerwear',
        price: 420,
        sku: `CASH-${Date.now()}`,
        marketplacePublished: true,
        brandStorefrontPublished: true,
      },
    });
    const product = JSON.parse(prodRes.body).product;

    // Customer signs in
    const custLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/auth/login',
      payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
    });
    const custToken = JSON.parse(custLogin.body).token;
    const custHeaders = { Authorization: `Bearer ${custToken}` };

    // 1. Add to cart & verify seller grouping
    const cartRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: custHeaders,
      payload: { productId: product.id, quantity: 2 },
    });
    expect(cartRes.statusCode).toBe(200);
    const cartData = JSON.parse(cartRes.body).data;
    expect(cartData.subtotal).toBe(840);
    expect(cartData.sellerGroups[0].tenantId).toBe(product.tenantId);

    // 2. Toggle Favorites
    const favAdd = await app.inject({
      method: 'POST',
      url: '/api/v1/favorites',
      headers: custHeaders,
      payload: { productId: product.id },
    });
    expect(favAdd.statusCode).toBe(201);
    expect(JSON.parse(favAdd.body).data.productIds).toContain(product.id);

    // 3. Submit Review & post Brand Reply (also verify cross-tenant reply blocked!)
    const revRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/reviews`,
      headers: custHeaders,
      payload: { rating: 5, comment: 'Tailoring and fabric drape matched the virtual try-on preview.' },
    });
    expect(revRes.statusCode).toBe(201);
    const review = JSON.parse(revRes.body).data.review;

    const replyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${review.id}/reply`,
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { reply: 'Thank you! We are thrilled our fitting preview helped you pick the right size.' },
    });
    expect(replyRes.statusCode).toBe(200);
    expect(JSON.parse(replyRes.body).data.review.brandReply).toContain('thrilled');

    // Other tenant (vogue) cannot reply to Aura's product review
    const now = Date.now();
    const marcusEmail = `marcus_${now}@voguecollective.com`;
    db.createUser({
      id: `user_vogue_${now}`,
      tenantId: 'tenant_vogue',
      name: 'Marcus Vance',
      email: marcusEmail,
      passwordHash: db.hashPassword('Test-Brand-Pass-2'),
      role: 'BRAND_OWNER',
      emailVerified: true,
      emailVerifiedAt: now,
      createdAt: now,
    });
    const otherBrandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: marcusEmail, password: 'Test-Brand-Pass-2' },
    });
    const otherBrandToken = JSON.parse(otherBrandLogin.body).token;
    const crossTenantReply = await app.inject({
      method: 'POST',
      url: `/api/v1/reviews/${review.id}/reply`,
      headers: { Authorization: `Bearer ${otherBrandToken}` },
      payload: { reply: 'Unauthorized cross-tenant reply' },
    });
    expect(crossTenantReply.statusCode).toBe(403);

    // 4. Customer submits Support Ticket & GDPR Account Export / Deletion -> shows up in Admin queue
    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      headers: custHeaders,
      payload: {
        subject: 'Question about winter size exchange',
        category: 'EXCHANGES',
        priority: 'MEDIUM',
        message: 'Could I swap my M cashmere coat for an L?',
      },
    });
    expect(ticketRes.statusCode).toBe(201);

    const exportRes = await app.inject({ method: 'GET', url: '/api/v1/account/export', headers: custHeaders });
    expect(exportRes.statusCode).toBe(200);
    expect(JSON.parse(exportRes.body).data.favorites).toContain(product.id);

    const delRes = await app.inject({
      method: 'POST',
      url: '/api/v1/account/delete-request',
      headers: custHeaders,
      payload: {},
    });
    expect(delRes.statusCode).toBe(200);

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    const adminToken = JSON.parse(adminLogin.body).token;
    const adminGov = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/governance/requests',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminGov.statusCode).toBe(200);
    expect(JSON.parse(adminGov.body).data.requests.some((r: any) => r.type === 'DELETE')).toBe(true);

    await app.close();
  });
});
