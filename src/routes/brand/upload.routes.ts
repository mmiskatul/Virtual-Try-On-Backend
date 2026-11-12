import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createBrandMiddleware,
  registerScopedPreHandlers,
} from '../../infrastructure/auth.guard.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { config } from '../../infrastructure/config.js';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UploadJsonInputSchema,
  UploadResponseSchema,
  UploadStatusResponseSchema,
  formatZodValidationError,
  validateZodOutput,
} from './storefront.schemas.js';

const brandUploadReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandUploadWriteGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));

function sanitizeFolderPath(folder: unknown, tenantId: string): string {
  const defaultFolder = `${config.cloudinaryFolder}/${tenantId}`;
  if (typeof folder !== 'string' || !folder.trim()) return defaultFolder;
  const cleaned = folder.trim().replace(/\.\./g, '').replace(/[^a-zA-Z0-9/_-]/g, '');
  if (!cleaned || !cleaned.startsWith(config.cloudinaryFolder)) {
    return defaultFolder;
  }
  return cleaned;
}

export async function brandUploadRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, brandUploadReadGuards);

  // Check Cloudinary storage integration status (secured for authenticated brand users)
  app.get('/api/v1/uploads/status', { preHandler: brandUploadReadGuards }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const isCloud = cloudinaryStorage.isConfigured();
    return reply.send(
      validateZodOutput(
        UploadStatusResponseSchema,
        {
          provider: isCloud ? 'cloudinary' : 'local_fallback',
          cloudinaryConfigured: isCloud,
          cloudName: isCloud ? config.cloudinaryCloudName : undefined,
          folder: config.cloudinaryFolder,
          status: 'ready',
        },
        'GET /api/v1/uploads/status'
      )
    );
  });

  // Upload an image (supports multipart file or JSON base64 payload)
  app.post('/api/v1/uploads', { preHandler: brandUploadWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenant) return reply.status(403).send({ error: 'Forbidden', message: 'Brand tenant context required.' });
    const isMultipart = typeof request.isMultipart === 'function' ? request.isMultipart() : false;
    const tenantId = request.tenant.id;

    if (isMultipart) {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'ValidationError', message: 'No file found in multipart upload.' });
      }

      const normalizedMime = String(data.mimetype || '').trim().toLowerCase();
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(normalizedMime)) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: `Unsupported image type "${normalizedMime || 'unknown'}". Allowed types: PNG, JPG, JPEG, WEBP.`,
          issues: [{ path: 'file.mimetype', message: 'Allowed MIME types: image/png, image/jpeg, image/jpg, image/webp' }],
        });
      }

      const buffer = await data.toBuffer();
      if (buffer.length === 0) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: 'Uploaded image file cannot be empty.',
          issues: [{ path: 'file', message: 'Empty file buffer' }],
        });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return reply.status(400).send({ error: 'PayloadTooLarge', message: 'File exceeds 10MB limit.' });
      }

      const safeFilename = (data.filename || 'upload.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const publicId = `brand_${tenantId}_${Date.now()}`;
      const cloudinaryUrl = await cloudinaryStorage.uploadBuffer(buffer, {
        publicId,
        folder: `${config.cloudinaryFolder}/${tenantId}`,
        tags: ['vton', tenantId, safeFilename]
      });

      if (cloudinaryUrl) {
        return reply.status(201).send(
          validateZodOutput(
            UploadResponseSchema,
            {
              success: true,
              provider: 'cloudinary',
              url: cloudinaryUrl,
              filename: safeFilename,
              mimeType: normalizedMime,
              sizeBytes: buffer.length,
            },
            'POST /api/v1/uploads (multipart/cloudinary)'
          )
        );
      }

      // Local fallback if Cloudinary is not configured in .env
      const base64Data = `data:${normalizedMime};base64,${buffer.toString('base64')}`;
      return reply.status(201).send(
        validateZodOutput(
          UploadResponseSchema,
          {
            success: true,
            provider: 'local_memory_fallback',
            url: base64Data,
            filename: safeFilename,
            mimeType: normalizedMime,
            sizeBytes: buffer.length,
            note: 'Cloudinary credentials not set in .env; set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to store in cloud.',
          },
          'POST /api/v1/uploads (multipart/local)'
        )
      );
    }

    // JSON base64 payload option
    const parsedJson = UploadJsonInputSchema.safeParse(request.body ?? {});
    if (!parsedJson.success) {
      return reply.status(400).send(formatZodValidationError(parsedJson.error));
    }
    const { imageBase64, filename, folder } = parsedJson.data;
    const base64Body = imageBase64.split(',')[1] || '';
    const estimatedBytes = Math.floor((base64Body.replace(/\s+/g, '').length * 3) / 4);
    if (estimatedBytes > MAX_UPLOAD_BYTES) {
      return reply.status(400).send({ error: 'PayloadTooLarge', message: 'Decoded base64 image exceeds 10MB limit.' });
    }
    const mimeMatch = imageBase64.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,/i);
    const detectedMime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg';
    const safeFilename = (filename || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

    const publicId = `brand_${tenantId}_${Date.now()}`;
    const cloudinaryUrl = await cloudinaryStorage.uploadBase64(imageBase64, {
      publicId,
      folder: sanitizeFolderPath(folder, tenantId),
      tags: ['vton', tenantId]
    });

    if (cloudinaryUrl) {
      return reply.status(201).send(
        validateZodOutput(
          UploadResponseSchema,
          {
            success: true,
            provider: 'cloudinary',
            url: cloudinaryUrl,
            filename: safeFilename,
            mimeType: detectedMime,
            sizeBytes: estimatedBytes,
          },
          'POST /api/v1/uploads (json/cloudinary)'
        )
      );
    }

    return reply.status(201).send(
      validateZodOutput(
        UploadResponseSchema,
        {
          success: true,
          provider: 'local_memory_fallback',
          url: imageBase64,
          filename: safeFilename,
          mimeType: detectedMime,
          sizeBytes: estimatedBytes,
          note: 'Cloudinary credentials not set in .env; returned data URI.',
        },
        'POST /api/v1/uploads (json/local)'
      )
    );
  });
}
