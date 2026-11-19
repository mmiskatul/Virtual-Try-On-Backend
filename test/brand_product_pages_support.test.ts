import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { resolveGarmentImage } from '../src/routes/marketplace/try_on.routes.js';
import { seedTestUsers } from './helpers.js';

/**
 * Backend support for the redesigned products / categories / collections pages:
 *  - standard categories and collections are only offered until the brand creates its own
 *  - the AI reference image is stored with the product and preferred by the try-on flow
 *  - a product can be removed from a collection by sending an empty collection
 */
describe('Brand product pages backend support', () => {
  let token = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const unwrap = (body: string) => {
    const parsed = JSON.parse(body);
    return parsed?.data ?? parsed;
  };

  beforeAll(async () => {
    db.reset();
    seedTestUsers();
    const app = createApp('all');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    expect(login.statusCode).toBe(200);
    token = JSON.parse(login.body).token;
    await app.close();
  });

  it('offers standard categories and collections until the brand adds its own', async () => {
    const app = createApp('all');

    // Remove anything the seed data created so the brand starts empty.
    const catsBefore = await app.inject({ method: 'GET', url: '/api/v1/brand/categories', headers: auth() });
    for (const c of unwrap(catsBefore.body).categories.filter((c: any) => c.tenantId)) {
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/categories/${c.id}`, headers: auth() });
    }
    const colsBefore = await app.inject({ method: 'GET', url: '/api/v1/brand/collections', headers: auth() });
    for (const c of unwrap(colsBefore.body).collections.filter((c: any) => c.tenantId)) {
      await app.inject({ method: 'DELETE', url: `/api/v1/brand/collections/${c.id}`, headers: auth() });
    }

    const empty = await app.inject({ method: 'GET', url: '/api/v1/products/form-options', headers: auth() });
    expect(empty.statusCode).toBe(200);
    const emptyBody = unwrap(empty.body);
    expect(emptyBody.fabrics).toBeUndefined();
    expect(emptyBody.categories).toContain('Dresses');
    expect(emptyBody.collections).toContain('New Arrivals');

    const createCat = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/categories/add',
      headers: auth(),
      payload: { name: 'Evening Silk Edit', slug: 'evening-silk-edit', tryOnCategory: 'dresses', active: true },
    });
    expect(createCat.statusCode).toBe(201);
    const createCol = await app.inject({
      method: 'POST',
      url: '/api/v1/brand/collections',
      headers: auth(),
      payload: { title: 'Midnight Capsule' },
    });
    expect([200, 201]).toContain(createCol.statusCode);

    const own = await app.inject({ method: 'GET', url: '/api/v1/products/form-options', headers: auth() });
    const ownBody = unwrap(own.body);
    expect(ownBody.categories).toContain('Evening Silk Edit');
    expect(ownBody.categories).not.toContain('Dresses');
    expect(ownBody.collections).toContain('Midnight Capsule');
    expect(ownBody.collections).not.toContain('New Arrivals');

    await app.close();
  });

  it('stores the AI reference image and lets a product leave its collection', async () => {
    const app = createApp('all');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: auth(),
      payload: {
        name: 'Reference Test Dress',
        sku: 'REF-TEST-001',
        category: 'Evening Silk Edit',
        collection: 'Midnight Capsule',
        price: 120,
        stock: 4,
        images: ['https://example.com/styled-photo.jpg'],
        aiReferenceImage: 'https://example.com/flat-lay.jpg',
        specs: { material: 'Silk' },
      },
    });
    expect(create.statusCode).toBe(201);
    const product = JSON.parse(create.body).product;
    expect(product.aiReferenceImage).toBe('https://example.com/flat-lay.jpg');
    expect(product.collection).toBe('Midnight Capsule');

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}`,
      headers: auth(),
      payload: { collection: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body).product.collection).toBe('');

    await app.close();
  });

  it('gives the try-on AI the reference image instead of the styled photo', async () => {
    const tenantId = 'tenant_ref_test';
    const now = Date.now();
    const product = db.createProduct({
      id: 'prod_ref_test',
      tenantId,
      name: 'Ref Garment',
      slug: 'ref-garment',
      description: '',
      category: 'Dresses',
      sku: 'REF-GARMENT',
      price: 10,
      images: ['https://example.com/styled.jpg'],
      fabricIds: [],
      tags: [],
      brandStorefrontPublished: true,
      marketplacePublished: false,
      isTryOnEligible: true,
      tryOnCategory: 'dresses',
      aiReferenceImage: 'https://example.com/flat.jpg',
      variants: [],
      createdAt: now,
      updatedAt: now,
    } as any);

    // Styled display photo (or nothing) is swapped for the reference image.
    expect(resolveGarmentImage(product.id, 'https://example.com/styled.jpg')).toBe('https://example.com/flat.jpg');
    expect(resolveGarmentImage(product.id, '')).toBe('https://example.com/flat.jpg');
    // A colour-specific image that is not the main display photo is left alone.
    expect(resolveGarmentImage(product.id, 'https://example.com/red-variant.jpg')).toBe('https://example.com/red-variant.jpg');
    // Unknown product or no product id: keep what the client sent.
    expect(resolveGarmentImage('prod_missing', 'https://example.com/x.jpg')).toBe('https://example.com/x.jpg');
    expect(resolveGarmentImage(undefined, 'https://example.com/x.jpg')).toBe('https://example.com/x.jpg');

    // Products saved before the dedicated field existed keep working through the old specs key.
    const legacy = db.createProduct({
      ...product,
      id: 'prod_ref_legacy',
      sku: 'REF-LEGACY',
      aiReferenceImage: undefined,
      specs: { _aiReferenceImage: 'https://example.com/legacy-flat.jpg' },
    } as any);
    expect(resolveGarmentImage(legacy.id, 'https://example.com/styled.jpg')).toBe('https://example.com/legacy-flat.jpg');
  });
});
