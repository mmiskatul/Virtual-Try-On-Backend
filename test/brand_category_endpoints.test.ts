import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Brand Category Creation & Taxonomy Endpoints', () => {
  let auraToken = '';
  let vogueToken = '';

  beforeAll(async () => {
    db.reset();
    seedTestUsers();
    const now = Date.now();
    db.createUser({
      id: 'user_vogue_owner',
      tenantId: 'tenant_vogue',
      name: 'Marcus Vogue',
      email: 'marcus@voguecollective.com',
      passwordHash: db.hashPassword('Test-Brand-Pass-1'),
      role: 'BRAND_OWNER',
      emailVerified: true,
      emailVerifiedAt: now,
      createdAt: now,
    });

    const app = createApp('all');
    const auraLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(auraLogin.statusCode).toBe(200);
    auraToken = JSON.parse(auraLogin.body).token;

    const vogueLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'marcus@voguecollective.com', password: 'Test-Brand-Pass-1' },
    });
    expect(vogueLogin.statusCode).toBe(200);
    vogueToken = JSON.parse(vogueLogin.body).token;

    await app.close();
  });

  it('provides category form options, presets, and slug availability checks', async () => {
    const app = createApp('all');

    // 1. Form Options
    const optRes = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/categories/form-options',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(optRes.statusCode).toBe(200);
    const optData = JSON.parse(optRes.body).data;
    expect(Array.isArray(optData.presets)).toBe(true);
    expect(optData.presets).toContain('Dresses');
    expect(optData.tryOnClasses).toContain('tops');
    expect(typeof optData.defaultSortOrder).toBe('number');

    // 2. Check slug for an unused slug
    const checkAvail = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/categories/check-slug?name=Evening%20Silk%20Couture',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(checkAvail.statusCode).toBe(200);
    const availData = JSON.parse(checkAvail.body).data;
    expect(availData.available).toBe(true);
    expect(availData.slug).toBe('evening-silk-couture');

    await app.close();
  });

  it('creates category with full metadata and validates inputs (400 on invalid input)', async () => {
    const app = createApp('all');

    // 400 Bad Request if category name is too short
    const badRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { name: 'A' },
    });
    expect(badRes.statusCode).toBe(400);

    // Successful creation via POST /api/v1/brand/categories
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Evening Silk Gowns',
        slug: 'evening-silk-gowns',
        description: 'Exquisite evening silk gowns handcrafted in luxury atelier.',
        seoTitle: 'Luxury Evening Silk Gowns | Atelier Collection',
        parentCategory: 'Dresses',
        tryOnCategory: 'dresses',
        sortOrder: 10,
        active: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body).data.category;
    expect(created.name).toBe('Evening Silk Gowns');
    expect(created.slug).toBe('evening-silk-gowns');
    expect(created.tryOnCategory).toBe('dresses');

    // Creation via alias POST /api/v1/brand/categories/add
    const addAliasRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories/add',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Cashmere Knitwear',
        tryOnCategory: 'tops',
        sortOrder: 20,
      },
    });
    expect(addAliasRes.statusCode).toBe(201);
    const aliasData = JSON.parse(addAliasRes.body).data.category;
    expect(aliasData.name).toBe('Cashmere Knitwear');
    expect(aliasData.slug).toBe('cashmere-knitwear');

    await app.close();
  });

  it('rejects duplicate category slugs and duplicate names with 409 Conflict', async () => {
    const app = createApp('all');

    // Duplicate name conflict
    const dupNameRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Evening Silk Gowns',
        slug: 'evening-silk-gowns-unique',
      },
    });
    expect(dupNameRes.statusCode).toBe(409);
    const dupNameBody = JSON.parse(dupNameRes.body);
    expect(dupNameBody.code).toBe('DUPLICATE_CATEGORY_NAME');

    // Duplicate slug conflict
    const dupSlugRes = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Different Name But Same Slug',
        slug: 'evening-silk-gowns',
      },
    });
    expect(dupSlugRes.statusCode).toBe(409);
    const dupSlugBody = JSON.parse(dupSlugRes.body);
    expect(dupSlugBody.code).toBe('DUPLICATE_CATEGORY_SLUG');

    // Check slug endpoint reports unavailable with suggestion
    const checkTaken = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/categories/check-slug?slug=evening-silk-gowns',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(checkTaken.statusCode).toBe(200);
    const takenData = JSON.parse(checkTaken.body).data;
    expect(takenData.available).toBe(false);
    expect(takenData.suggestedSlug).toBe('evening-silk-gowns-2');

    await app.close();
  });

  it('supports category update, get by ID, delete, and reflects in product form options', async () => {
    const app = createApp('all');

    // 1. List categories
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listData = JSON.parse(listRes.body).data.categories;
    const target = listData.find((c: any) => c.slug === 'cashmere-knitwear');
    expect(target).toBeDefined();

    // 2. Get by ID
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/brand/categories/${target.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).data.category.id).toBe(target.id);

    // 3. Update Category
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/brand/categories/${target.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Ultra-Fine Cashmere Knitwear',
        seoTitle: 'Luxury Cashmere Tops',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.body).data.category.name).toBe('Ultra-Fine Cashmere Knitwear');

    // 4. Verify category reflects in Product Form Options
    const prodOptRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/form-options',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(prodOptRes.statusCode).toBe(200);
    const prodOptBody = JSON.parse(prodOptRes.body);
    const prodOptions = prodOptBody.data || prodOptBody;
    expect(prodOptions.categories).toContain('Evening Silk Gowns');
    expect(prodOptions.categories).toContain('Ultra-Fine Cashmere Knitwear');

    // 5. Delete Category
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/brand/categories/${target.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).data.deleted).toBe(true);

    await app.close();
  });
});
