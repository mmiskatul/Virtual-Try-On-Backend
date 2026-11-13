import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';

describe('Brand Products & Catalog Management Endpoints', () => {
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

  it('validates product creation, rejects duplicate SKUs with 409, and supports stock + try-on toggles', async () => {
    const app = createApp('all');

    const badRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { name: '', category: 'Tops', price: -10, sku: '' },
    });
    expect(badRes.statusCode).toBe(400);
    expect(JSON.parse(badRes.body).code).toBe('VALIDATION_ERROR');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Sculpted Linen Tunic',
        category: 'Tops',
        collection: 'Atelier Resort',
        price: 165,
        stock: 30,
        sku: 'AUR-TUNIC-777',
        isTryOnEligible: true,
        tryOnCategory: 'tops',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body).product;
    expect(created.collection).toBe('Atelier Resort');
    expect(
      created.variants.reduce((sum: number, v: any) => sum + v.stockQuantity, 0)
    ).toBe(30);

    // Duplicate SKU returns 409 ConflictException
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Duplicate SKU Tunic',
        category: 'Tops',
        price: 120,
        sku: 'AUR-TUNIC-777',
      },
    });
    expect(dupRes.statusCode).toBe(409);
    expect(JSON.parse(dupRes.body).code).toBe('DUPLICATE_SKU');

    // Toggle isTryOnEligible via PATCH /api/v1/products/:id/publish
    const toggleTryOn = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}/publish`,
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { channel: 'isTryOnEligible', published: false },
    });
    expect(toggleTryOn.statusCode).toBe(200);
    expect(JSON.parse(toggleTryOn.body).isTryOnEligible).toBe(false);

    // Cross-tenant PUT/DELETE returns 404 NotFoundException
    const crossUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${created.id}`,
      headers: { Authorization: `Bearer ${vogueToken}` },
      payload: { name: 'Hijacked' },
    });
    expect(crossUpdate.statusCode).toBe(404);
    expect(JSON.parse(crossUpdate.body).code).toBe('NOT_FOUND');

    await app.close();
  });

  it('supports bulk CSV import, bulk visibility actions, and CSV/JSON export', async () => {
    const app = createApp('all');

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products/bulk-import',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        skipDuplicateSkus: true,
        rows: [
          { name: 'Cashmere Column Skirt', sku: 'AUR-SKT-901', category: 'Bottoms', price: 210, stock: 18 },
          { name: 'Milanese Cropped Blazer', sku: 'AUR-JKT-902', category: 'Jackets', price: 340, stock: 9 },
          { name: 'Duplicate Existing Row', sku: 'AUR-TUNIC-777', category: 'Tops', price: 99, stock: 4 },
        ],
      },
    });
    expect(importRes.statusCode).toBe(201);
    const importBody = JSON.parse(importRes.body);
    expect(importBody.importedCount).toBe(2);
    expect(importBody.skippedCount).toBe(1);
    expect(importBody.skipped[0].sku).toBe('AUR-TUNIC-777');

    const importedIds = importBody.importedProducts.map((p: any) => p.id);

    // Bulk publish to marketplace & enable try-on
    const bulkPub = await app.inject({
      method: 'PATCH',
      url: '/api/v1/products/bulk',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { productIds: importedIds, action: 'PUBLISH_MARKETPLACE' },
    });
    expect(bulkPub.statusCode).toBe(200);
    const bulkBody = JSON.parse(bulkPub.body);
    expect(bulkBody.updatedCount).toBe(2);
    expect(bulkBody.products.every((p: any) => p.marketplacePublished === true)).toBe(true);

    // Bulk validation failure
    const badBulk = await app.inject({
      method: 'PATCH',
      url: '/api/v1/products/bulk',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { productIds: [], action: 'INVALID_ACTION' },
    });
    expect(badBulk.statusCode).toBe(400);
    expect(JSON.parse(badBulk.body).code).toBe('VALIDATION_ERROR');

    // CSV Export
    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/export?format=csv',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('AUR-SKT-901');
    expect(csvRes.body).toContain('Cashmere Column Skirt');

    // JSON Export
    const jsonRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/export?format=json',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(jsonRes.statusCode).toBe(200);
    const jsonBody = JSON.parse(jsonRes.body);
    expect(jsonBody.total).toBeGreaterThanOrEqual(3);

    await app.close();
  });

  it('supports /products/form-options, /products/check-sku, and /products/addproduct workflow', async () => {
    const app = createApp('all');

    const optionsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/form-options',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(optionsRes.statusCode).toBe(200);
    const optionsBody = JSON.parse(optionsRes.body);
    expect(Array.isArray(optionsBody.categories)).toBe(true);
    expect(Array.isArray(optionsBody.collections)).toBe(true);
    expect(optionsBody.defaultCurrency).toBe('BDT');
    expect(optionsBody.quota.limit).toBeGreaterThan(0);

    const skuAvailRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/check-sku?sku=AUR-UNIQUE-888',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(skuAvailRes.statusCode).toBe(200);
    expect(JSON.parse(skuAvailRes.body).available).toBe(true);

    const skuTakenRes = await app.inject({
      method: 'GET',
      url: '/api/v1/products/check-sku?sku=AUR-TUNIC-777',
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(skuTakenRes.statusCode).toBe(200);
    expect(JSON.parse(skuTakenRes.body).available).toBe(false);

    const addProdRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products/addproduct',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Nocturne Organza Trench',
        category: 'Jackets',
        collection: 'Winter Gala',
        price: 420,
        stock: 16,
        sku: 'AUR-UNIQUE-888',
        brandStorefrontPublished: true,
        marketplacePublished: false,
        isTryOnEligible: true,
        tryOnCategory: 'outerwear',
      },
    });
    expect(addProdRes.statusCode).toBe(201);
    expect(JSON.parse(addProdRes.body).product.sku).toBe('AUR-UNIQUE-888');

    await app.close();
  });

  it('supports Category, Collection, and Fabric full CRUD with tenant isolation', async () => {
    const app = createApp('all');

    // Category create -> update -> delete
    const catCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { name: 'Silk Tailoring', sortOrder: 2 },
    });
    expect(catCreate.statusCode).toBe(201);
    const category = JSON.parse(catCreate.body).data.category;

    const catUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/brand/categories/${category.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { name: 'Silk Evening Tailoring', sortOrder: 1 },
    });
    expect(catUpdate.statusCode).toBe(200);
    expect(JSON.parse(catUpdate.body).data.category.name).toBe('Silk Evening Tailoring');

    const crossCatDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/brand/categories/${category.id}`,
      headers: { Authorization: `Bearer ${vogueToken}` },
    });
    expect(crossCatDelete.statusCode).toBe(404);

    const catDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/brand/categories/${category.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(catDelete.statusCode).toBe(200);

    // Collection create -> update -> delete
    const colCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/collections',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { title: 'Monochrome Capsule', description: 'Limited run' },
    });
    expect(colCreate.statusCode).toBe(201);
    const collection = JSON.parse(colCreate.body).data.collection;

    const colUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/brand/collections/${collection.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { title: 'Monochrome Winter Capsule' },
    });
    expect(colUpdate.statusCode).toBe(200);
    expect(JSON.parse(colUpdate.body).data.collection.title).toBe('Monochrome Winter Capsule');

    const colDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/brand/collections/${collection.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(colDelete.statusCode).toBe(200);

    // Fabric create -> update -> delete with Zod validation
    const fabInvalid = await app.inject({
      method: 'POST',
      url: '/api/v1/fabrics',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { name: 'A', composition: '' },
    });
    expect(fabInvalid.statusCode).toBe(400);
    expect(JSON.parse(fabInvalid.body).code).toBe('VALIDATION_ERROR');

    const fabCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/fabrics',
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: {
        name: 'Organic Poplin',
        composition: '100% GOTS Organic Cotton',
        stretch: 'LOW',
        thickness: 'LIGHT',
        care: 'Cold hand wash',
      },
    });
    expect(fabCreate.statusCode).toBe(201);
    const fabric = JSON.parse(fabCreate.body).fabric;
    expect(fabric.careInstructions).toBe('Cold hand wash');

    const fabUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/fabrics/${fabric.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
      payload: { thickness: 'MEDIUM' },
    });
    expect(fabUpdate.statusCode).toBe(200);
    expect(JSON.parse(fabUpdate.body).fabric.thickness).toBe('MEDIUM');

    const fabDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/fabrics/${fabric.id}`,
      headers: { Authorization: `Bearer ${auraToken}` },
    });
    expect(fabDelete.statusCode).toBe(200);

    await app.close();
  });
});
