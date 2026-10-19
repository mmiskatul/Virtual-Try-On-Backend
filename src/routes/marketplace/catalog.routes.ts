import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';

export async function marketplaceCatalogRoutes(app: FastifyInstance) {
  // Discovery & Search with Filters
  app.get('/api/v1/marketplace/products', async (request: FastifyRequest) => {
    const query = request.query as {
      category?: string;
      brand?: string;
      q?: string;
      minPrice?: string;
      maxPrice?: string;
      tryOnOnly?: string;
    };

    let products = db.getMarketplaceProducts();

    if (query.category && query.category.toLowerCase() !== 'all') {
      const cat = query.category.toLowerCase();
      products = products.filter(p => p.category.toLowerCase() === cat || (p.subCategory && p.subCategory.toLowerCase() === cat));
    }

    if (query.brand && query.brand.toLowerCase() !== 'all') {
      const brandQuery = query.brand.toLowerCase();
      products = products.filter(p => p.brandSlug.toLowerCase() === brandQuery || p.brandName.toLowerCase().includes(brandQuery));
    }

    if (query.q) {
      const q = query.q.toLowerCase().trim();
      products = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.brandName.toLowerCase().includes(q) ||
        p.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    if (query.minPrice) {
      const min = Number(query.minPrice);
      if (!isNaN(min)) products = products.filter(p => p.price >= min);
    }

    if (query.maxPrice) {
      const max = Number(query.maxPrice);
      if (!isNaN(max)) products = products.filter(p => p.price <= max);
    }

    if (query.tryOnOnly === 'true') {
      products = products.filter(p => p.isTryOnEligible);
    }

    return products;
  });

  // Product Details
  app.get('/api/v1/marketplace/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const all = db.getMarketplaceProducts();
    const product = all.find(p => p.id === id);

    if (!product) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'Product not found in marketplace catalog.'
      });
    }

    const tenant = db.getTenantById(product.tenantId);
    const relatedProducts = all.filter(p => p.tenantId === product.tenantId && p.id !== product.id).slice(0, 4);

    return {
      product,
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logoUrl: tenant.logoUrl,
        bannerUrl: tenant.bannerUrl,
        description: tenant.description,
        storefrontSettings: tenant.storefrontSettings
      } : undefined,
      relatedProducts
    };
  });

  // Smart Recommendations
  app.get('/api/v1/marketplace/recommendations', async (request: FastifyRequest) => {
    const { category, excludeId } = request.query as { category?: string; excludeId?: string };
    let products = db.getMarketplaceProducts().filter(p => p.isTryOnEligible);

    if (excludeId) {
      products = products.filter(p => p.id !== excludeId);
    }

    if (category) {
      const cat = category.toLowerCase();
      const matched = products.filter(p => p.category.toLowerCase() === cat);
      if (matched.length >= 3) return matched.slice(0, 6);
    }

    return products.slice(0, 6);
  });
}
