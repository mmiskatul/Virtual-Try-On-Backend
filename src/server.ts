import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { config } from './infrastructure/config.js';
import { observability } from './infrastructure/observability.js';
import { sanitizeObject } from './infrastructure/sanitization.js';

// Route handlers
import { systemRoutes } from './routes/system.routes.js';
import { brandAuthRoutes } from './routes/brand/auth.routes.js';
import { brandProductRoutes } from './routes/brand/product.routes.js';
import { brandFabricRoutes } from './routes/brand/fabric.routes.js';
import { brandInventoryRoutes } from './routes/brand/inventory.routes.js';
import { brandOrderRoutes } from './routes/brand/order.routes.js';
import { brandStorefrontRoutes } from './routes/brand/storefront.routes.js';
import { brandUploadRoutes } from './routes/brand/upload.routes.js';

import { marketplaceCatalogRoutes } from './routes/marketplace/catalog.routes.js';
import { marketplaceCheckoutRoutes } from './routes/marketplace/checkout.routes.js';
import { marketplaceTryOnRoutes } from './routes/marketplace/try_on.routes.js';
import { customerAuthRoutes } from './routes/marketplace/auth.routes.js';

import { adminAuthRoutes } from './routes/admin/auth.routes.js';
import { adminTenantRoutes } from './routes/admin/tenant.routes.js';
import { adminAnalyticsRoutes } from './routes/admin/analytics.routes.js';
import { adminAuditRoutes } from './routes/admin/audit.routes.js';
import { adminTelemetryRoutes } from './routes/admin/telemetry.routes.js';
import { adminAiEngineRoutes } from './routes/admin/ai_engine.routes.js';

export type AppDomain = 'brand' | 'marketplace' | 'admin' | 'all';

export function createApp(domain: AppDomain = 'all'): FastifyInstance {
  const app = fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024 // 10MB
  });

  // CORS Configuration
  app.register(cors, {
    origin: true, // Allow frontend dashboards (3000, 3001, 3002, etc.)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-idempotency-key']
  });

  // JWT Plugin
  app.register(jwt, {
    secret: config.jwtSecret
  });

  // Multipart Form Data Plugin
  app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024 // 10MB
    }
  });

  // Observability & Telemetry Hooks
  app.addHook('onRequest', async () => {
    observability.trackRequestStart();
  });

  app.addHook('onResponse', async (_req, reply) => {
    observability.trackRequestEnd(reply.statusCode);
  });

  // Input Sanitization Hook
  app.addHook('preValidation', async (request) => {
    if (request.body && typeof request.body === 'object' && !(request.isMultipart && request.isMultipart())) {
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

  // Mount System Routes (Always available)
  app.register(systemRoutes);

  // Mount Domain Routes
  if (domain === 'brand' || domain === 'all') {
    app.register(brandAuthRoutes);
    app.register(brandProductRoutes);
    app.register(brandFabricRoutes);
    app.register(brandInventoryRoutes);
    app.register(brandOrderRoutes);
    app.register(brandStorefrontRoutes);
    app.register(brandUploadRoutes);
  }

  if (domain === 'marketplace' || domain === 'all') {
    app.register(marketplaceCatalogRoutes);
    app.register(marketplaceCheckoutRoutes);
    app.register(marketplaceTryOnRoutes);
    app.register(customerAuthRoutes);
  }

  if (domain === 'admin' || domain === 'all') {
    app.register(adminAuthRoutes);
    app.register(adminTenantRoutes);
    app.register(adminAnalyticsRoutes);
    app.register(adminAuditRoutes);
    app.register(adminTelemetryRoutes);
    app.register(adminAiEngineRoutes);
  }

  return app;
}
