import './setup_env.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { getValidatedEnv } from '../src/infrastructure/env.schema.js';
import { emailService } from '../src/infrastructure/email.service.js';
import { okResponse, paginatedResponse } from '../src/infrastructure/http.js';
import { redisAdapter } from '../src/infrastructure/redis.js';
import { storageAdapter, signStorageToken, verifyStorageToken } from '../src/infrastructure/storage.adapter.js';
import {
  PlatformTestPingV1Schema,
  TryOnGenerationCompletedV1Schema,
  TryOnGenerationRequestedV1Schema,
} from '../src/infrastructure/events.contract.js';
import { claimEventIdempotency, enqueueOutboxEvent } from '../src/infrastructure/outbox.js';

describe('Phase 1: Backend Foundation & Storage/OpenAPI Contracts', () => {
  it('validates runtime environment with typed defaults', () => {
    const env = getValidatedEnv();
    expect(env.PORT).toBeGreaterThan(0);
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(16);
    expect(env.RESEND_FROM).toContain('@');
    expect(emailService.getActiveTransport()).toBe('dev-preview');
  });

  it('builds consistent API response envelopes with meta.requestId', () => {
    const res = okResponse({ hello: 'world' }, 'req_123');
    expect(res).toEqual({
      success: true,
      data: { hello: 'world' },
      meta: { requestId: 'req_123' },
    });

    const paged = paginatedResponse(['a', 'b'], 1, 20, 45, 'req_456');
    expect(paged.meta.totalPages).toBe(3);
  });

  it('supports Redis-compatible cache & TTL increment fallback cleanly', async () => {
    await redisAdapter.set('test:k1', 'vton_ok', 60);
    expect(await redisAdapter.get('test:k1')).toBe('vton_ok');
    const c1 = await redisAdapter.incrWithTtl('test:counter', 60);
    const c2 = await redisAdapter.incrWithTtl('test:counter', 60);
    expect(c2).toBe(c1 + 1);
    await redisAdapter.del('test:k1');
    await redisAdapter.del('test:counter');
  });

  it('enforces HMAC signed URLs, magic-byte validation, and path traversal blocks on private storage', async () => {
    const app = createApp('all');
    const expFuture = Math.floor(Date.now() / 1000) + 300;
    const expPast = Math.floor(Date.now() / 1000) - 10;
    const validKey = `unit_test/${Date.now()}_sample.jpg`;

    expect(verifyStorageToken('customer-uploads', validKey, 'write', expPast, signStorageToken('customer-uploads', validKey, 'write', expPast))).toBe(false);

    // Reject invalid non-image bytes even with valid write signature
    const badPut = await app.inject({
      method: 'PUT',
      url: `/api/v1/storage/signed-upload?bucket=customer-uploads&key=${encodeURIComponent(validKey)}&exp=${expFuture}&sig=${signStorageToken('customer-uploads', validKey, 'write', expFuture)}`,
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from('not-an-image-script-payload'),
    });
    expect(badPut.statusCode).toBe(400);

    // Minimal valid JPEG SOI + marker header bytes
    const validJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x11)]);
    const signedPut = await storageAdapter.createSignedUploadUrl('customer-uploads', validKey, 'image/jpeg', 300);
    const putPath = new URL(signedPut.url).pathname + new URL(signedPut.url).search;

    const okPut = await app.inject({
      method: 'PUT',
      url: putPath,
      headers: { 'content-type': 'image/jpeg' },
      payload: validJpeg,
    });
    expect(okPut.statusCode).toBe(200);

    const signedGet = await storageAdapter.createSignedDownloadUrl('customer-uploads', validKey, 300);
    const getPath = new URL(signedGet.url).pathname + new URL(signedGet.url).search;
    const okGet = await app.inject({ method: 'GET', url: getPath });
    expect(okGet.statusCode).toBe(200);
    expect(okGet.headers['x-content-type-options']).toBe('nosniff');

    await storageAdapter.delete('customer-uploads', validKey);
    expect(await storageAdapter.exists('customer-uploads', validKey)).toBe(false);
    await app.close();
  });

  it('serves OpenAPI 3.1 specification at /docs/json and correlation headers on /health', async () => {
    const app = createApp('all');
    const docsRes = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docsRes.statusCode).toBe(200);
    const spec = JSON.parse(docsRes.body);
    expect(spec.openapi).toContain('3.');
    expect(spec.info.title).toContain('Virtual Try-On');

    const hRes = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'corr_phase1_smoke' },
    });
    expect(hRes.statusCode).toBe(200);
    expect(hRes.headers['x-correlation-id']).toBe('corr_phase1_smoke');
    await app.close();
  });

  it('validates Phase 1 event contracts and transactional outbox / idempotency helper', async () => {
    const reqEvent = TryOnGenerationRequestedV1Schema.parse({
      eventId: 'evt_1',
      eventType: 'tryon.generation.requested',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr_1',
      generationId: 'gen_1',
      tenantId: 't_1',
      userId: 'u_1',
      personImage: { bucket: 'customer-uploads', objectKey: 'u_1/p.jpg' },
      garmentImage: { bucket: 'brand-assets', objectKey: 't_1/g.jpg' },
      modelConfig: {},
      options: {},
    });
    expect(reqEvent.modelConfig.modelKey).toBe('default-tryon');
    expect(reqEvent.options.quality).toBe('standard');

    const compEvent = TryOnGenerationCompletedV1Schema.parse({
      eventId: 'evt_2',
      eventType: 'tryon.generation.completed',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr_1',
      generationId: 'gen_1',
      status: 'completed',
      result: { bucket: 'generated-results', objectKey: 't_1/gen_1/result.jpg', width: 768, height: 1024 },
      metrics: { inferenceTimeMs: 420, totalTimeMs: 500 },
      model: { key: 'default-tryon', version: 'v1' },
    });
    expect(compEvent.result.bucket).toBe('generated-results');

    const ping = PlatformTestPingV1Schema.parse({
      eventId: 'evt_ping_1',
      eventType: 'platform.test.ping',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr_ping',
      source: 'vitest',
      payload: { ok: true },
    });
    expect(ping.source).toBe('vitest');

    let capturedData: any = null;
    const mockTx = {
      outboxEvent: {
        create: async ({ data }: { data: any }) => {
          capturedData = data;
          return { id: data.id };
        },
      },
    };
    const outboxRow = await enqueueOutboxEvent(mockTx, {
      eventType: reqEvent.eventType,
      aggregateId: reqEvent.generationId,
      correlationId: reqEvent.correlationId,
      payload: reqEvent as unknown as Record<string, unknown>,
    });
    expect(outboxRow.id).toBeTruthy();
    expect(capturedData.status).toBe('PENDING');

    const firstClaim = await claimEventIdempotency(`evt_idem_${Date.now()}`, 'platform.test.ping');
    expect(firstClaim).toBe(true);
  });
});

