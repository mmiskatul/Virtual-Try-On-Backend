import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Phase 3: Catalog, Variants, Dual Publication, Storefront & Moderation', () => {
  beforeAll(() => {
    db.reset();
    seedTestUsers();
  });

  it('supports brand categories, collections, variants, and dual visibility storefront vs marketplace', async () => {
    const app = createApp('all');
    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(brandLogin.statusCode).toBe(200);
    const brandToken = JSON.parse(brandLogin.body).token;
    const brandTenant = JSON.parse(brandLogin.body).tenant;

    // 1. Create Category & Collection
    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { name: 'Evening Silk', sortOrder: 1 },
    });
    expect(catRes.statusCode).toBe(201);

    const colRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/collections',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { title: 'Atelier Autumn 2026', description: 'Tailored drape pieces' },
    });
    expect(colRes.statusCode).toBe(201);

    // 2. Create Storefront-only product (NOT published to marketplace yet)
    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Obsidian Silk Slip Dress',
        category: 'Dresses',
        price: 295,
        sku: 'AURA-OBS-01',
        brandStorefrontPublished: true,
        marketplacePublished: false,
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const product = JSON.parse(prodRes.body).product;

    // 3. Upsert SKU variant
    const varRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product.id}/variants`,
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { sku: 'AURA-OBS-01-L', size: 'L', color: 'Obsidian', stockQuantity: 12 },
    });
    expect(varRes.statusCode).toBe(201);

    // 4. Visible on Brand Storefront (/api/v1/brands/:slug), NOT visible on Marketplace (/api/v1/marketplace/catalog)
    const sfRes = await app.inject({ method: 'GET', url: `/api/v1/brands/${brandTenant.slug}` });
    expect(sfRes.statusCode).toBe(200);
    const sfBody = JSON.parse(sfRes.body);
    expect(sfBody.data.products.some((p: any) => p.id === product.id)).toBe(true);
    expect(sfBody.data.categories.some((c: any) => c.slug === 'evening-silk')).toBe(true);

    const mktBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/catalog?search=Obsidian%20Silk%20Slip',
    });
    expect(mktBefore.statusCode).toBe(200);
    expect(JSON.parse(mktBefore.body).data.some((p: any) => p.id === product.id)).toBe(false);

    // 5. Publish to Marketplace -> visible in catalog search
    const pubRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${product.id}/publish`,
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { channel: 'marketplacePublished', published: true },
    });
    expect(pubRes.statusCode).toBe(200);

    const mktAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/catalog?search=Obsidian%20Silk%20Slip',
    });
    expect(JSON.parse(mktAfter.body).data.some((p: any) => p.id === product.id)).toBe(true);

    // 6. Moderator REJECTS listing -> removed from marketplace AND brand self-republish blocked 403 ModerationBlocked
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
    });
    const adminToken = JSON.parse(adminLogin.body).token;

    const modRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/moderation/products/${product.id}`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { moderationStatus: 'REJECTED', note: 'Contains unverified garment tag image' },
    });
    expect(modRes.statusCode).toBe(200);

    const mktModerated = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/catalog?search=Obsidian%20Silk%20Slip',
    });
    expect(JSON.parse(mktModerated.body).data.some((p: any) => p.id === product.id)).toBe(false);

    const blockedRepublish = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${product.id}/publish`,
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { channel: 'marketplacePublished', published: true },
    });
    expect(blockedRepublish.statusCode).toBe(403);
    expect(JSON.parse(blockedRepublish.body).error).toBe('ModerationBlocked');

    await app.close();
  });

  it('persists brand onboarding completion and extended profile fields across backend reload', async () => {
    const app = createApp('all');
    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(brandLogin.statusCode).toBe(200);
    const brandToken = JSON.parse(brandLogin.body).token;

    const draftPut = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/profile',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Veloura Test House',
        description: 'Editorial outerwear & digital fit.',
        contactEmail: 'owner@velouratest.com',
        storefrontSettings: {
          storefrontTitle: 'Veloura Official Flagship',
          slogan: 'Tailored Fit Preview',
          shortDescription: 'Architectural outerwear built for AI try-on.',
          categoryFocus: "Women's Wear, Casual Wear",
          categories: ["Women's Wear", 'Casual Wear'],
          ownerName: 'Founder Test',
          legalName: 'Veloura House Ltd.',
          businessType: 'Fashion House / D2C Brand',
          currency: 'EUR',
          socialLinks: {
            instagram: '@velouratest',
            website: 'https://velouratest.example.com',
          },
          onboardingCompleted: false,
        },
      },
    });
    expect(draftPut.statusCode).toBe(200);

    const midReload = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/profile',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(midReload.statusCode).toBe(200);
    const midTenant = JSON.parse(midReload.body).tenant;
    expect(midTenant.storefrontSettings.onboardingCompleted).toBe(false);
    expect(midTenant.storefrontSettings.storefrontTitle).toBe('Veloura Official Flagship');

    const finalSavePut = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/profile',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Veloura Test House',
        storefrontSettings: {
          onboardingCompleted: true,
        },
      },
    });
    expect(finalSavePut.statusCode).toBe(200);

    const themeOnlyPut = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/storefront-settings',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        primaryColor: '#1E3A8A',
      },
    });
    expect(themeOnlyPut.statusCode).toBe(200);

    const finalReload = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/profile',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(finalReload.statusCode).toBe(200);
    const reloadedSettings = JSON.parse(finalReload.body).tenant.storefrontSettings;
    expect(reloadedSettings.onboardingCompleted).toBe(true);
    expect(typeof reloadedSettings.onboardingCompletedAt).toBe('number');
    expect(reloadedSettings.storefrontTitle).toBe('Veloura Official Flagship');
    expect(reloadedSettings.legalName).toBe('Veloura House Ltd.');
    expect(reloadedSettings.categories).toEqual(["Women's Wear", 'Casual Wear']);
    expect(reloadedSettings.primaryColor).toBe('#1E3A8A');
    expect(reloadedSettings.socialLinks?.instagram).toBe('@velouratest');

    await app.close();
  });

  it('validates onboarding storefront styles, media uploads, and product inputs and outputs with Zod', async () => {
    const app = createApp('all');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(loginRes.statusCode).toBe(200);
    const brandToken = JSON.parse(loginRes.body).token;

    // 1. Accept all 8 supported storefront header designs (including split-reverse, magazine, grid-showcase, noir-boutique)
    for (const style of [
      'split',
      'split-reverse',
      'minimal',
      'centered',
      'cover',
      'magazine',
      'grid-showcase',
      'noir-boutique',
    ] as const) {
      const okPut = await app.inject({
        method: 'PUT',
        url: '/api/v1/brand/storefront-settings',
        headers: { Authorization: `Bearer ${brandToken}` },
        payload: {
          headerStyle: style,
          primaryColor: '#0F172A',
          accentColor: '#C2410C',
          currency: 'BDT',
        },
      });
      expect(okPut.statusCode).toBe(200);
      const body = JSON.parse(okPut.body);
      expect(body.tenant.storefrontSettings.headerStyle).toBe(style);
      expect(body.tenant.storefrontSettings.currency).toBe('BDT');
    }

    // Check public storefront output also validates cleanly and omits contactEmail
    const publicRes = await app.inject({
      method: 'GET',
      url: '/api/v1/internal/storefront/aura-atelier',
    });
    expect(publicRes.statusCode).toBe(200);
    const publicJson = JSON.parse(publicRes.body);
    expect(publicJson.tenant.storefrontSettings.headerStyle).toBe('noir-boutique');
    expect(publicJson.tenant.contactEmail).toBeUndefined();

    // 2. Reject invalid headerStyle, malformed color, and unsafe logoUrl
    const badStyle = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/storefront-settings',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { headerStyle: 'invalid-layout' },
    });
    expect(badStyle.statusCode).toBe(400);
    expect(JSON.parse(badStyle.body).error).toBe('ValidationError');

    const badColor = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/storefront-settings',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { primaryColor: 'not-a-hex' },
    });
    expect(badColor.statusCode).toBe(400);
    expect(JSON.parse(badColor.body).error).toBe('ValidationError');

    const badLogo = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/profile',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { logoUrl: 'javascript:alert(1)' },
    });
    expect(badLogo.statusCode).toBe(400);
    expect(JSON.parse(badLogo.body).error).toBe('ValidationError');

    // 3. Validate upload input (reject SVG script URI, accept PNG base64) & verify output shape
    const badUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { imageBase64: 'data:image/svg+xml;base64,PHN2Zy8+' },
    });
    expect(badUpload.statusCode).toBe(400);
    expect(JSON.parse(badUpload.body).error).toBe('ValidationError');

    const goodUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        imageBase64:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        filename: 'logo.png',
      },
    });
    expect(goodUpload.statusCode).toBe(201);
    const uploadJson = JSON.parse(goodUpload.body);
    expect(uploadJson.success).toBe(true);
    expect(uploadJson.mimeType).toBe('image/png');
    expect(typeof uploadJson.url).toBe('string');

    // 4. Reject negative product price via Zod schema
    const badProduct = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { name: 'Bad Item', category: 'Tops', price: -50, sku: 'BAD-1' },
    });
    expect(badProduct.statusCode).toBe(400);
    expect(JSON.parse(badProduct.body).error).toBe('ValidationError');

    await app.close();
  });
});

