import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { externalVtonService } from '../../infrastructure/vton_api.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';

// Cache for try-on results uploaded to Cloudinary
const cloudinaryTryOnCache = new Map<string, string>();
const SAFE_JOB_ID_REGEX = /^[a-zA-Z0-9_-]{3,80}$/;

function isSafeRemoteImageUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith('/')) return true;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    const aiOrigin = new URL(config.aiServiceUrl).origin;
    if (parsed.origin === aiOrigin) return true;

    // Require HTTPS for external remote URLs and block loopback/metadata/private IPv4 ranges
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}


const TOKEN_HEADER = 'x-try-on-token';

/**
 * Resolves the shop (tenant) for a try-on request on the SERVER from the product.
 * Any tenantId sent by the browser is ignored, then atomically reserves quota.
 * Returns null after sending an error reply.
 */
function reserveForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  productId: unknown,
  category: unknown
) {
  if (typeof productId !== 'string' || !productId.trim()) {
    reply.status(400).send({ error: 'ValidationError', message: 'productId is required.' });
    return null;
  }
  const product = db.getProductById(productId);
  if (!product || !product.marketplacePublished) {
    reply.status(404).send({ error: 'ProductNotFound', message: 'Product not found.' });
    return null;
  }
  if (!product.isTryOnEligible) {
    reply.status(403).send({ error: 'TryOnNotEnabled', message: 'Virtual try-on is not enabled for this product.' });
    return null;
  }
  const tenant = db.getTenantById(product.tenantId);
  if (!tenant || tenant.status !== 'ACTIVE') {
    reply.status(403).send({ error: 'ShopUnavailable', message: 'This shop is not currently available.' });
    return null;
  }

  const rawKey = request.headers['idempotency-key'];
  const idempotencyKey = typeof rawKey === 'string' && rawKey.length > 0 && rawKey.length <= 128 ? rawKey : undefined;

  const result = db.reserveGeneration({
    tenantId: product.tenantId,
    productId: product.id,
    category: typeof category === 'string' && category ? category : product.tryOnCategory || 'tops',
    idempotencyKey
  });

  if (!result.ok) {
    if (result.error === 'QUOTA_EXHAUSTED') {
      reply.status(429).send({
        error: 'QuotaExhausted',
        message: 'This shop has used its try-on allowance for the current billing period.'
      });
    } else {
      reply.status(403).send({ error: 'ShopUnavailable', message: 'Try-on is not available for this shop.' });
    }
    return null;
  }
  return result;
}

function isTerminalComplete(status: unknown): boolean {
  return String(status || '').toLowerCase() === 'completed';
}
function isTerminalFailed(status: unknown): boolean {
  return ['failed', 'error', 'cancelled'].includes(String(status || '').toLowerCase());
}

