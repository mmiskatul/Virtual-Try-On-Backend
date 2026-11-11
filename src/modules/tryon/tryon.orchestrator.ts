import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GenerationJob } from '../../domain/types.js';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { getValidatedEnv } from '../../infrastructure/env.schema.js';
import { logger } from '../../infrastructure/logger.js';
import { LogicalBucket, storageAdapter } from '../../infrastructure/storage.adapter.js';
import {
  TryOnGenerationCompletedV1,
  TryOnGenerationCompletedV1Schema,
  TryOnGenerationFailedV1,
  TryOnGenerationFailedV1Schema,
  TryOnGenerationRequestedV1,
  TryOnGenerationRequestedV1Schema,
} from '../../infrastructure/events.contract.js';
import { enqueueOutboxEvent } from '../../infrastructure/outbox.js';
import { rabbitMqBus } from '../../infrastructure/rabbitmq.js';
import { redisAdapter } from '../../infrastructure/redis.js';
import { billingCreditService } from '../billing/billing.service.js';

export type ExtendedJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface AsyncJobMeta {
  jobId: string;
  tenantId: string;
  userId?: string;
  status: ExtendedJobStatus;
  personBucket: LogicalBucket;
  personObjectKey: string;
  garmentBucket: LogicalBucket;
  garmentObjectKey: string;
  resultBucket?: LogicalBucket;
  resultObjectKey?: string;
  modelKey: string;
  modelVersion: string;
  quality: 'fast_preview' | 'standard' | 'high_fidelity';
  correlationId: string;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
  createdAt: number;
  updatedAt: number;
}

const uploadRegistry = new Map<
  string,
  { id: string; userId?: string; bucket: LogicalBucket; objectKey: string; contentType: string; sizeBytes: number; consentGiven: boolean; expiresAt: Date }
>();

const asyncJobMeta = new Map<string, AsyncJobMeta>();

// Allows Vitest/unit tests to plug in a mock AI dispatcher or real FastAPI endpoint seamlessly
export type AiDispatchHandler = (
  event: TryOnGenerationRequestedV1
) => Promise<TryOnGenerationCompletedV1 | TryOnGenerationFailedV1>;

let customAiDispatcher: AiDispatchHandler | null = null;
export function setCustomAiDispatcher(handler: AiDispatchHandler | null): void {
  customAiDispatcher = handler;
}

class TryOnEventBus extends EventEmitter {
  public emitJobUpdate(jobId: string, payload: Record<string, unknown>): void {
    this.emit(`job:${jobId}`, payload);
  }
}

export const tryonEventsBus = new TryOnEventBus();

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function decodeDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } | null {
  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const contentType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { buffer: Buffer.from(match[2], 'base64'), contentType };
}

async function fetchRemoteImageSafely(urlStr: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    // Allow internal loopback only when pointing at localhost dev storage/API; block cloud metadata IPs
    if (host === '169.254.169.254' || host.endsWith('.internal')) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(urlStr, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    return { buffer: buf, contentType: ALLOWED_IMAGE_TYPES[ct] ? ct : 'image/jpeg' };
  } catch {
    return null;
  }
}

