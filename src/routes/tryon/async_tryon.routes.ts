import crypto from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { getValidatedEnv } from '../../infrastructure/env.schema.js';
import { okResponse } from '../../infrastructure/http.js';
import {
  TryOnGenerationCompletedV1Schema,
  TryOnGenerationFailedV1Schema,
} from '../../infrastructure/events.contract.js';
import { LogicalBucket } from '../../infrastructure/storage.adapter.js';
import { isSessionRevoked, resolveUserFromClaims, verifyDualJwt } from '../../modules/auth/jwt.verifier.js';
import { PLATFORM_ADMIN_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
import { tryonEventsBus, tryonOrchestrator } from '../../modules/tryon/tryon.orchestrator.js';

const UploadIntentSchema = z.object({
  contentType: z.string().default('image/jpeg'),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  consentGiven: z.boolean().default(true),
});

const CreateAsyncJobSchema = z.object({
  productId: z.string().min(1),
  personUpload: z
    .object({
      bucket: z.enum(['customer-uploads', 'brand-assets', 'garment-processing', 'generated-results', 'temporary']),
      objectKey: z.string().min(1),
    })
    .optional(),
  personImageUrl: z.string().optional(),
  personImage: z.string().optional(),
  garmentImageUrl: z.string().optional(),
  category: z.string().optional(),
  quality: z.enum(['fast_preview', 'standard', 'high_fidelity']).default('standard'),
  modelKey: z.string().default('default-tryon'),
  prompt: z.string().max(400).optional(),
  idempotencyKey: z.string().optional(),
});

async function resolveOptionalAuth(request: FastifyRequest): Promise<{
  userId?: string;
  tenantId?: string;
  isSuperAdmin: boolean;
}> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { isSuperAdmin: false };
  }
  try {
    const claims = await verifyDualJwt(request, authHeader.substring(7));
    if (claims.sid && (await isSessionRevoked(claims.sid))) {
      return { isSuperAdmin: false };
    }
    const user = await resolveUserFromClaims(claims);
    if (!user) return { isSuperAdmin: false };
    return {
      userId: user.id,
      tenantId: user.tenantId,
      isSuperAdmin: PLATFORM_ADMIN_ROLE_CODES.has(user.role),
    };
  } catch {
    return { isSuperAdmin: false };
  }
}

