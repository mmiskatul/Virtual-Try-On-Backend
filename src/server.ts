import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './infrastructure/config.js';
import { observability } from './infrastructure/observability.js';
import { sanitizeObject } from './infrastructure/sanitization.js';
import { resolveCorrelationId } from './infrastructure/http.js';

// Route handlers
import { systemRoutes } from './routes/system.routes.js';
import { storageRoutes } from './routes/storage.routes.js';
import { brandAuthRoutes } from './routes/brand/auth.routes.js';
import { brandProductRoutes } from './routes/brand/product.routes.js';
import { brandCatalogExtRoutes } from './routes/brand/catalog_ext.routes.js';
import { brandFabricRoutes } from './routes/brand/fabric.routes.js';
import { brandInventoryRoutes } from './routes/brand/inventory.routes.js';
import { brandOrderRoutes } from './routes/brand/order.routes.js';
import { brandStorefrontRoutes } from './routes/brand/storefront.routes.js';
import { brandUploadRoutes } from './routes/brand/upload.routes.js';

import { marketplaceCatalogRoutes } from './routes/marketplace/catalog.routes.js';
import { marketplaceCatalogV2Routes } from './routes/marketplace/catalog_v2.routes.js';
import { marketplaceCheckoutRoutes } from './routes/marketplace/checkout.routes.js';
import { marketplaceTryOnRoutes } from './routes/marketplace/try_on.routes.js';
import { asyncTryOnRoutes } from './routes/tryon/async_tryon.routes.js';
import { commerceEngagementRoutes } from './routes/commerce/engagement.routes.js';
import { customerAuthRoutes } from './routes/marketplace/auth.routes.js';

import { adminAuthRoutes } from './routes/admin/auth.routes.js';
import { adminTenantRoutes } from './routes/admin/tenant.routes.js';
import { adminUsageRoutes } from './routes/admin/usage.routes.js';
import { adminAnalyticsRoutes } from './routes/admin/analytics.routes.js';
import { adminAuditRoutes } from './routes/admin/audit.routes.js';
import { adminTelemetryRoutes } from './routes/admin/telemetry.routes.js';
import { adminAiEngineRoutes } from './routes/admin/ai_engine.routes.js';
import { adminInfrastructureRoutes } from './routes/admin/infrastructure.routes.js';
import { adminControlPlaneRoutes } from './routes/admin/control_plane.routes.js';
import { sessionRbacRoutes } from './routes/auth/session_rbac.routes.js';
import { billingRoutes } from './routes/billing/billing.routes.js';

export type AppDomain = 'brand' | 'marketplace' | 'admin' | 'all';

export function createApp(domain: AppDomain = 'all'): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024 // 10MB
  });

  // CORS Configuration
  app.register(cors, {
    // Allowed origins come from CORS_ORIGINS in .env; if empty, any origin is allowed (development only).
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'x-idempotency-key',
      'x-try-on-token',
      'X-View-As-Session',
      'X-Correlation-Id',
      'X-Auth-Portal',
      'X-Auth-Transport',
    ]
  });

  // JWT Plugin (fail closed when JWT_SECRET is absent)
  if (!config.jwtSecret || config.jwtSecret.length < 16) {
    throw new Error('Missing or weak JWT_SECRET. Configure a >= 16 char JWT_SECRET in backend/.env.');
  }
  app.register(jwt, {
    secret: config.jwtSecret
  });

  // Multipart Form Data Plugin
  app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024 // 10MB
    }
  });

  // OpenAPI 3.1 / Swagger Documentation
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Multi-Tenant Virtual Try-On SaaS API',
        version: '2.1.0',
        description: 'Unified Fastify 5 platform API for Customer Marketplace, Brand Dashboard, and Super Admin Control Plane.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  // Observability & Correlation Hooks
  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = resolveCorrelationId(request);
    reply.header('x-correlation-id', request.correlationId);
    observability.trackRequestStart();
  });

  app.addHook('onResponse', async (_req, reply) => {
    observability.trackRequestEnd(reply.statusCode);
  });

  // Input Sanitization Hook
  app.addHook('preValidation', async (request) => {
    if (
      request.body &&
      typeof request.body === 'object' &&
      !Buffer.isBuffer(request.body) &&
      !(request.isMultipart && request.isMultipart())
    ) {
      request.body = sanitizeObject(request.body);
    }
  });

  // Global Error Handler
  app.setErrorHandler((error: any, _request, reply) => {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';
    reply.status(statusCode).send({
      error: error.name || 'InternalError',
      statusCode,
      message
    });
  });

  // Mount System, Private Signed Storage, and Unified Auth Session/RBAC Routes (Always available)
  app.register(systemRoutes);
  app.register(storageRoutes);
  app.register(sessionRbacRoutes);
  app.register(billingRoutes);

  // Mount Domain Routes
  if (domain === 'brand' || domain === 'all') {
    app.register(brandAuthRoutes);
    app.register(brandProductRoutes);
    app.register(brandCatalogExtRoutes);
    app.register(brandFabricRoutes);
    app.register(brandInventoryRoutes);
    app.register(brandOrderRoutes);
    app.register(brandStorefrontRoutes);
    app.register(brandUploadRoutes);
  }

  if (domain === 'marketplace' || domain === 'all') {
    app.register(marketplaceCatalogRoutes);
    app.register(marketplaceCatalogV2Routes);
    app.register(marketplaceCheckoutRoutes);
    app.register(marketplaceTryOnRoutes);
    app.register(asyncTryOnRoutes);
    app.register(commerceEngagementRoutes);
    app.register(customerAuthRoutes);
  }

  if (domain === 'admin' || domain === 'all') {
    app.register(adminAuthRoutes);
    app.register(adminTenantRoutes);
    app.register(adminUsageRoutes);
    app.register(adminAnalyticsRoutes);
    app.register(adminAuditRoutes);
    app.register(adminTelemetryRoutes);
    app.register(adminAiEngineRoutes);
    app.register(adminInfrastructureRoutes);
    app.register(adminControlPlaneRoutes);
  }

  return app;
}
