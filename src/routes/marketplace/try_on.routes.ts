import { resolveTryOnSettings } from '../../modules/tryon/tryon_settings.js';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { TryOnEngineError, geminiTryOnEngine } from '../../modules/tryon/gemini.engine.js';
import { parseShopperFit } from '../../modules/tryon/shopper_fit.js';
import { getDirectResult, httpStatusFor, refreshResultUrl, rememberDirectResult, runDirectTryOn } from '../../modules/tryon/direct_tryon.js';

/**
 * Brands can upload a clear, flat "AI reference image" per product (the `aiReferenceImage` field). When the client sends the product's normal display photo (or none),
 * the AI model gets the reference image instead, so it can understand the real garment.
 */
export function resolveGarmentImage(productId: unknown, requested: unknown): string {
  const requestedUrl = typeof requested === 'string' ? requested : '';
  if (typeof productId !== 'string' || !productId) return requestedUrl;
  try {
    const product = db.getProductById(productId);
    // The shopper picked a colour: the colour's own AI photo wins over the product-wide one.
    const colourAi = requestedUrl
      ? (product?.variants || []).find((v) => v.imageUrl === requestedUrl && v.aiImageUrl)?.aiImageUrl
      : undefined;
    if (colourAi) return colourAi;
    // Dedicated field first; older products saved it under the reserved specs key.
    const reference =
      product?.aiReferenceImage || (product?.specs as Record<string, string> | undefined)?._aiReferenceImage;
    if (reference && (!requestedUrl || (product?.images || []).includes(requestedUrl))) {
      return reference;
    }
  } catch {
    // fall back to the image the client sent
  }
  return requestedUrl;
}

const SAFE_JOB_ID_REGEX = /^[a-zA-Z0-9_-]{3,80}$/;

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

  if (!resolveTryOnSettings(tenant).enabled) {
    reply.status(403).send({ error: 'TryOnDisabled', message: 'This shop has turned virtual try-on off.' });
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


export async function marketplaceTryOnRoutes(app: FastifyInstance) {
  // Which engine makes the try-on pictures, and whether it is ready.
  app.get('/api/v1/try-on/provider', async () => {
    const engine = geminiTryOnEngine.status();
    return {
      mode: 'gemini',
      provider: 'gemini',
      model: engine.imageModel,
      configured: engine.configured,
      status: engine.configured ? 'ready' : 'key_required',
    };
  });

  /**
   * Create a try-on picture now. The backend calls Gemini itself and answers with the finished picture,
   * so there is nothing to wait for or poll. /submit and /direct do the same job; /submit is kept for older clients.
   */
  const createTryOn = async (request: FastifyRequest, reply: FastifyReply, successCode: number) => {
    const { personImage, garmentImage: requestedGarmentImage, category, productId, prompt, gender, size, garmentSize } = (request.body as any) || {};
    // Prefer the brand's clear AI reference image over the styled display photo.
    const garmentImage = resolveGarmentImage(productId, requestedGarmentImage);

    if (!personImage || !garmentImage) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Both personImage and garmentImage are required.' });
    }

    const reservation = reserveForRequest(request, reply, productId, category);
    if (!reservation) return;
    const { job, accessToken } = reservation;

    if (reservation.duplicate) {
      const known = getDirectResult(job.id);
      return reply.status(200).send({
        jobId: job.id,
        generationId: job.id,
        status: job.status,
        duplicate: true,
        ...(known?.result ? { resultUrl: await refreshResultUrl(known.result) } : {}),
      });
    }

    db.attachProviderJob(job.id, job.id);
    try {
      const { generated, hosted } = await runDirectTryOn({
        jobId: job.id,
        tenantId: job.tenantId,
        personImage,
        garmentImage,
        category: job.category,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 500) : undefined,
        shopper: parseShopperFit({ gender, size, garmentSize }),
      });
      db.finalizeGeneration(job.id, 'COMPLETED');
      rememberDirectResult(job.id, { status: 'COMPLETED', result: hosted });
      return reply.status(successCode).send({
        jobId: job.id,
        generationId: job.id,
        accessToken,
        status: 'COMPLETED',
        provider: 'gemini',
        model: generated.imageModel,
        resultUrl: hosted.url,
        output_url: hosted.url,
        result: { output_url: hosted.url, width: generated.width, height: generated.height },
        storageProvider: hosted.storage,
        latencyMs: generated.timings.totalMs,
      });
    } catch (err: unknown) {
      const engineError =
        err instanceof TryOnEngineError ? err : new TryOnEngineError('UPSTREAM_ERROR', 'The try-on could not be created. Please try again.', true);
      // The failed try-on does not use up the shop's allowance.
      db.finalizeGeneration(job.id, 'FAILED', engineError.code);
      rememberDirectResult(job.id, { status: 'FAILED', error: { code: engineError.code, message: engineError.message } });
      return reply.status(httpStatusFor(engineError)).send({
        error: engineError.code,
        message: engineError.message,
        retryable: engineError.retryable,
      });
    }
  };

  app.post('/api/v1/try-on/submit', async (request: FastifyRequest, reply: FastifyReply) => createTryOn(request, reply, 201));
  app.post('/api/v1/try-on/direct', async (request: FastifyRequest, reply: FastifyReply) => createTryOn(request, reply, 200));

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

    const known = getDirectResult(job.id);
    if (known?.status === 'COMPLETED' && known.result) {
      return { jobId: job.id, status: 'COMPLETED', resultUrl: await refreshResultUrl(known.result), provider: 'gemini' };
    }
    if (known?.status === 'FAILED') {
      return { jobId: job.id, status: 'FAILED', error: known.error?.message, provider: 'gemini' };
    }
    return { jobId: job.id, status: job.status, provider: 'gemini' };
  });
}