export async function asyncTryOnRoutes(app: FastifyInstance) {
  // 1. Issue signed PUT URL for private customer-uploads bucket
  app.post('/api/v1/try-on/upload-url', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = UploadIntentSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const auth = await resolveOptionalAuth(request);
    try {
      const intent = await tryonOrchestrator.createUploadIntent({
        userId: auth.userId,
        contentType: parsed.data.contentType,
        sizeBytes: parsed.data.sizeBytes,
        consentGiven: parsed.data.consentGiven,
      });
      return reply.status(201).send(okResponse(intent, request.correlationId));
    } catch (err: any) {
      return reply.status(400).send({ error: 'ValidationError', message: err?.message });
    }
  });

  // 2. Submit async virtual try-on generation job (with Idempotency-Key + Outbox + Worker/HTTP dispatch)
  app.post('/api/v1/try-on/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateAsyncJobSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'ValidationError', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const auth = await resolveOptionalAuth(request);
    const idemHeader = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;
    const idempotencyKey = idemHeader || parsed.data.idempotencyKey;

    const result = await tryonOrchestrator.submitAsyncJob({
      productId: parsed.data.productId,
      userId: auth.userId,
      callerTenantId: auth.tenantId,
      isSuperAdmin: auth.isSuperAdmin,
      personUpload: parsed.data.personUpload
        ? { bucket: parsed.data.personUpload.bucket as LogicalBucket, objectKey: parsed.data.personUpload.objectKey }
        : undefined,
      personImageUrl: parsed.data.personImageUrl || parsed.data.personImage,
      garmentImageUrl: parsed.data.garmentImageUrl,
      category: parsed.data.category,
      quality: parsed.data.quality,
      modelKey: parsed.data.modelKey,
      prompt: parsed.data.prompt,
      idempotencyKey,
      correlationId: request.correlationId,
    });

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error, message: result.message });
    }

    return reply.status(result.duplicate ? 200 : 202).send(
      okResponse(
        {
          ...(result.job || {}),
          duplicate: result.duplicate,
          ...(result.accessToken ? { accessToken: result.accessToken } : {}),
        },
        request.correlationId
      )
    );
  });

  // 3. List Try-On Job History (STRICTLY authenticated to own userId or tenantId)
  app.get('/api/v1/try-on/jobs', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const isAdmin = (request.roleCodes || [request.authUser!.role]).some((r) => PLATFORM_ADMIN_ROLE_CODES.has(r));
    const history = await tryonOrchestrator.listHistory({
      userId: request.authUser!.id,
      tenantId: request.tenant?.id,
      isSuperAdmin: isAdmin && !request.tenant,
      limit: Number((request.query as any)?.limit || 30),
    });
    return okResponse({ jobs: history }, request.correlationId);
  });

  // 4. Get single Try-On Job + signed download URL (owner / tenant / token strictly verified)
  app.get('/api/v1/try-on/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const auth = await resolveOptionalAuth(request);
    const rawToken = request.headers['x-try-on-token'] ?? (request.query as any)?.token;
    const authorized = tryonOrchestrator.authorizeJobAccess(id, {
      accessToken: typeof rawToken === 'string' ? rawToken : undefined,
      userId: auth.userId,
      tenantId: auth.tenantId,
      isSuperAdmin: auth.isSuperAdmin,
    });
    if (!authorized) {
      return reply.status(404).send({ error: 'NotFound', message: 'Try-on job not found.' });
    }
    const view = await tryonOrchestrator.getJobView(authorized.id);
    return okResponse(view, request.correlationId);
  });

  // 5. Server-Sent Events (SSE) live status stream for a Try-On Job
  app.get('/api/v1/try-on/jobs/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const auth = await resolveOptionalAuth(request);
    const rawToken = request.headers['x-try-on-token'] ?? (request.query as any)?.token;
    const authorized = tryonOrchestrator.authorizeJobAccess(id, {
      accessToken: typeof rawToken === 'string' ? rawToken : undefined,
      userId: auth.userId,
      tenantId: auth.tenantId,
      isSuperAdmin: auth.isSuperAdmin,
    });
    if (!authorized) {
      return reply.status(404).send({ error: 'NotFound', message: 'Try-on job not found.' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (eventName: string, data: unknown) => {
      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const initial = await tryonOrchestrator.getJobView(authorized.id);
    writeEvent('status', initial);

    if (initial && (initial.status === 'COMPLETED' || initial.status === 'FAILED' || initial.status === 'CANCELLED')) {
      reply.raw.end();
      return reply;
    }

    const listener = (payload: Record<string, unknown>) => {
      writeEvent('status', payload);
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED' || payload.status === 'CANCELLED') {
        cleanup();
      }
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      tryonEventsBus.off(`job:${authorized.id}`, listener);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    tryonEventsBus.on(`job:${authorized.id}`, listener);
    request.raw.on('close', cleanup);
    return reply;
  });

  // 6. Cancel queued Try-On Job & release reservation
  app.post('/api/v1/try-on/jobs/:id/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const auth = await resolveOptionalAuth(request);
    const rawToken = request.headers['x-try-on-token'] ?? (request.query as any)?.token;
    const authorized = tryonOrchestrator.authorizeJobAccess(id, {
      accessToken: typeof rawToken === 'string' ? rawToken : undefined,
      userId: auth.userId,
      tenantId: auth.tenantId,
      isSuperAdmin: auth.isSuperAdmin,
    });
    if (!authorized) {
      return reply.status(404).send({ error: 'NotFound', message: 'Try-on job not found.' });
    }
    const cancelled = await tryonOrchestrator.cancelJob(authorized.id);
    if (!cancelled.ok) {
      return reply.status(cancelled.status).send({ error: cancelled.error, message: cancelled.message });
    }
    return okResponse(cancelled.job, request.correlationId);
  });

  // 7. Internal Worker / AI Service HTTP callback settlement (X-Service-Key protected)
  app.post('/api/v1/internal/try-on/settlement', async (request: FastifyRequest, reply: FastifyReply) => {
    const keyHeader = request.headers['x-service-key'];
    const expectedKey = getValidatedEnv().INTERNAL_SERVICE_KEY;
    if (typeof keyHeader !== 'string' || keyHeader.length !== expectedKey.length || !crypto.timingSafeEqual(Buffer.from(keyHeader), Buffer.from(expectedKey))) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Invalid internal X-Service-Key header.' });
    }

    const body = (request.body as Record<string, unknown>) || {};
    if (body.eventType === 'tryon.generation.completed') {
      const parsed = TryOnGenerationCompletedV1Schema.parse(body);
      await tryonOrchestrator.settleOutcome(parsed);
      return okResponse({ settled: true, generationId: parsed.generationId }, request.correlationId);
    }
    if (body.eventType === 'tryon.generation.failed') {
      const parsed = TryOnGenerationFailedV1Schema.parse(body);
      await tryonOrchestrator.settleOutcome(parsed);
      return okResponse({ settled: true, generationId: parsed.generationId }, request.correlationId);
    }
    return reply.status(400).send({ error: 'ValidationError', message: 'Unsupported settlement eventType.' });
  });
}

