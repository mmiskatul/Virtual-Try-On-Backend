import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { okResponse, paginatedResponse } from '../../infrastructure/http.js';
import { catalogRepository } from '../../modules/catalog/catalog.repository.js';

export async function marketplaceCatalogV2Routes(app: FastifyInstance) {
  // Paginated, searchable public marketplace catalog (ACTIVE tenants + APPROVED + marketplacePublished)
  app.get('/api/v1/marketplace/catalog', async (request: FastifyRequest) => {
    const query = (request.query as Record<string, string | undefined>) || {};
    const result = await catalogRepository.getPublicMarketplaceProducts({
      search: query.search || query.q,
      category: query.category,
      brand: query.brand,
      tryOnOnly: query.tryOnOnly === 'true',
      featuredOnly: query.featuredOnly === 'true',
      sort: query.sort,
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 24,
    });
    return paginatedResponse(result.items, result.page, result.limit, result.total, request.correlationId);
  });

  app.get('/api/v1/marketplace/categories', async (request: FastifyRequest) => {
    const categories = await catalogRepository.listCategories();
    return okResponse({ categories }, request.correlationId);
  });

  app.get('/api/v1/marketplace/collections', async (request: FastifyRequest) => {
    const collections = await catalogRepository.listCollections();
    return okResponse({ collections }, request.correlationId);
  });

  // Public Brand Storefront handler shared across /api/v1/marketplace/brands/:slug & /api/v1/brands/:slug
  const storefrontHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { slug } = request.params as { slug: string };
    const data = await catalogRepository.getPublicBrandStorefront(slug);
    if (!data) {
      return reply.status(404).send({
        error: 'StorefrontNotFound',
        message: 'Brand storefront not found or currently inactive.',
      });
    }
    return okResponse(data, request.correlationId);
  };

  app.get('/api/v1/marketplace/brands/:slug', storefrontHandler);
  app.get('/api/v1/brands/:slug', storefrontHandler);
}

