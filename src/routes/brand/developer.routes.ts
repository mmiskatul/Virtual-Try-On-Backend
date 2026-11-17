import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { parseWithSchema } from '../../infrastructure/errors.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { API_SCOPES, WEBHOOK_EVENTS } from '../../domain/types.js';
import { ApiKeyCreateSchema, createApiKey, listApiKeys, publicKeyView, revokeApiKey } from '../../modules/developer/api_keys.js';
import {
  WebhookCreateSchema, WebhookUpdateSchema, createEndpoint, deleteEndpoint, listEndpoints, publicEndpointView,
  recentDeliveries, rotateSecret, sendTestEvent, updateEndpoint,
} from '../../modules/developer/webhooks.js';
import { requireTenantContext } from './profile.service.js';

// API keys and webhooks reach the whole shop, so only the owner and admins may manage them.
const guards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

export async function brandDeveloperRoutes(app: FastifyInstance) {
  const audit = (request: FastifyRequest, tenantId: string, action: string, entityId: string, details?: Record<string, unknown>) =>
    recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId,
      action, entity: 'Developer', entityId, correlationId: request.correlationId, details,
    });

  // ---------------- API keys
  app.get('/api/v1/brand/api-keys', { preHandler: guards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { keys: listApiKeys(tenant), scopes: API_SCOPES };
  });

  app.post('/api/v1/brand/api-keys', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(ApiKeyCreateSchema, request.body ?? {});
    const res = createApiKey(tenant, input, request.authUser!.id);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    await audit(request, tenant.id, 'API_KEY_CREATED', res.record.id, { name: res.record.name, scopes: res.record.scopes });
    reply.header('Cache-Control', 'no-store');
    // The only time the key is ever returned.
    return reply.status(201).send({ key: res.key, record: publicKeyView(res.record) });
  });

  app.delete('/api/v1/brand/api-keys/:id', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    if (!revokeApiKey(tenant, id)) return reply.status(404).send({ error: 'NotFound', message: 'Active key not found.' });
    await audit(request, tenant.id, 'API_KEY_REVOKED', id);
    return { revoked: true };
  });

  // ---------------- webhooks
  app.get('/api/v1/brand/webhooks', { preHandler: guards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return { webhooks: listEndpoints(tenant), events: WEBHOOK_EVENTS };
  });

  app.post('/api/v1/brand/webhooks', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(WebhookCreateSchema, request.body ?? {});
    const res = createEndpoint(tenant, input);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    await audit(request, tenant.id, 'WEBHOOK_CREATED', res.endpoint.id, { url: res.endpoint.url, events: res.endpoint.events });
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({ webhook: publicEndpointView(res.endpoint), secret: res.secret });
  });

  app.patch('/api/v1/brand/webhooks/:id', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    const patch = parseWithSchema(WebhookUpdateSchema, request.body ?? {});
    const res = updateEndpoint(tenant, id, patch);
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    await audit(request, tenant.id, 'WEBHOOK_UPDATED', id);
    return { webhook: publicEndpointView(res.endpoint) };
  });

  app.delete('/api/v1/brand/webhooks/:id', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    if (!deleteEndpoint(tenant, id)) return reply.status(404).send({ error: 'NotFound', message: 'Webhook address not found.' });
    await audit(request, tenant.id, 'WEBHOOK_DELETED', id);
    return { deleted: true };
  });

  app.post('/api/v1/brand/webhooks/:id/rotate-secret', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    const res = rotateSecret(tenant, id);
    if (!res) return reply.status(404).send({ error: 'NotFound', message: 'Webhook address not found.' });
    await audit(request, tenant.id, 'WEBHOOK_SECRET_ROTATED', id);
    reply.header('Cache-Control', 'no-store');
    return { secret: res.secret };
  });

  app.post('/api/v1/brand/webhooks/:id/test', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    const result = await sendTestEvent(tenant, id);
    if (!result) return reply.status(404).send({ error: 'NotFound', message: 'Webhook address not found.' });
    return { delivery: result };
  });

  app.get('/api/v1/brand/webhooks/:id/deliveries', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    if (!(tenant.storefrontSettings?.webhooks || []).some((e) => e.id === id)) {
      return reply.status(404).send({ error: 'NotFound', message: 'Webhook address not found.' });
    }
    return { deliveries: recentDeliveries(id) };
  });
}
