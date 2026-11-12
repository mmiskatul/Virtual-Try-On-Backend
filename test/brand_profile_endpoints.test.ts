import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import {
  ConflictException,
  NotFoundException,
  prismaErrorToAppError,
} from '../src/infrastructure/errors.js';
import { seedTestUsers } from './helpers.js';

describe('Brand Workspace Modular Profile, Identity, Verification, Media & Error Handling', () => {
  let brandToken = '';
  let customerToken = '';

  beforeAll(async () => {
    db.reset();
    seedTestUsers();

    // Ensure tenant_aura exists for elena@auraatelier.com if db.reset() cleared custom tenants
    if (!db.getTenantById('tenant_aura')) {
      const now = Date.now();
      db.createTenant({
        id: 'tenant_aura',
        name: 'Aura Atelier',
        slug: 'aura-atelier',
        status: 'ACTIVE',
        contactEmail: 'elena@auraatelier.com',
        storefrontSettings: {},
        createdAt: now,
        updatedAt: now,
      });
    }

    const app = createApp('all');
    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(brandLogin.statusCode).toBe(200);
    brandToken = JSON.parse(brandLogin.body).token;

    const custLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/auth/login',
      payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
    });
    expect(custLogin.statusCode).toBe(200);
    customerToken = JSON.parse(custLogin.body).token;
  });

  it('rejects unauthenticated requests (401) and non-brand roles (403)', async () => {
    const app = createApp('all');

    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/verification',
    });
    expect(unauth.statusCode).toBe(401);

    const custAttempt = await app.inject({
      method: 'PATCH',
      url: '/api/v1/brand/profile/details',
      headers: { Authorization: `Bearer ${customerToken}` },
      payload: { name: 'Hijacked Brand' },
    });
    expect(custAttempt.statusCode).toBe(403);
  });

  it('updates core profile details, persists settings, and computes verification readiness', async () => {
    const app = createApp('all');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/brand/profile/details',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Aura Atelier Dhaka',
        contactEmail: 'studio@auraatelier.com',
        owner: 'Elena Rostova',
        legalName: 'Aura Atelier Ltd.',
        businessType: 'Private Limited',
        registrationNumber: 'REG-BD-2026-991',
        establishedYear: '2022',
        phone: '+880 1711-000111',
        city: 'Dhaka',
        country: 'Bangladesh',
        address: 'Road 11, Banani',
        categoryFocus: 'Womenswear & Couture',
        slogan: 'Minimalist Silhouettes',
        shortDescription: 'Architectural essentials',
        description: 'Contemporary ready-to-wear crafted in Dhaka.',
        announcement: 'New Autumn Drop Live',
        socialLinks: {
          instagram: '@aura.atelier',
          website: 'https://auraatelier.com',
        },
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = JSON.parse(patchRes.body);
    expect(body.section).toBe('profile');
    expect(body.tenant.name).toBe('Aura Atelier Dhaka');
    expect(body.tenant.contactEmail).toBe('studio@auraatelier.com');
    expect(body.tenant.storefrontSettings.legalName).toBe('Aura Atelier Ltd.');
    expect(body.tenant.storefrontSettings.registrationNumber).toBe('REG-BD-2026-991');
    expect(body.verification.registrationNumber).toBe('REG-BD-2026-991');
    expect(body.verification.verificationScore).toBeGreaterThanOrEqual(70);

    const verRes = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/verification',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(verRes.statusCode).toBe(200);
    const verBody = JSON.parse(verRes.body);
    expect(verBody.totalChecks).toBe(7);
    expect(verBody.completedChecks).toBeGreaterThanOrEqual(5);
  });

  it('validates identity fields strictly and updates theme palette & typography', async () => {
    const app = createApp('all');

    const badColor = await app.inject({
      method: 'PATCH',
      url: '/api/v1/brand/identity',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        primaryColor: 'not-a-hex',
        buttonStyle: 'triangle',
      },
    });
    expect(badColor.statusCode).toBe(400);
    const errBody = JSON.parse(badColor.body);
    expect(errBody.error).toBe('ValidationError');
    expect(errBody.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(errBody.issues)).toBe(true);
    expect(errBody.issues.length).toBeGreaterThanOrEqual(2);
    expect(errBody.correlationId).toBeTruthy();

    const goodIdentity = await app.inject({
      method: 'PATCH',
      url: '/api/v1/brand/identity',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        storefrontTitle: 'Aura Atelier Flagship',
        primaryColor: '#111827',
        secondaryColor: '#374151',
        accentColor: '#B45309',
        backgroundColor: '#FFFDF8',
        textColor: '#0F172A',
        headingFont: 'Cormorant Garamond',
        bodyFont: 'Plus Jakarta Sans',
        buttonStyle: 'pill',
        headerStyle: 'noir-boutique',
      },
    });
    expect(goodIdentity.statusCode).toBe(200);
    const okBody = JSON.parse(goodIdentity.body);
    expect(okBody.tenant.storefrontSettings.primaryColor).toBe('#111827');
    expect(okBody.tenant.storefrontSettings.headingFont).toBe('Cormorant Garamond');
    expect(okBody.tenant.storefrontSettings.headerStyle).toBe('noir-boutique');
  });

  it('manages media slots via PUT/DELETE and rejects invalid slots or unsafe URLs', async () => {
    const app = createApp('all');

    const invalidSlot = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/media/favicon',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { url: 'https://cdn.example.com/logo.png' },
    });
    expect(invalidSlot.statusCode).toBe(400);

    const xssUrl = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/media/logo',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { url: 'javascript:alert(1)' },
    });
    expect(xssUrl.statusCode).toBe(400);

    const putLogo = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/media/logo',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { url: 'https://res.cloudinary.com/demo/image/upload/v1/logo.png' },
    });
    expect(putLogo.statusCode).toBe(200);
    expect(JSON.parse(putLogo.body).tenant.logoUrl).toBe(
      'https://res.cloudinary.com/demo/image/upload/v1/logo.png'
    );

    const putBanner = await app.inject({
      method: 'PUT',
      url: '/api/v1/brand/media/banner',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: { url: 'https://res.cloudinary.com/demo/image/upload/v1/banner.jpg' },
    });
    expect(putBanner.statusCode).toBe(200);
    expect(JSON.parse(putBanner.body).tenant.bannerUrl).toBe(
      'https://res.cloudinary.com/demo/image/upload/v1/banner.jpg'
    );

    // Verification score should now hit 100% since core details + logo + banner are all filled!
    const verFull = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/verification',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(JSON.parse(verFull.body).verificationScore).toBe(100);

    const delLogo = await app.inject({
      method: 'DELETE',
      url: '/api/v1/brand/media/logo',
      headers: { Authorization: `Bearer ${brandToken}` },
    });
    expect(delLogo.statusCode).toBe(200);
    expect(JSON.parse(delLogo.body).tenant.logoUrl).toBe('');
  });

  it('returns structured 404 JSON on unknown routes and maps Prisma error codes cleanly', async () => {
    const app = createApp('all');
    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/nonexistent-endpoint',
    });
    expect(notFoundRes.statusCode).toBe(404);
    const nfBody = JSON.parse(notFoundRes.body);
    expect(nfBody.error).toBe('NotFound');
    expect(nfBody.code).toBe('ROUTE_NOT_FOUND');
    expect(nfBody.correlationId).toBeTruthy();

    const conflictErr = prismaErrorToAppError({ code: 'P2002', meta: { target: ['slug'] } });
    expect(conflictErr).toBeInstanceOf(ConflictException);
    expect(conflictErr?.statusCode).toBe(409);

    const notFoundErr = prismaErrorToAppError({ code: 'P2025' });
    expect(notFoundErr).toBeInstanceOf(NotFoundException);
    expect(notFoundErr?.statusCode).toBe(404);
  });
});