export class TryOnOrchestrator {
  public async createUploadIntent(input: {
    userId?: string;
    contentType: string;
    sizeBytes: number;
    consentGiven: boolean;
  }) {
    const normalizedCt = input.contentType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : input.contentType.toLowerCase();
    const ext = ALLOWED_IMAGE_TYPES[normalizedCt];
    if (!ext) {
      throw new Error(`Unsupported image type '${input.contentType}'. Supported: image/jpeg, image/png, image/webp.`);
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > 10 * 1024 * 1024) {
      throw new Error('Image size must be between 1 byte and 10 MB.');
    }

    const uploadId = crypto.randomUUID();
    const ownerFolder = (input.userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const objectKey = `${ownerFolder}/${uploadId}/person.${ext}`;
    const signed = await storageAdapter.createSignedUploadUrl('customer-uploads', objectKey, normalizedCt, 300);

    const record = {
      id: uploadId,
      userId: input.userId,
      bucket: 'customer-uploads' as LogicalBucket,
      objectKey,
      contentType: normalizedCt,
      sizeBytes: input.sizeBytes,
      consentGiven: input.consentGiven,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    uploadRegistry.set(uploadId, record);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        let userProfileId: string | null = null;
        if (input.userId) {
          const prof = await prisma.userProfile.findUnique({ where: { userId: input.userId } });
          userProfileId = prof?.id ?? null;
        }
        await prisma.customerUpload.create({
          data: {
            id: uploadId,
            userProfileId,
            bucket: 'customer-uploads',
            objectKey,
            contentType: normalizedCt,
            sizeBytes: input.sizeBytes,
            consentGiven: input.consentGiven,
            expiresAt: record.expiresAt,
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'tryon.upload_intent_prisma_warning');
      }
    }

    return {
      uploadId,
      bucket: 'customer-uploads',
      objectKey,
      uploadUrl: signed.url,
      method: signed.method,
      headers: signed.headers || { 'Content-Type': normalizedCt },
      expiresAt: signed.expiresAt,
    };
  }

  private async ingestImageIntoBucket(params: {
    bucket: LogicalBucket;
    objectKeyHint: string;
    existingRef?: { bucket: LogicalBucket; objectKey: string };
    imageUrl?: string;
  }): Promise<{ bucket: LogicalBucket; objectKey: string; contentType: string }> {
    if (params.existingRef?.bucket && params.existingRef?.objectKey) {
      const exists = await storageAdapter.exists(params.existingRef.bucket, params.existingRef.objectKey);
      if (exists) {
        return {
          bucket: params.existingRef.bucket,
          objectKey: params.existingRef.objectKey,
          contentType: 'image/jpeg',
        };
      }
    }

    if (params.imageUrl) {
      const decoded = decodeDataUrl(params.imageUrl);
      if (decoded) {
        await storageAdapter.upload(params.bucket, params.objectKeyHint, decoded.buffer, decoded.contentType);
        return { bucket: params.bucket, objectKey: params.objectKeyHint, contentType: decoded.contentType };
      }

      const fetched = await fetchRemoteImageSafely(params.imageUrl);
      if (fetched) {
        await storageAdapter.upload(params.bucket, params.objectKeyHint, fetched.buffer, fetched.contentType);
        return { bucket: params.bucket, objectKey: params.objectKeyHint, contentType: fetched.contentType };
      }
    }

    throw new Error(`Could not resolve or ingest source image for '${params.bucket}/${params.objectKeyHint}'.`);
  }

  public async submitAsyncJob(input: {
    productId: string;
    userId?: string;
    callerTenantId?: string;
    isSuperAdmin?: boolean;
    personUpload?: { bucket: LogicalBucket; objectKey: string };
    personImageUrl?: string;
    garmentImageUrl?: string;
    category?: string;
    quality?: 'fast_preview' | 'standard' | 'high_fidelity';
    modelKey?: string;
    prompt?: string;
    idempotencyKey?: string;
    correlationId: string;
  }) {
    const product = db.getProducts().find((p) => p.id === input.productId);
    if (!product) {
      return { ok: false as const, status: 404, error: 'NotFound', message: 'Product not found.' };
    }

    const tenant = db.getTenantById(product.tenantId);
    if (!tenant || tenant.status !== 'ACTIVE') {
      return { ok: false as const, status: 403, error: 'TenantSuspended', message: 'Brand tenant is inactive or suspended.' };
    }

    const isTenantAuthorized = input.isSuperAdmin || input.callerTenantId === product.tenantId;
    if (!product.isTryOnEligible) {
      return { ok: false as const, status: 400, error: 'NotTryOnEligible', message: 'Product is not configured for virtual try-on.' };
    }
    if (!product.marketplacePublished && !isTenantAuthorized) {
      return { ok: false as const, status: 403, error: 'Forbidden', message: 'Product is not published for public marketplace try-on.' };
    }

    const reserve = db.reserveGeneration({
      tenantId: product.tenantId,
      productId: product.id,
      category: (input.category || product.tryOnCategory || 'tops').toLowerCase(),
      idempotencyKey: input.idempotencyKey,
    });

    if (!reserve.ok) {
      const status = reserve.error === 'QUOTA_EXHAUSTED' ? 402 : 403;
      return {
        ok: false as const,
        status,
        error: reserve.error,
        message: 'Insufficient try-on quota or inactive tenant subscription.',
      };
    }

    if (reserve.duplicate) {
      const existingView = await this.getJobView(reserve.job.id);
      return {
        ok: true as const,
        duplicate: true,
        job: existingView,
      };
    }

    const creditHold = await billingCreditService.reserveCredits({
      tenantId: product.tenantId,
      units: 1,
      generationId: reserve.job.id,
      actor: input.userId || 'anon_shopper',
      idempotencyKey: `reserve:${reserve.job.id}`,
    });
    if (!creditHold.ok) {
      db.finalizeGeneration(reserve.job.id, 'FAILED', 'INSUFFICIENT_CREDITS');
      return {
        ok: false as const,
        status: 402,
        error: 'INSUFFICIENT_CREDITS',
        message: 'Tenant has insufficient AI try-on credits remaining.',
      };
    }

    const jobId = reserve.job.id;
    let personRef: { bucket: LogicalBucket; objectKey: string; contentType: string };
    let garmentRef: { bucket: LogicalBucket; objectKey: string; contentType: string };

    try {
      personRef = await this.ingestImageIntoBucket({
        bucket: 'customer-uploads',
        objectKeyHint: `${(input.userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_')}/${jobId}/person.jpg`,
        existingRef: input.personUpload,
        imageUrl: input.personImageUrl,
      });

      const garmentUrl = input.garmentImageUrl || product.images?.[0];
      garmentRef = await this.ingestImageIntoBucket({
        bucket: 'brand-assets',
        objectKeyHint: `${product.tenantId}/${product.id}/${jobId}_garment.jpg`,
        imageUrl: garmentUrl,
      });
    } catch (err: any) {
      db.finalizeGeneration(jobId, 'FAILED', 'INVALID_SOURCE_IMAGE');
      await billingCreditService.settleCredits({
        tenantId: product.tenantId,
        generationId: jobId,
        outcome: 'RELEASE',
      });
      return {
        ok: false as const,
        status: 400,
        error: 'ValidationError',
        message: err?.message || 'Valid personImage and garmentImage are required.',
      };
    }

    const modelKey = input.modelKey || 'default-tryon';
    const modelVersion = 'v1';
    const quality = input.quality || 'standard';
    const now = Date.now();

    const meta: AsyncJobMeta = {
      jobId,
      tenantId: product.tenantId,
      userId: input.userId,
      status: 'QUEUED',
      personBucket: personRef.bucket,
      personObjectKey: personRef.objectKey,
      garmentBucket: garmentRef.bucket,
      garmentObjectKey: garmentRef.objectKey,
      modelKey,
      modelVersion,
      quality,
      correlationId: input.correlationId,
      createdAt: now,
      updatedAt: now,
    };
    asyncJobMeta.set(jobId, meta);

    const requestedEvent = TryOnGenerationRequestedV1Schema.parse({
      eventId: crypto.randomUUID(),
      eventType: 'tryon.generation.requested',
      eventVersion: 1,
      occurredAt: new Date(now).toISOString(),
      correlationId: input.correlationId,
      generationId: jobId,
      tenantId: product.tenantId,
      userId: input.userId || 'anon_shopper',
      personImage: {
        bucket: personRef.bucket,
        objectKey: personRef.objectKey,
        contentType: personRef.contentType,
      },
      garmentImage: {
        bucket: garmentRef.bucket,
        objectKey: garmentRef.objectKey,
        contentType: garmentRef.contentType,
      },
      modelConfig: { modelKey, modelVersion },
      options: {
        category: reserve.job.category,
        quality,
        prompt: input.prompt,
      },
    });

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.generationJob.updateMany({
            where: { id: jobId },
            data: {
              userId: input.userId ?? null,
              modelKey,
              modelVersion,
              personBucket: personRef.bucket,
              personObjectKey: personRef.objectKey,
              garmentBucket: garmentRef.bucket,
              garmentObjectKey: garmentRef.objectKey,
              correlationId: input.correlationId,
            },
          });
          await enqueueOutboxEvent(tx, {
            eventType: requestedEvent.eventType,
            aggregateId: jobId,
            correlationId: input.correlationId,
            payload: requestedEvent as unknown as Record<string, unknown>,
          });
        });
      } catch (err: any) {
        logger.warn({ err: err?.message, jobId }, 'tryon.outbox_persist_warning');
      }
    }

    this.emitStatus(jobId, {
      jobId,
      status: 'QUEUED',
      correlationId: input.correlationId,
      modelKey,
    });

    // Dispatch via RabbitMQ when active, or fallback async HTTP pipeline to Python AI Service
    if (rabbitMqBus.isConnected()) {
      void rabbitMqBus.publish('tryon.generation.requested', requestedEvent as unknown as Record<string, unknown>, input.correlationId);
    } else {
      setImmediate(() => {
        void this.dispatchToAiServiceHttp(requestedEvent);
      });
    }

    return {
      ok: true as const,
      duplicate: false,
      accessToken: reserve.accessToken,
      job: await this.getJobView(jobId),
    };
  }

  private emitStatus(jobId: string, payload: Record<string, unknown>): void {
    tryonEventsBus.emitJobUpdate(jobId, payload);
    void redisAdapter.set(`tryon:status:${jobId}`, JSON.stringify(payload), 300);
  }

  public async dispatchToAiServiceHttp(event: TryOnGenerationRequestedV1): Promise<void> {
    const meta = asyncJobMeta.get(event.generationId);
    if (!meta || meta.status === 'CANCELLED') return;

    meta.status = 'PROCESSING';
    meta.updatedAt = Date.now();
    db.attachProviderJob(event.generationId, event.generationId);
    this.emitStatus(event.generationId, {
      jobId: event.generationId,
      status: 'PROCESSING',
      correlationId: event.correlationId,
    });

    try {
      let rawOutcome: any;
      if (customAiDispatcher) {
        rawOutcome = await customAiDispatcher(event);
      } else {
        const env = getValidatedEnv();
        const endpoint = `${env.AI_SERVICE_URL.replace(/\/$/, '')}/internal/v1/try-on/execute`;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': event.correlationId,
          },
          body: JSON.stringify(event),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`AI Service returned HTTP ${res.status}: ${text}`);
        }
        rawOutcome = await res.json();
      }

      if (rawOutcome?.eventType === 'tryon.generation.completed') {
        const parsed = TryOnGenerationCompletedV1Schema.parse(rawOutcome);
        await this.settleOutcome(parsed);
      } else if (rawOutcome?.eventType === 'tryon.generation.failed') {
        const parsed = TryOnGenerationFailedV1Schema.parse(rawOutcome);
        await this.settleOutcome(parsed);
      } else {
        throw new Error('Malformed outcome payload from AI Service.');
      }
    } catch (err: any) {
      await this.settleOutcome({
        eventId: crypto.randomUUID(),
        eventType: 'tryon.generation.failed',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        correlationId: event.correlationId,
        generationId: event.generationId,
        error: {
          code: 'AI_DISPATCH_FAILED',
          message: err?.message || 'AI pipeline execution failed.',
          retryable: true,
        },
        metrics: { totalTimeMs: 0 },
      });
    }
  }

  public async settleOutcome(event: TryOnGenerationCompletedV1 | TryOnGenerationFailedV1): Promise<void> {
    const meta = asyncJobMeta.get(event.generationId);
    if (meta && (meta.status === 'COMPLETED' || meta.status === 'FAILED' || meta.status === 'CANCELLED')) {
      return; // Idempotent guard
    }

    const now = Date.now();
    const prisma = getGlobalPrisma();

    if (event.eventType === 'tryon.generation.completed') {
      db.finalizeGeneration(event.generationId, 'COMPLETED');
      if (meta) {
        await billingCreditService.settleCredits({
          tenantId: meta.tenantId,
          generationId: event.generationId,
          outcome: 'CONSUME',
          providerId: 'local',
          modelKey: event.model.key,
        });
      }
      if (meta) {
        meta.status = 'COMPLETED';
        meta.resultBucket = event.result.bucket as LogicalBucket;
        meta.resultObjectKey = event.result.objectKey;
        meta.modelKey = event.model.key;
        meta.modelVersion = event.model.version;
        meta.latencyMs = Math.round(event.metrics.totalTimeMs);
        meta.updatedAt = now;
      }

      if (prisma) {
        try {
          await prisma.generationJob.updateMany({
            where: { id: event.generationId },
            data: {
              status: 'COMPLETED',
              resultBucket: event.result.bucket,
              resultObjectKey: event.result.objectKey,
              latencyMs: Math.round(event.metrics.totalTimeMs),
              modelKey: event.model.key,
              modelVersion: event.model.version,
              updatedAt: BigInt(now),
            },
          });
        } catch (err: any) {
          logger.warn({ err: err?.message }, 'tryon.settle_completed_prisma_warning');
        }
      }

      const signed = await storageAdapter.createSignedDownloadUrl(
        event.result.bucket as LogicalBucket,
        event.result.objectKey,
        300
      );

      this.emitStatus(event.generationId, {
        jobId: event.generationId,
        status: 'COMPLETED',
        resultUrl: signed.url,
        expiresAt: signed.expiresAt,
        latencyMs: Math.round(event.metrics.totalTimeMs),
        modelKey: event.model.key,
        modelVersion: event.model.version,
      });
    } else {
      db.finalizeGeneration(event.generationId, 'FAILED', event.error.code);
      if (meta) {
        await billingCreditService.settleCredits({
          tenantId: meta.tenantId,
          generationId: event.generationId,
          outcome: 'RELEASE',
        });
      }
      if (meta) {
        meta.status = 'FAILED';
        meta.errorCode = event.error.code;
        meta.errorMessage = event.error.message;
        meta.latencyMs = Math.round(event.metrics.totalTimeMs);
        meta.updatedAt = now;
      }

      if (prisma) {
        try {
          await prisma.generationJob.updateMany({
            where: { id: event.generationId },
            data: {
              status: 'FAILED',
              errorCode: event.error.code,
              errorMessage: event.error.message,
              latencyMs: Math.round(event.metrics.totalTimeMs),
              updatedAt: BigInt(now),
            },
          });
        } catch (err: any) {
          logger.warn({ err: err?.message }, 'tryon.settle_failed_prisma_warning');
        }
      }

      this.emitStatus(event.generationId, {
        jobId: event.generationId,
        status: 'FAILED',
        errorCode: event.error.code,
        errorMessage: event.error.message,
      });
    }
  }

  public authorizeJobAccess(
    jobId: string,
    opts: { accessToken?: string; userId?: string; tenantId?: string; isSuperAdmin?: boolean }
  ): GenerationJob | null {
    const job = db.getAllGenerations().find((j) => j.id === jobId || j.providerJobId === jobId);
    if (!job) return null;

    if (opts.isSuperAdmin) return job;
    if (opts.tenantId && job.tenantId === opts.tenantId) return job;

    const meta = asyncJobMeta.get(job.id);
    if (opts.userId && meta?.userId && meta.userId === opts.userId) return job;

    if (opts.accessToken) {
      const viaToken = db.getGenerationForSession(job.id, opts.accessToken);
      if (viaToken) return viaToken;
    }

    return null;
  }

  public async getJobView(jobId: string) {
    const job = db.getAllGenerations().find((j) => j.id === jobId);
    const meta = asyncJobMeta.get(jobId);
    if (!job && !meta) return null;

    const status = meta?.status || (job?.status as ExtendedJobStatus) || 'QUEUED';
    let resultUrl: string | undefined;
    let resultExpiresAt: string | undefined;
    if (status === 'COMPLETED' && meta?.resultBucket && meta?.resultObjectKey) {
      const signed = await storageAdapter.createSignedDownloadUrl(meta.resultBucket, meta.resultObjectKey, 300);
      resultUrl = signed.url;
      resultExpiresAt = signed.expiresAt;
    }

    return {
      jobId,
      tenantId: job?.tenantId || meta?.tenantId,
      productId: job?.productId,
      category: job?.category,
      status,
      modelKey: meta?.modelKey || 'default-tryon',
      modelVersion: meta?.modelVersion || 'v1',
      quality: meta?.quality || 'standard',
      resultUrl,
      resultExpiresAt,
      errorCode: meta?.errorCode || job?.errorCode,
      errorMessage: meta?.errorMessage,
      latencyMs: meta?.latencyMs,
      correlationId: meta?.correlationId,
      createdAt: job?.createdAt || meta?.createdAt,
      updatedAt: job?.updatedAt || meta?.updatedAt,
    };
  }

  public async cancelJob(jobId: string): Promise<{ ok: true; job: any } | { ok: false; status: number; error: string; message: string }> {
    const meta = asyncJobMeta.get(jobId);
    const job = db.getAllGenerations().find((j) => j.id === jobId);
    if (!job && !meta) {
      return { ok: false, status: 404, error: 'NotFound', message: 'Try-on job not found.' };
    }

    const currentStatus = meta?.status || job?.status;
    if (currentStatus !== 'QUEUED') {
      return {
        ok: false,
        status: 409,
        error: 'InvalidStateTransition',
        message: `Cannot cancel job in state '${currentStatus}'. Only QUEUED jobs can be cancelled.`,
      };
    }

    db.finalizeGeneration(jobId, 'FAILED', 'CANCELLED_BY_USER');
    const tenantForRelease = meta?.tenantId || job?.tenantId;
    if (tenantForRelease) {
      await billingCreditService.settleCredits({
        tenantId: tenantForRelease,
        generationId: jobId,
        outcome: 'RELEASE',
      });
    }
    if (meta) {
      meta.status = 'CANCELLED';
      meta.errorCode = 'CANCELLED_BY_USER';
      meta.updatedAt = Date.now();
    }
    this.emitStatus(jobId, { jobId, status: 'CANCELLED' });

    return { ok: true, job: await this.getJobView(jobId) };
  }

  public async listHistory(opts: { userId?: string; tenantId?: string; isSuperAdmin?: boolean; limit?: number }) {
    const jobs = db.getAllGenerations().filter((j) => {
      if (opts.isSuperAdmin) return true;
      if (opts.tenantId) return j.tenantId === opts.tenantId;
      if (opts.userId) return asyncJobMeta.get(j.id)?.userId === opts.userId;
      return false;
    });

    const slice = jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, opts.limit ?? 30);
    return Promise.all(slice.map((j) => this.getJobView(j.id)));
  }
}

export const tryonOrchestrator = new TryOnOrchestrator();