export async function marketplaceTryOnRoutes(app: FastifyInstance) {
  // Query Active VTON Engine / API Provider Status
  app.get('/api/v1/try-on/provider', async () => {
    const isExternal = externalVtonService.isConfigured();
    const provider = externalVtonService.detectProvider();
    return {
      mode: isExternal ? 'external_api' : 'local_ai_service',
      provider,
      externalConfigured: isExternal,
      engineUrl: isExternal ? `Cloud API (${provider})` : config.aiServiceUrl,
      status: 'ready'
    };
  });

  // Dispatch Virtual Try-On Job (External API or Local AI Engine)
  app.post('/api/v1/try-on/submit', async (request: FastifyRequest, reply: FastifyReply) => {
    const { personImage, garmentImage, category, productId, prompt, model_name, modelName } = (request.body as any) || {};

    if (!personImage || !garmentImage) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Both personImage and garmentImage are required.'
      });
    }

    const reservation = reserveForRequest(request, reply, productId, category);
    if (!reservation) return;
    const { job, accessToken } = reservation;

    if (reservation.duplicate) {
      return reply.status(200).send({
        jobId: job.providerJobId || job.id,
        generationId: job.id,
        status: job.status,
        duplicate: true
      });
    }

    const respond = (code: number, payload: Record<string, any>) => {
      const providerJobId = payload.jobId || payload.job_id;
      if (providerJobId) db.attachProviderJob(job.id, providerJobId);
      if (isTerminalComplete(payload.status)) db.finalizeGeneration(job.id, 'COMPLETED');
      return reply.status(code).send({
        ...payload,
        jobId: providerJobId || job.id,
        generationId: job.id,
        accessToken
      });
    };

    // 1. If user configured external VTON API in .env, dispatch to external provider
    if (externalVtonService.isConfigured()) {
      try {
        const result = await externalVtonService.submitTryOn({
          personImage,
          garmentImage,
          category: job.category,
          prompt
        });

        // If result returned synchronously and Cloudinary is configured, upload to Cloudinary
        if (result.resultUrl && cloudinaryStorage.isConfigured() && !result.resultUrl.includes('cloudinary.com')) {
          const cloudUrl = await uploadTryOnResultToCloudinary(result.jobId, result.resultUrl);
          if (cloudUrl) {
            result.resultUrl = cloudUrl;
          }
        }

        return respond(201, { ...result, provider: externalVtonService.detectProvider() });
      } catch (extErr: any) {
        console.warn('[VTON] External API dispatch failed, falling back to AI Service:', extErr.message);
        // Fall through to local AI service if external API failed
      }
    }

    // 2. Local AI Service Engine
    try {
      const response = await fetch(`${config.aiServiceUrl}/api/v1/try-on/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personImage,
          garmentImage,
          category: job.category,
          prompt,
          model_name: model_name || modelName
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        db.finalizeGeneration(job.id, 'FAILED', 'AI_SERVICE_ERROR');
        return reply.status(response.status).send({
          error: 'AiServiceError',
          message: `AI service error: ${errorText}`
        });
      }

      const data = await response.json();
      return respond(201, data);
    } catch (err: any) {
      // Release the reserved unit; never fabricate a job for an unavailable provider.
      db.finalizeGeneration(job.id, 'FAILED', 'AI_SERVICE_UNAVAILABLE');
      return reply.status(503).send({
        error: 'AiServiceUnavailable',
        message: 'The try-on service is temporarily unavailable. Your allowance was not used. Please try again shortly.'
      });
    }
  });

  // Direct Synchronous Try-On with Automatic Cloudinary Persistence
  app.post('/api/v1/try-on/direct', async (request: FastifyRequest, reply: FastifyReply) => {
    const { personImage, garmentImage, category, productId, prompt, model_name, modelName } = (request.body as any) || {};

    if (!personImage || !garmentImage) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Both personImage and garmentImage are required.'
      });
    }

    const reservation = reserveForRequest(request, reply, productId, category);
    if (!reservation) return;
    const { job, accessToken } = reservation;

    if (reservation.duplicate) {
      return reply.status(200).send({
        jobId: job.providerJobId || job.id,
        generationId: job.id,
        status: job.status,
        duplicate: true
      });
    }

    try {
      const response = await fetch(`${config.aiServiceUrl}/api/v1/try-on`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personImage,
          garmentImage,
          category: job.category,
          prompt,
          model_name: model_name || modelName
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        db.finalizeGeneration(job.id, 'FAILED', 'AI_SERVICE_ERROR');
        return reply.status(response.status).send({ error: 'AiServiceError', message: errText });
      }

      const data: any = await response.json();
      const jobId = data.job_id || data.jobId || `direct_${Date.now()}`;
      const rawResultUrl = data.resultUrl || data.output_url || data.result?.output_url;
      db.attachProviderJob(job.id, jobId);

      if (rawResultUrl) {
        const cloudUrl = await uploadTryOnResultToCloudinary(jobId, rawResultUrl);
        if (cloudUrl) {
          data.resultUrl = cloudUrl;
          data.output_url = cloudUrl;
          if (data.result) data.result.output_url = cloudUrl;
          data.storageProvider = 'cloudinary';
        }
        db.finalizeGeneration(job.id, 'COMPLETED');
      } else if (isTerminalFailed(data.status)) {
        db.finalizeGeneration(job.id, 'FAILED', 'PROVIDER_FAILED');
      }

      return reply.status(200).send({ ...data, generationId: job.id, accessToken });
    } catch (err: any) {
      db.finalizeGeneration(job.id, 'FAILED', 'EXECUTION_ERROR');
      return reply.status(500).send({
        error: 'TryOnExecutionFailed',
        message: `Direct try-on execution error: ${err.message}`
      });
    }
  });

  // Public Marketplace Image Upload (e.g., customer person photo / garment upload to Cloudinary)
  app.post('/api/v1/try-on/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const isMultipart = typeof request.isMultipart === 'function' ? request.isMultipart() : false;

    if (isMultipart) {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'ValidationError', message: 'No file found in multipart upload.' });
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.status(400).send({ error: 'PayloadTooLarge', message: 'File exceeds 10MB limit.' });
      }

      const publicId = `tryon_upload_${Date.now()}`;
      const cloudinaryUrl = await cloudinaryStorage.uploadBuffer(buffer, {
        publicId,
        folder: `${config.cloudinaryFolder}/uploads`,
        tags: ['marketplace', 'customer-photo', data.filename]
      });

      if (cloudinaryUrl) {
        return reply.status(201).send({
          success: true,
          provider: 'cloudinary',
          url: cloudinaryUrl,
          filename: data.filename
        });
      }

      const base64Data = `data:${data.mimetype};base64,${buffer.toString('base64')}`;
      return reply.status(201).send({
        success: true,
        provider: 'local_memory_fallback',
        url: base64Data,
        filename: data.filename
      });
    }

    const body = (request.body as any) || {};
    const { imageBase64, filename } = body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Multipart image file or imageBase64 string required.'
      });
    }

    if (imageBase64.length > 14 * 1024 * 1024) {
      return reply.status(413).send({
        error: 'PayloadTooLarge',
        message: 'Base64 image exceeds 10MB limit.'
      });
    }

    const publicId = `tryon_upload_${Date.now()}`;
    const cloudinaryUrl = await cloudinaryStorage.uploadBase64(imageBase64, {
      publicId,
      folder: `${config.cloudinaryFolder}/uploads`,
      tags: ['marketplace', 'customer-photo']
    });

    if (cloudinaryUrl) {
      return reply.status(201).send({
        success: true,
        provider: 'cloudinary',
        url: cloudinaryUrl,
        filename: filename || 'customer_photo.jpg'
      });
    }

    return reply.status(201).send({
      success: true,
      provider: 'local_memory_fallback',
      url: imageBase64,
      filename: filename || 'customer_photo.jpg'
    });
  });

  // Check Job Status (only the session that created the job, holding its access token, may read it)
  app.get('/api/v1/try-on/status/:jobId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = request.params as { jobId: string };
    if (!jobId || !SAFE_JOB_ID_REGEX.test(jobId)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Invalid try-on jobId format.'
      });
    }

    const rawToken = request.headers[TOKEN_HEADER] ?? (request.query as any)?.token;
    const token = typeof rawToken === 'string' ? rawToken : undefined;
    const job = db.getGenerationForSession(jobId, token);
    if (!job) {
      // Same response for "unknown" and "not yours" so IDs cannot be probed.
      return reply.status(404).send({ error: 'NotFound', message: 'Try-on job not found.' });
    }

    const settle = (status: unknown) => {
      if (isTerminalComplete(status)) db.finalizeGeneration(job.id, 'COMPLETED');
      else if (isTerminalFailed(status)) db.finalizeGeneration(job.id, 'FAILED', 'PROVIDER_FAILED');
    };

    // Check external VTON service cache first
    const externalStatus = await externalVtonService.getStatus(jobId);
    if (externalStatus) {
      settle(externalStatus.status);
      return {
        jobId: externalStatus.jobId,
        status: externalStatus.status,
        resultUrl: externalStatus.resultUrl,
        provider: externalStatus.provider
      };
    }

    // Check local AI service
    try {
      const response = await fetch(`${config.aiServiceUrl}/api/v1/try-on/jobs/${jobId}`);
      if (!response.ok) {
        return reply.status(response.status).send({ error: 'AiServiceError', message: 'Could not fetch job status.' });
      }
      const data: any = await response.json();

      // When AI service completes the generation, backend uploads the result to Cloudinary
      const isCompleted = isTerminalComplete(data.status);
      const rawResultUrl = data.resultUrl || data.output_url || data.result?.output_url;

      if (isCompleted && rawResultUrl) {
        const cloudUrl = await uploadTryOnResultToCloudinary(jobId, rawResultUrl);
        if (cloudUrl) {
          data.resultUrl = cloudUrl;
          data.output_url = cloudUrl;
          if (data.result) data.result.output_url = cloudUrl;
          data.storageProvider = 'cloudinary';
        }
      }

      settle(data.status);
      return data;
    } catch (err) {
      return reply.status(502).send({
        error: 'AiServiceUnavailable',
        message: 'Could not reach the try-on service. Please retry.'
      });
    }
  });
}

// Reusable Cloudinary Result Uploader & Cache Manager
async function uploadTryOnResultToCloudinary(jobId: string, rawResultUrl: string): Promise<string | null> {
  if (cloudinaryTryOnCache.has(jobId)) {
    return cloudinaryTryOnCache.get(jobId)!;
  }

  if (rawResultUrl.includes('cloudinary.com')) {
    cloudinaryTryOnCache.set(jobId, rawResultUrl);
    return rawResultUrl;
  }

  if (!cloudinaryStorage.isConfigured() || !isSafeRemoteImageUrl(rawResultUrl)) {
    return null;
  }

  try {
    const sourceUrl = rawResultUrl.startsWith('http')
      ? rawResultUrl
      : `${config.aiServiceUrl}${rawResultUrl.startsWith('/') ? '' : '/'}${rawResultUrl}`;

    const cloudUrl = await cloudinaryStorage.uploadRemoteUrl(sourceUrl, {
      publicId: `tryon_res_${jobId}`,
      folder: `${config.cloudinaryFolder}/results`,
      tags: ['virtual-try-on', 'generated-result', jobId]
    });

    if (cloudUrl) {
      cloudinaryTryOnCache.set(jobId, cloudUrl);
      return cloudUrl;
    }
  } catch (err: any) {
    console.warn(`[Cloudinary] Failed to upload try-on result ${jobId}:`, err.message);
  }

  return null;
}
