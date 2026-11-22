import './setup_env.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { config } from '../src/infrastructure/config.js';
import { cloudinaryStorage } from '../src/infrastructure/cloudinary_storage.js';
import { storageAdapter } from '../src/infrastructure/storage.adapter.js';
import {
  GeminiTryOnEngine,
  MAX_IMAGE_BYTES,
  TryOnEngineError,
  sniffImage,
  validateImage,
} from '../src/modules/tryon/gemini.engine.js';
import { runTryOnPipeline } from '../src/modules/tryon/tryon.pipeline.js';
import { seedTestUsers } from './helpers.js';

// A tiny PNG header with a real size (2 x 3) and some filler: enough for the engine to recognise it as a PNG.
function png(width = 2, height = 3, fill = 0x11): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(40, fill)]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x00, 0xc8]), Buffer.alloc(20)]);

type Reply = { status?: number; json?: unknown };
/** A fake Gemini: answers each call from the list, in order, and remembers the calls. */
function fakeGemini(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const textReply = (text: string): Reply => ({ json: { candidates: [{ content: { parts: [{ text }] } }] } });
const imageReply = (bytes: Buffer): Reply => ({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] } });

const noSleep = async () => {};
const makeEngine = (replies: Reply[], over: Partial<ConstructorParameters<typeof GeminiTryOnEngine>[0]> = {}) => {
  const fake = fakeGemini(replies);
  const engine = new GeminiTryOnEngine({
    fetchImpl: fake.fetchImpl,
    sleep: noSleep,
    apiKey: () => 'test-key-123',
    configuredModel: () => 'gemini-3.6-flash',
    imageModel: () => 'gemini-2.5-flash-image',
    ...over,
  });
  return { engine, calls: fake.calls };
};
const input = () => ({ person: { bytes: png(), mimeType: 'image/png' }, garment: { bytes: png(4, 5, 0x22), mimeType: 'image/png' }, category: 'tops' });

