import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LogicalBucket,
  storageAdapter,
  verifyStorageToken,
} from '../infrastructure/storage.adapter.js';

const ALLOWED_BUCKETS = new Set<LogicalBucket>([
  'customer-uploads',
  'brand-assets',
  'garment-processing',
  'generated-results',
  'temporary',
]);

function hasValidImageMagicBytes(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

export async function storageRoutes(app: FastifyInstance) {
  // Signed PUT upload target when local private storage driver is used
  app.addContentTypeParser(/^image\/.*$/, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.put('/api/v1/storage/signed-upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const bucket = q.bucket as LogicalBucket;
    const key = q.key || '';
    const exp = Number(q.exp || 0);
    const sig = q.sig || '';

    if (!ALLOWED_BUCKETS.has(bucket) || !key || !verifyStorageToken(bucket, key, 'write', exp, sig)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Invalid or expired signed upload URL.' });
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Binary image body is required.' });
    }
    if (body.length > 10 * 1024 * 1024) {
      return reply.status(413).send({ error: 'PayloadTooLarge', message: 'Image exceeds 10 MB limit.' });
    }
    if (!hasValidImageMagicBytes(body)) {
      return reply.status(400).send({ error: 'InvalidImage', message: 'Image signature validation failed (only JPEG/PNG/WebP permitted).' });
    }

    const contentType = String(request.headers['content-type'] || 'image/jpeg');
    const meta = await storageAdapter.upload(bucket, key, body, contentType);
    return reply.status(200).send({ ok: true, object: meta });
  });

  app.get('/api/v1/storage/signed-download', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const bucket = q.bucket as LogicalBucket;
    const key = q.key || '';
    const exp = Number(q.exp || 0);
    const sig = q.sig || '';

    if (!ALLOWED_BUCKETS.has(bucket) || !key || !verifyStorageToken(bucket, key, 'read', exp, sig)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Invalid or expired signed download URL.' });
    }

    const meta = await storageAdapter.getMetadata(bucket, key);
    if (!meta) {
      return reply.status(404).send({ error: 'NotFound', message: 'Private object not found.' });
    }

    const buf = await storageAdapter.download(bucket, key);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=60');
    reply.type(meta.contentType || 'application/octet-stream');
    return reply.send(buf);
  });
}

