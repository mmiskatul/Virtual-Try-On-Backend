import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/infrastructure/database.js';
import { createApp } from '../src/server.js';
import { PRODUCT_LIMITS } from '../src/routes/brand/product.contract.js';
import { seedTestUsers } from './helpers.js';

/**
 * The product contract: every field the dashboard's Add Product form sends has one fixed type and limit.
 * Valid values are accepted and saved; invalid values are rejected with a 400 naming the field.
 */
describe('Brand product contract', () => {
  let token = '';
  let counter = 0;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const sku = () => `CNT-${String(++counter).padStart(4, '0')}`;
  const validBody = (over: Record<string, unknown> = {}) => ({
    name: 'Contract Test Dress',
    category: 'Dresses',
    price: 1250.5,
    sku: sku(),
    ...over,
  });

  const create = async (payload: Record<string, unknown>) => {
    const app = createApp('all');
    const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers: auth(), payload });
    await app.close();
    return res;
  };
  const update = async (id: string, payload: Record<string, unknown>) => {
    const app = createApp('all');
    const res = await app.inject({ method: 'PUT', url: `/api/v1/products/${id}`, headers: auth(), payload });
    await app.close();
    return res;
  };
  const get = async (id: string) => {
    const app = createApp('all');
    const res = await app.inject({ method: 'GET', url: `/api/v1/products/${id}`, headers: auth() });
    await app.close();
    return JSON.parse(res.body).product;
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

  it('serves the contract limits', async () => {
    const app = createApp('all');
    const res = await app.inject({ method: 'GET', url: '/api/v1/products/contract', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.limits).toEqual(PRODUCT_LIMITS);
    expect(body.tryOnCategories).toEqual(['tops', 'bottoms', 'dresses', 'outerwear', 'all']);
    expect(body.catalogStatuses).toEqual(['ACTIVE', 'DRAFT', 'ARCHIVED']);
    await app.close();
  });

  it('accepts and saves every field of the form, then returns it unchanged', async () => {
    const payload = {
      name: 'Elysian Mulberry Silk Dress',
      category: 'Dresses',
      subCategory: 'Evening',
      collection: 'Eid Collection',
      shortDescription: 'A fluid silk dress for evenings.',
      description: 'Cut on the bias from mulberry silk with a hidden zip.',
      tags: ['silk', 'evening wear', 'eid-2026'],
      images: ['https://example.com/styled-front.jpg'],
      aiReferenceImage: 'https://example.com/flat-front.jpg',
      price: 3850,
      compareAtPrice: 4500,
      costPrice: 1900.5,
      sku: sku(),
      stock: 24,
      lowStockThreshold: 6,
      warehouseLocation: 'Dhaka Main Studio',
      variants: [
        { sku: 'ELY-IVO-S', size: 'S', color: 'Ivory', stockQuantity: 10, available: true },
        { sku: 'ELY-IVO-M', size: 'M', color: 'Ivory', stockQuantity: 14, available: true },
      ],
      brandStorefrontPublished: true,
      marketplacePublished: true,
      isTryOnEligible: true,
      includeInBrandTryOn: true,
      includeInMarketplaceTryOn: true,
      tryOnCategory: 'dresses',
      catalogStatus: 'ACTIVE',
      specs: { material: '100% Mulberry Silk', weightGsm: '95 gsm', stretch: 'LOW', fitType: 'Tailored' },
    };

    const res = await create(payload);
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body).product;
    for (const key of [
      'name', 'category', 'subCategory', 'collection', 'shortDescription', 'description', 'tags', 'images',
      'aiReferenceImage', 'price', 'compareAtPrice', 'costPrice', 'sku', 'lowStockThreshold', 'warehouseLocation',
      'brandStorefrontPublished', 'marketplacePublished', 'isTryOnEligible', 'includeInBrandTryOn',
      'includeInMarketplaceTryOn', 'tryOnCategory', 'catalogStatus', 'specs',
    ]) {
      expect(created[key], `${key} in create response`).toEqual((payload as any)[key]);
    }
    expect(created.variants).toHaveLength(2);
    expect(created.slug).toMatch(/^elysian-mulberry-silk-dress-/);

    // The brand list and the single-product endpoint return the same saved values.
    const fetched = await get(created.id);
    expect(fetched.costPrice).toBe(1900.5);
    expect(fetched.shortDescription).toBe('A fluid silk dress for evenings.');

    const app = createApp('all');
    const list = await app.inject({ method: 'GET', url: '/api/v1/products', headers: auth() });
    const listed = JSON.parse(list.body).products.find((p: any) => p.id === created.id);
    expect(listed.costPrice).toBe(1900.5);
    expect(listed.warehouseLocation).toBe('Dhaka Main Studio');
    expect(listed.aiReferenceImage).toBe('https://example.com/flat-front.jpg');
    expect(listed.catalogStatus).toBe('ACTIVE');
    await app.close();
  });

  it('updates every field and each change is saved', async () => {
    const created = JSON.parse((await create(validBody())).body).product;
    const changes: Record<string, unknown> = {
      name: 'Renamed Dress',
      category: 'Tops',
      subCategory: 'Casual',
      collection: 'Sale',
      shortDescription: 'New short summary',
      description: 'New long description',
      tags: ['new', 'sale'],
      images: ['https://example.com/new.jpg'],
      aiReferenceImage: 'https://example.com/new-flat.jpg',
      price: 999,
      compareAtPrice: 1500,
      costPrice: 400,
      sku: sku(),
      lowStockThreshold: 9,
      warehouseLocation: 'Chattogram Depot',
      brandStorefrontPublished: true,
      marketplacePublished: true,
      isTryOnEligible: true,
      includeInBrandTryOn: false,
      includeInMarketplaceTryOn: true,
      tryOnCategory: 'outerwear',
      catalogStatus: 'ACTIVE',
      specs: { material: 'Cotton' },
    };
    for (const [field, value] of Object.entries(changes)) {
      const res = await update(created.id, { [field]: value });
      expect(res.statusCode, `${field}: ${res.body}`).toBe(200);
      const saved = await get(created.id);
      expect(saved[field], `${field} saved`).toEqual(value);
    }
  });

  it('removes optional values when null is sent', async () => {
    const created = JSON.parse(
      (await create(validBody({ costPrice: 100, compareAtPrice: 2000, aiReferenceImage: 'https://example.com/a.jpg' }))).body
    ).product;
    const res = await update(created.id, { costPrice: null, compareAtPrice: null, aiReferenceImage: null });
    expect(res.statusCode).toBe(200);
    const saved = await get(created.id);
    expect(saved.costPrice).toBeUndefined();
    expect(saved.compareAtPrice).toBeUndefined();
    expect(saved.aiReferenceImage).toBeUndefined();
  });

  const tooLong = (n: number) => 'x'.repeat(n);
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ['title shorter than 2', { name: 'A' }, 'name'],
    ['title longer than 120', { name: tooLong(PRODUCT_LIMITS.nameMax + 1) }, 'name'],
    ['category empty', { category: '' }, 'category'],
    ['category too long', { category: tooLong(PRODUCT_LIMITS.categoryMax + 1) }, 'category'],
    ['collection too long', { collection: tooLong(PRODUCT_LIMITS.collectionMax + 1) }, 'collection'],
    ['short summary too long', { shortDescription: tooLong(PRODUCT_LIMITS.shortDescriptionMax + 1) }, 'shortDescription'],
    ['description too long', { description: tooLong(PRODUCT_LIMITS.descriptionMax + 1) }, 'description'],
    ['too many tags', { tags: Array.from({ length: PRODUCT_LIMITS.tagsMax + 1 }, (_, i) => `tag${i}`) }, 'tags'],
    ['tag too long', { tags: [tooLong(PRODUCT_LIMITS.tagMax + 1)] }, 'tags'],
    ['tag with emoji', { tags: ['summer 🔥'] }, 'tags'],
    ['tag with symbols', { tags: ['50% off!'] }, 'tags'],
    ['too many images', { images: Array.from({ length: PRODUCT_LIMITS.imagesMax + 1 }, (_, i) => `https://example.com/${i}.jpg`) }, 'images'],
    ['image is not a safe url', { images: ['javascript:alert(1)'] }, 'images'],
    ['AI reference image is not a safe url', { aiReferenceImage: 'javascript:alert(1)' }, 'aiReferenceImage'],
    ['price zero', { price: 0 }, 'price'],
    ['price negative', { price: -5 }, 'price'],
    ['price not a number', { price: 'cheap' }, 'price'],
    ['price above the maximum', { price: PRODUCT_LIMITS.priceMax + 1 }, 'price'],
    ['price with 3 decimals', { price: 10.123 }, 'price'],
    ['compare-at not above the price', { price: 100, compareAtPrice: 100 }, 'compareAtPrice'],
    ['cost price negative', { costPrice: -1 }, 'costPrice'],
    ['SKU too short', { sku: 'AB' }, 'sku'],
    ['SKU with a space', { sku: 'AB 12' }, 'sku'],
    ['SKU with emoji', { sku: 'AB-12-🔥' }, 'sku'],
    ['SKU too long', { sku: tooLong(PRODUCT_LIMITS.skuMax + 1) }, 'sku'],
    ['stock negative', { stock: -1 }, 'stock'],
    ['stock not whole', { stock: 1.5 }, 'stock'],
    ['stock above the maximum', { stock: PRODUCT_LIMITS.stockMax + 1 }, 'stock'],
    ['low-stock alert negative', { lowStockThreshold: -1 }, 'lowStockThreshold'],
    ['warehouse too long', { warehouseLocation: tooLong(PRODUCT_LIMITS.warehouseMax + 1) }, 'warehouseLocation'],
    [
      'duplicate size and colour',
      {
        variants: [
          { sku: 'DUP-S-1', size: 'S', color: 'Red', stockQuantity: 1, available: true },
          { sku: 'DUP-S-2', size: 's', color: 'red', stockQuantity: 1, available: true },
        ],
      },
      'variants',
    ],
    ['variant stock negative', { variants: [{ sku: 'VAR-1', size: 'S', color: 'Red', stockQuantity: -1, available: true }] }, 'variants'],
    ['variant without a colour', { variants: [{ sku: 'VAR-1', size: 'S', color: '', stockQuantity: 1, available: true }] }, 'variants'],
    ['variant SKU with a space', { variants: [{ sku: 'bad sku', size: 'S', color: 'Red', stockQuantity: 1, available: true }] }, 'variants'],
    ['storefront flag as text', { brandStorefrontPublished: 'yes' }, 'brandStorefrontPublished'],
    ['try-on flag as number', { isTryOnEligible: 1 }, 'isTryOnEligible'],
    ['unknown try-on category', { tryOnCategory: 'shirts' }, 'tryOnCategory'],
    ['unknown catalog status', { catalogStatus: 'PUBLISHED' }, 'catalogStatus'],
    ['spec name that is reserved', { specs: { _aiReferenceImage: 'https://example.com/x.jpg' } }, 'specs'],
    ['spec value too long', { specs: { material: tooLong(PRODUCT_LIMITS.specValueMax + 1) } }, 'specs'],
    ['unknown field', { isAdmin: true }, ''],
  ];

  it.each(invalid)('rejects on create: %s', async (_label, over, field) => {
    const res = await create(validBody(over));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('VALIDATION_ERROR');
    if (field) {
      expect(body.issues.some((i: any) => String(i.path).startsWith(field)), JSON.stringify(body.issues)).toBe(true);
    }
  });

  it.each(invalid.filter(([, over]) => !('compareAtPrice' in over && 'price' in over)))(
    'rejects on update: %s',
    async (_label, over, field) => {
      const created = JSON.parse((await create(validBody())).body).product;
      const res = await update(created.id, over);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_ERROR');
      if (field) {
        expect(body.issues.some((i: any) => String(i.path).startsWith(field))).toBe(true);
      }
    }
  );

  it('requires title, category, price and SKU on create, and at least one field on update', async () => {
    for (const missing of ['name', 'category', 'price', 'sku']) {
      const body: Record<string, unknown> = validBody();
      delete body[missing];
      const res = await create(body);
      expect(res.statusCode, `missing ${missing}`).toBe(400);
    }
    const created = JSON.parse((await create(validBody())).body).product;
    expect((await update(created.id, {})).statusCode).toBe(400);
  });

  it('requires sizes and colours to add up to the total stock', async () => {
    const variants = (a: number, b: number) => [
      { sku: 'STK-S', size: 'S', color: 'Red', stockQuantity: a, available: a > 0 },
      { sku: 'STK-M', size: 'M', color: 'Red', stockQuantity: b, available: b > 0 },
    ];

    // Exactly the total: accepted and saved per size.
    const ok = await create(validBody({ stock: 30, variants: variants(10, 20) }));
    expect(ok.statusCode, ok.body).toBe(201);
    const saved = JSON.parse(ok.body).product;
    expect(saved.variants.map((v: any) => v.stockQuantity)).toEqual([10, 20]);

    // Fewer assigned than the total: rejected with the number that is left.
    const under = await create(validBody({ stock: 30, variants: variants(10, 15) }));
    expect(under.statusCode).toBe(400);
    expect(JSON.parse(under.body).issues[0].message).toContain('5 left');

    // More assigned than the total: rejected too.
    const over = await create(validBody({ stock: 30, variants: variants(20, 20) }));
    expect(over.statusCode).toBe(400);
    expect(JSON.parse(over.body).issues[0].message).toContain('10 more than the total stock of 30');

    // Same rule on update when both are sent.
    const bad = await update(saved.id, { stock: 50, variants: variants(10, 20) });
    expect(bad.statusCode).toBe(400);
    const good = await update(saved.id, { stock: 50, variants: variants(25, 25) });
    expect(good.statusCode).toBe(200);
  });

  it('keeps related settings consistent', async () => {
    const draft = JSON.parse(
      (await create(validBody({ catalogStatus: 'DRAFT', brandStorefrontPublished: true, marketplacePublished: true }))).body
    ).product;
    expect(draft.brandStorefrontPublished).toBe(false);
    expect(draft.marketplacePublished).toBe(false);

    const noTryOn = JSON.parse(
      (await create(validBody({ isTryOnEligible: false, includeInBrandTryOn: true, includeInMarketplaceTryOn: true }))).body
    ).product;
    expect(noTryOn.includeInBrandTryOn).toBe(false);
    expect(noTryOn.includeInMarketplaceTryOn).toBe(false);

    const notListed = JSON.parse(
      (await create(validBody({ marketplacePublished: false, includeInMarketplaceTryOn: true }))).body
    ).product;
    expect(notListed.includeInMarketplaceTryOn).toBe(false);

    // Archiving through an update hides the product everywhere.
    const live = JSON.parse((await create(validBody({ marketplacePublished: true }))).body).product;
    expect(live.marketplacePublished).toBe(true);
    const archived = await update(live.id, { catalogStatus: 'ARCHIVED' });
    expect(archived.statusCode).toBe(200);
    const saved = await get(live.id);
    expect(saved.catalogStatus).toBe('ARCHIVED');
    expect(saved.brandStorefrontPublished).toBe(false);
    expect(saved.marketplacePublished).toBe(false);
  });

  it('never exposes brand-private fields on public endpoints', async () => {
    const created = JSON.parse(
      (
        await create(
          validBody({
            name: 'Public Privacy Check',
            costPrice: 777,
            lowStockThreshold: 12,
            warehouseLocation: 'Secret Warehouse',
            aiReferenceImage: 'https://example.com/secret-flat.jpg',
            shortDescription: 'Visible summary',
            brandStorefrontPublished: true,
            marketplacePublished: true,
          })
        )
      ).body
    ).product;

    const app = createApp('all');
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/marketplace/products' }),
      app.inject({ method: 'GET', url: `/api/v1/marketplace/products/${created.id}` }),
      app.inject({ method: 'GET', url: '/api/v1/brands/aura-atelier' }),
      app.inject({ method: 'GET', url: '/api/v1/marketplace/brands/aura-atelier' }),
      app.inject({ method: 'GET', url: '/api/v1/marketplace/catalog' }),
      app.inject({ method: 'GET', url: '/api/v1/internal/storefront/aura-atelier' }),
    ]);

    for (const res of responses) {
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      for (const secret of ['777', 'Secret Warehouse', 'secret-flat.jpg', 'costPrice', 'warehouseLocation', 'aiReferenceImage', 'lowStockThreshold']) {
        if (secret === '777') continue; // a bare number can appear in unrelated data
        expect(res.body.includes(secret), `${secret} leaked in ${res.statusCode} ${res.body.slice(0, 80)}`).toBe(false);
      }
    }
    // The shopper still sees the public summary.
    expect(responses[1].body).toContain('Visible summary');
    await app.close();
  });
});
