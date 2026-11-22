import './setup_env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';
import { packProductMeta, unpackProductMeta, toPublicProduct } from '../src/domain/product_meta.js';

const app = createApp('all');
const json = (res: { body: string }) => JSON.parse(res.body);
const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0x22)]).toString('base64')}`;

describe('A product is for women, men or both', () => {
  let headers: { Authorization: string };
  let sku = 100;

  const create = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers,
      payload: {
        name: `Audience Test ${sku}`, category: 'Tops', price: 80, sku: `AUD-${sku++}`,
        brandStorefrontPublished: true, marketplacePublished: true, isTryOnEligible: true, images: [png],
        ...extra,
      },
    });

  beforeAll(async () => {
    seedTestUsers();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.70.0.1', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
    headers = { Authorization: `Bearer ${json(login).token}` };
  });

  it('is saved with the product, and shown back', async () => {
    for (const audience of ['WOMEN', 'MEN', 'UNISEX']) {
      const res = await create({ audience });
      expect(res.statusCode, audience).toBe(201);
      expect(json(res).product.audience).toBe(audience);
    }
  });

  it('means both when it was not chosen', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(json(res).product.audience).toBe('UNISEX');
  });

  it('refuses anything that is not women, men or both', async () => {
    for (const bad of ['KIDS', 'women', '', 5, null]) {
      const res = await create({ audience: bad });
      expect(res.statusCode, String(bad)).toBe(400);
    }
  });

  it('can be changed later, and the change is kept', async () => {
    const created = json(await create({ audience: 'WOMEN' })).product;
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/products/${created.id}`, headers, payload: { audience: 'MEN' } });
    expect(updated.statusCode).toBe(200);
    expect(json(updated).product.audience).toBe('MEN');
    const listed = json(await app.inject({ method: 'GET', url: '/api/v1/products', headers })).products;
    expect(listed.find((p: any) => p.id === created.id).audience).toBe('MEN');
    expect((await app.inject({ method: 'PUT', url: `/api/v1/products/${created.id}`, headers, payload: { audience: 'KIDS' } })).statusCode).toBe(400);
  });

  it('reaches shoppers on the public store, so the try-on page can show the right clothes', async () => {
    const women = json(await create({ audience: 'WOMEN', name: 'Public Women Dress' })).product;
    const men = json(await create({ audience: 'MEN', name: 'Public Men Shirt' })).product;
    const slug = db.getTenantById('tenant_aura')!.slug;
    const pub = json(await app.inject({ method: 'GET', url: `/api/v1/internal/storefront/${slug}` }));
    expect(pub.products.find((p: any) => p.id === women.id).audience).toBe('WOMEN');
    expect(pub.products.find((p: any) => p.id === men.id).audience).toBe('MEN');
  });

  it('is stored with the other product details', () => {
    expect(packProductMeta({ audience: 'MEN' }).audience).toBe('MEN');
    expect(unpackProductMeta(JSON.stringify({ audience: 'WOMEN' })).audience).toBe('WOMEN');
    expect(unpackProductMeta({}).audience).toBeUndefined();
    // It is not a private field.
    expect(toPublicProduct({ audience: 'MEN', costPrice: 5 } as never)).toEqual({ audience: 'MEN' });
  });
});
