import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { config } from '../../infrastructure/config.js';

export async function brandUploadRoutes(app: FastifyInstance) {
  // Check Cloudinary storage integration status
  app.get('/api/v1/uploads/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const isCloud = cloudinaryStorage.isConfigured();
    return reply.send({
      provider: isCloud ? 'cloudinary' : 'local_fallback',
      cloudinaryConfigured: isCloud,
      cloudName: isCloud ? config.cloudinaryCloudName : undefined,
      folder: config.cloudinaryFolder,
      status: 'ready'
    });
  });

  // Upload an image (supports multipart file or JSON base64 payload)
  app.post('/api/v1/uploads', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const isMultipart = typeof request.isMultipart === 'function' ? request.isMultipart() : false;
    const tenantId = request.tenant?.id || 'public';

    if (isMultipart) {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'ValidationError', message: 'No file found in multipart upload.' });
      }

      const buffer = await data.toBuffer();
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.status(400).send({ error: 'PayloadTooLarge', message: 'File exceeds 10MB limit.' });
      }

      const publicId = `brand_${tenantId}_${Date.now()}`;
      const cloudinaryUrl = await cloudinaryStorage.uploadBuffer(buffer, {
        publicId,
        folder: `${config.cloudinaryFolder}/${tenantId}`,
        tags: ['vton', tenantId, data.filename]
      });

      if (cloudinaryUrl) {
        return reply.status(201).send({
          success: true,
          provider: 'cloudinary',
          url: cloudinaryUrl,
          filename: data.filename
        });
      }

      // Local fallback if Cloudinary is not configured in .env
      const base64Data = `data:${data.mimetype};base64,${buffer.toString('base64')}`;
      return reply.status(201).send({
        success: true,
        provider: 'local_memory_fallback',
        url: base64Data,
        filename: data.filename,
        note: 'Cloudinary credentials not set in .env; set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME to store in cloud.'
      });
    }

    // JSON base64 payload option
    const body = request.body as any;
    const { imageBase64, filename, folder } = body || {};

    if (!imageBase64) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Multipart image file or imageBase64 string required.'
      });
    }

    const publicId = `brand_${tenantId}_${Date.now()}`;
    const cloudinaryUrl = await cloudinaryStorage.uploadBase64(imageBase64, {
      publicId,
      folder: folder || `${config.cloudinaryFolder}/${tenantId}`,
      tags: ['vton', tenantId]
    });

    if (cloudinaryUrl) {
      return reply.status(201).send({
        success: true,
        provider: 'cloudinary',
        url: cloudinaryUrl,
        filename: filename || 'image.jpg'
      });
    }

    return reply.status(201).send({
      success: true,
      provider: 'local_memory_fallback',
      url: imageBase64,
      filename: filename || 'image.jpg',
      note: 'Cloudinary credentials not set in .env; returned data URI.'
    });
  });
}