describe('Gemini try-on engine (runs inside the backend)', () => {
  describe('checking photos', () => {
    it('recognises PNG, JPEG and WebP by their first bytes, with their size', () => {
      expect(sniffImage(png(640, 480))).toEqual({ mimeType: 'image/png', width: 640, height: 480 });
      expect(sniffImage(jpeg())).toEqual({ mimeType: 'image/jpeg', width: 200, height: 300 });
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.alloc(30)]);
      expect(sniffImage(webp)?.mimeType).toBe('image/webp');
      expect(sniffImage(Buffer.from('not an image at all, just text'))).toBeNull();
    });

    it('refuses empty, oversized and non-image files with a plain message', () => {
      expect(() => validateImage(Buffer.alloc(0), 'Your photo')).toThrow(/empty/);
      expect(() => validateImage(Buffer.from('hello world, this is text'), 'Your photo')).toThrow(/JPG, PNG or WebP/);
      const big = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES)]);
      expect(() => validateImage(big, 'Your photo')).toThrow(/10 MB/);
      expect(validateImage(png(), 'Your photo').mimeType).toBe('image/png');
    });
  });

  describe('creating the picture', () => {
    it('asks for a prompt, then a picture, and keeps the key out of the web address', async () => {
      const result = png(768, 1024, 0x77);
      const { engine, calls } = makeEngine([textReply('A woman in a green linen shirt, soft studio light.'), imageReply(result)]);
      const out = await engine.generate(input());

      expect(out.bytes.equals(result)).toBe(true);
      expect(out.mimeType).toBe('image/png');
      expect(out.width).toBe(768);
      expect(out.height).toBe(1024);
      expect(out.promptModel).toBe('gemini-3.6-flash');
      expect(out.imageModel).toBe('gemini-2.5-flash-image');

      expect(calls).toHaveLength(2);
      expect(calls[1].url).toContain('/models/gemini-2.5-flash-image:generateContent');
      for (const c of calls) {
        expect(c.url).not.toContain('test-key-123');
        expect(c.headers['x-goog-api-key']).toBe('test-key-123');
      }
      // The picture request carries both photos and the prompt the vision model wrote.
      const parts = calls[1].body.contents[0].parts;
      expect(parts[0].text).toContain('A woman in a green linen shirt');
      expect(parts.filter((p: any) => p.inlineData)).toHaveLength(2);
      expect(calls[1].body.generationConfig.responseModalities).toEqual(['IMAGE']);
    });

    it('still works when the prompt step fails: it uses a plain prompt', async () => {
      const { engine } = makeEngine([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, imageReply(png(9, 9))]);
      const out = await engine.generate({ ...input(), prompt: 'Relaxed fit' });
      expect(out.promptModel).toBe('plain_prompt');
      expect(out.prompt).toBe('Relaxed fit');
    });

    it('tries again when Gemini is busy, and gives up with a retryable error', async () => {
      const busy = makeEngine([textReply('p'), { status: 503 }, { status: 503 }, imageReply(png())]);
      const ok = await busy.engine.generate(input());
      expect(ok.bytes.length).toBeGreaterThan(0);
      expect(busy.calls).toHaveLength(4); // 1 prompt + 3 picture tries

      const down = makeEngine([textReply('p'), { status: 503 }]);
      await expect(down.engine.generate(input())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
      expect(down.calls).toHaveLength(4);
    });

    it('does not retry a blocked photo, and says so plainly', async () => {
      const { engine, calls } = makeEngine([textReply('p'), { json: { promptFeedback: { blockReason: 'SAFETY' } } }]);
      await expect(engine.generate(input())).rejects.toMatchObject({ code: 'CONTENT_BLOCKED', retryable: false });
      expect(calls).toHaveLength(2);
    });

    it('fails clearly when no picture comes back', async () => {
      const { engine } = makeEngine([textReply('p'), textReply('Sorry, I cannot draw that.')]);
      await expect(engine.generate(input())).rejects.toMatchObject({ code: 'NO_IMAGE_RETURNED', retryable: true });
    });

    it('needs a key and a supported garment type', async () => {
      const noKey = makeEngine([textReply('p')], { apiKey: () => '' });
      await expect(noKey.engine.generate(input())).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
      expect(noKey.calls).toHaveLength(0);

      const { engine } = makeEngine([textReply('p')]);
      await expect(engine.generate({ ...input(), category: 'hats' })).rejects.toBeInstanceOf(TryOnEngineError);
    });

    it('uses the configured model for the picture only when it is an image model', () => {
      expect(makeEngine([], { configuredModel: () => 'gemini-3.6-flash', imageModel: () => 'my-image-model' }).engine.imageModel()).toBe('my-image-model');
      expect(makeEngine([], { configuredModel: () => 'gemini-3.1-flash-image' }).engine.imageModel()).toBe('gemini-3.1-flash-image');
      expect(makeEngine([], { configuredModel: () => '', imageModel: () => '' }).engine.imageModel()).toBe('gemini-2.5-flash-image');
    });
  });

  describe('the job pipeline (private storage in, private storage out)', () => {
    const req = (id: string, person: string, garment: string) => ({
      eventId: `evt_${id}`,
      eventType: 'tryon.generation.requested' as const,
      eventVersion: 1 as const,
      occurredAt: new Date().toISOString(),
      correlationId: `corr_${id}`,
      generationId: id,
      tenantId: 'tenant_aura',
      userId: 'user_x',
      personImage: { bucket: 'customer-uploads' as const, objectKey: person },
      garmentImage: { bucket: 'brand-assets' as const, objectKey: garment },
      modelConfig: { modelKey: 'default-tryon', modelVersion: 'v1' },
      options: { category: 'tops', quality: 'standard' as const },
    });

    it('saves the picture and reports it as completed', async () => {
      await storageAdapter.upload('customer-uploads', 'pipe/p1/person.png', png(), 'image/png');
      await storageAdapter.upload('brand-assets', 'pipe/p1/garment.png', png(), 'image/png');
      const made = png(512, 768, 0x55);
      const { engine } = makeEngine([textReply('prompt'), imageReply(made)]);

      const out = await runTryOnPipeline(req('gen_p1', 'pipe/p1/person.png', 'pipe/p1/garment.png'), engine);
      expect(out.eventType).toBe('tryon.generation.completed');
      if (out.eventType !== 'tryon.generation.completed') return;
      expect(out.result.bucket).toBe('generated-results');
      expect(out.result.objectKey).toBe('tenant_aura/gen_p1/result.png');
      expect(out.result.width).toBe(512);
      expect(out.model.key).toBe('gemini:gemini-2.5-flash-image');
      const saved = await storageAdapter.download('generated-results', out.result.objectKey);
      expect(saved.equals(made)).toBe(true);
    });

    it('reports a failed job with a plain reason, and says whether trying again can help', async () => {
      await storageAdapter.upload('customer-uploads', 'pipe/p2/person.png', Buffer.from('this is not a picture at all'), 'image/png');
      await storageAdapter.upload('brand-assets', 'pipe/p2/garment.png', png(), 'image/png');
      const bad = await runTryOnPipeline(req('gen_p2', 'pipe/p2/person.png', 'pipe/p2/garment.png'), makeEngine([textReply('p')]).engine);
      expect(bad.eventType).toBe('tryon.generation.failed');
      if (bad.eventType === 'tryon.generation.failed') {
        expect(bad.error.code).toBe('INVALID_INPUT');
        expect(bad.error.retryable).toBe(false);
      }

      const missing = await runTryOnPipeline(req('gen_p3', 'pipe/none/person.png', 'pipe/none/garment.png'), makeEngine([textReply('p')]).engine);
      expect(missing.eventType).toBe('tryon.generation.failed');
      if (missing.eventType === 'tryon.generation.failed') expect(missing.error.retryable).toBe(true);
    });
  });

  describe('the marketplace "direct" route (no separate AI service any more)', () => {
    const app = createApp('all');
    let productId = '';
    const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
    let geminiReplies: Reply[] = [];
    let geminiCalls = 0;
    const realFetch = globalThis.fetch;

    beforeAll(async () => {
      seedTestUsers();
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.40.0.1', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
      const token = JSON.parse(login.body).token;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: { Authorization: `Bearer ${token}` },
        payload: { name: 'Direct Route Shirt', category: 'Tops', price: 120, sku: 'AURA-DIRECT-01', brandStorefrontPublished: true, marketplacePublished: true, isTryOnEligible: true, images: [dataUrl(png())] },
      });
      expect(created.statusCode).toBe(201);
      productId = JSON.parse(created.body).product.id;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      globalThis.fetch = realFetch;
    });

    const mockGemini = (replies: Reply[]) => {
      geminiReplies = replies;
      geminiCalls = 0;
      vi.spyOn(config, 'geminiApiKey', 'get').mockReturnValue('route-test-key');
      vi.spyOn(cloudinaryStorage, 'isConfigured').mockReturnValue(false); // never touch a real Cloudinary account in tests
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('generativelanguage.googleapis.com')) {
          const r = geminiReplies[Math.min(geminiCalls, geminiReplies.length - 1)];
          geminiCalls += 1;
          return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
        }
        return realFetch(url as never, init);
      }) as typeof fetch;
    };

    const direct = (extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/try-on/direct',
        remoteAddress: '10.40.0.2',
        payload: { productId, personImage: dataUrl(png(30, 40)), garmentImage: dataUrl(png(30, 40, 0x33)), category: 'tops', ...extra },
      });

    it('creates the picture and lets the shopper read the result with their access token', async () => {
      mockGemini([textReply('prompt'), imageReply(png(100, 150, 0x66))]);
      const res = await direct();
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('COMPLETED');
      expect(body.provider).toBe('gemini');
      expect(body.resultUrl).toBeTruthy();
      expect(body.storageProvider).toBe('private_storage');
      expect(typeof body.accessToken).toBe('string');

      const status = await app.inject({ method: 'GET', url: `/api/v1/try-on/status/${body.jobId}`, headers: { 'x-try-on-token': body.accessToken } });
      expect(status.statusCode).toBe(200);
      expect(JSON.parse(status.body).status).toBe('COMPLETED');
      expect(JSON.parse(status.body).resultUrl).toBeTruthy();

      // Nobody else can read it.
      const stranger = await app.inject({ method: 'GET', url: `/api/v1/try-on/status/${body.jobId}`, headers: { 'x-try-on-token': 'wrong-token' } });
      expect(stranger.statusCode).toBe(404);
    });

    it('answers a blocked photo with a clear message and does not keep the try-on', async () => {
      mockGemini([textReply('prompt'), { json: { promptFeedback: { blockReason: 'SAFETY' } } }]);
      const res = await direct();
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error).toBe('CONTENT_BLOCKED');
      const failed = db.getAllGenerations().filter((j) => j.productId === productId && j.status === 'FAILED');
      expect(failed.length).toBeGreaterThan(0);
    });

    it('refuses photos that are not real images, and links that are not public https', async () => {
      mockGemini([textReply('p'), imageReply(png())]);
      expect((await direct({ personImage: 'data:image/png;base64,bm90IGFuIGltYWdl' })).statusCode).toBe(400);
      for (const bad of ['http://example.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://169.254.169.254/latest', 'file:///etc/passwd']) {
        const res = await direct({ personImage: bad });
        expect(res.statusCode, bad).toBe(400);
      }
      expect(geminiCalls).toBe(0); // nothing reached Gemini
    });

    it('says the service is not set up when the Gemini key is missing', async () => {
      mockGemini([textReply('p')]);
      vi.spyOn(config, 'geminiApiKey', 'get').mockReturnValue('');
      const res = await direct();
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('NOT_CONFIGURED');
    });

    it('reports the engine on the provider route, with no separate AI service', async () => {
      mockGemini([textReply('p')]);
      const res = await app.inject({ method: 'GET', url: '/api/v1/try-on/provider' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ mode: 'gemini', provider: 'gemini', status: 'ready', configured: true });
    });
  });
});
