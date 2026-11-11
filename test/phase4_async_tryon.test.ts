import './setup_env.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { seedTestUsers } from './helpers.js';
import { setCustomAiDispatcher } from '../src/modules/tryon/tryon.orchestrator.js';
import { storageAdapter } from '../src/infrastructure/storage.adapter.js';

describe('Phase 4: Async Try-On Pipeline (Upload Intent -> Jobs -> SSE/Poll -> Signed Results)', () => {
  beforeAll(() => {
    seedTestUsers();
  });

  afterEach(() => {
    setCustomAiDispatcher(null);
  });

  it('executes full signed upload -> async job -> AI completion -> owner-scoped result download -> idempotent replay', async () => {
    const app = createApp('all');
    const brandLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
    });
    const brandToken = JSON.parse(brandLogin.body).token;

    // Create a valid PNG garment + product
    const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0x22)]);
    await storageAdapter.upload('brand-assets', 'tenant_aura/prod_async/garment.png', validPng, 'image/png');

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { Authorization: `Bearer ${brandToken}` },
      payload: {
        name: 'Async Studio Silk Blazer',
        category: 'Tops',
        price: 340,
        sku: 'AURA-ASYNC-01',
        brandStorefrontPublished: true,
        marketplacePublished: true,
        isTryOnEligible: true,
        images: [`data:image/png;base64,${validPng.toString('base64')}`],
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const product = JSON.parse(prodRes.body).product;

    // Customer signs in
    const custLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/auth/login',
      payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
    });
    const custToken = JSON.parse(custLogin.body).token;

    // 1. Issue signed PUT upload URL
    const intentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/upload-url',
      headers: { Authorization: `Bearer ${custToken}` },
      payload: { contentType: 'image/jpeg', sizeBytes: 1024, consentGiven: true },
    });
    expect(intentRes.statusCode).toBe(201);
    const intent = JSON.parse(intentRes.body).data;
    expect(intent.bucket).toBe('customer-uploads');

    const validJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x33)]);
    const putPath = new URL(intent.uploadUrl).pathname + new URL(intent.uploadUrl).search;
    const putRes = await app.inject({
      method: 'PUT',
      url: putPath,
      headers: { 'content-type': 'image/jpeg' },
      payload: validJpeg,
    });
    expect(putRes.statusCode).toBe(200);

    // Plug deterministic AI Pipeline dispatcher writing real generated result to generated-results bucket
    let aiCallCount = 0;
    setCustomAiDispatcher(async (evt) => {
      aiCallCount++;
      const resKey = `${evt.tenantId}/${evt.generationId}/result.jpg`;
      await storageAdapter.upload('generated-results', resKey, validJpeg, 'image/jpeg');
      return {
        eventId: 'evt_ai_done_1',
        eventType: 'tryon.generation.completed',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        correlationId: evt.correlationId,
        generationId: evt.generationId,
        status: 'completed',
        result: { bucket: 'generated-results', objectKey: resKey, contentType: 'image/jpeg', width: 768, height: 1024 },
        metrics: { queueTimeMs: 5, preprocessingTimeMs: 12, inferenceTimeMs: 180, postprocessingTimeMs: 10, totalTimeMs: 207 },
        model: { key: evt.modelConfig.modelKey, version: evt.modelConfig.modelVersion },
      };
    });

    const subBefore = db.getSubscription(product.tenantId)!.tryOnUsed;

    // 2. Submit async job with Idempotency-Key
    const idemKey = `idem_async_${Date.now()}`;
    const jobRes = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/jobs',
      headers: {
        Authorization: `Bearer ${custToken}`,
        'Idempotency-Key': idemKey,
      },
      payload: {
        productId: product.id,
        personUpload: { bucket: intent.bucket, objectKey: intent.objectKey },
        quality: 'high_fidelity',
      },
    });
    expect(jobRes.statusCode).toBe(202);
    const jobData = JSON.parse(jobRes.body).data;
    expect(jobData.jobId).toBeTruthy();

    // Wait briefly for setImmediate async AI dispatch + settlement
    await new Promise((r) => setTimeout(r, 80));

    // 3. Poll job -> COMPLETED with signed download URL
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/try-on/jobs/${jobData.jobId}`,
      headers: { Authorization: `Bearer ${custToken}` },
    });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body).data;
    expect(statusBody.status).toBe('COMPLETED');
    expect(statusBody.resultUrl).toContain('/api/v1/storage/signed-download');
    expect(aiCallCount).toBe(1);

    // Signed download URL serves image bytes with nosniff header
    const dlPath = new URL(statusBody.resultUrl).pathname + new URL(statusBody.resultUrl).search;
    const dlRes = await app.inject({ method: 'GET', url: dlPath });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['x-content-type-options']).toBe('nosniff');

    // 4. Unauthorized caller without token gets 404
    const unauthRead = await app.inject({ method: 'GET', url: `/api/v1/try-on/jobs/${jobData.jobId}` });
    expect(unauthRead.statusCode).toBe(404);

    // 5. Idempotency replay returns same jobId without re-running AI or double-charging quota
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/jobs',
      headers: {
        Authorization: `Bearer ${custToken}`,
        'Idempotency-Key': idemKey,
      },
      payload: {
        productId: product.id,
        personUpload: { bucket: intent.bucket, objectKey: intent.objectKey },
      },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(JSON.parse(replayRes.body).data.duplicate).toBe(true);
    expect(JSON.parse(replayRes.body).data.jobId).toBe(jobData.jobId);
    expect(aiCallCount).toBe(1);
    expect(db.getSubscription(product.tenantId)!.tryOnUsed).toBe(subBefore + 1);

    // 6. Customer history lists their job cleanly
    const histRes = await app.inject({
      method: 'GET',
      url: '/api/v1/try-on/jobs',
      headers: { Authorization: `Bearer ${custToken}` },
    });
    expect(histRes.statusCode).toBe(200);
    expect(JSON.parse(histRes.body).data.jobs.some((j: any) => j.jobId === jobData.jobId)).toBe(true);

    // 7. Cancel queued job releases reserved credit
    setCustomAiDispatcher(async () => new Promise(() => {})); // never resolves so cancel tests QUEUED->CANCELLED cleanly
    const cancelSubmit = await app.inject({
      method: 'POST',
      url: '/api/v1/try-on/jobs',
      headers: { Authorization: `Bearer ${custToken}` },
      payload: {
        productId: product.id,
        personUpload: { bucket: intent.bucket, objectKey: intent.objectKey },
      },
    });
    const queuedJobId = JSON.parse(cancelSubmit.body).data.jobId;
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/try-on/jobs/${queuedJobId}/cancel`,
      headers: { Authorization: `Bearer ${custToken}` },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).data.status).toBe('CANCELLED');
    expect(db.getSubscription(product.tenantId)!.tryOnUsed).toBe(subBefore + 1); // released back!

    await app.close();
  });
});

