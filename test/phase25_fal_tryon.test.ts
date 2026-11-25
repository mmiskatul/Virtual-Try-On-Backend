import './setup_env.js';
import { describe, expect, it, vi } from 'vitest';
import { FalTryOnEngine, DEFAULT_FAL_MODEL, FAL_MAX_ATTEMPTS, fromFalError, type FalGateway } from '../src/modules/tryon/fal.engine.js';
import { TryOnEngineSelector, type TryOnEngine } from '../src/modules/tryon/tryon.engine.js';
import { runTryOnPipeline } from '../src/modules/tryon/tryon.pipeline.js';
import { storageAdapter } from '../src/infrastructure/storage.adapter.js';
import { cloudinaryStorage } from '../src/infrastructure/cloudinary_storage.js';
import { TryOnEngineError, type EngineResult } from '../src/modules/tryon/gemini.engine.js';

// A tiny PNG header with a real size (2 x 3): enough for the engine to recognise it as a PNG.
function png(fill = 0x11): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(2, 16);
  head.writeUInt32BE(3, 20);
  return Buffer.concat([head, Buffer.alloc(40, fill)]);
}
const img = (fill = 0x11) => ({ bytes: png(fill), mimeType: 'image/png' });
const input = () => ({ person: img(0x11), garment: img(0x22), category: 'tops' });

/** An error shaped like the ones @fal-ai/client throws. */
const falError = (status: number, body: unknown = {}, message = 'fal error') => Object.assign(new Error(message), { status, body });

type Step = { data?: any; throws?: unknown };
/**
 * A fake fal client. `steps` answers each subscribe() call in order; `downloads` answers each download of a result link.
 * It remembers every upload and subscribe so the tests can check what we asked for.
 */
function fakeFal(steps: Step[], downloads: Buffer[] = [png(0x77)], opts: { uploadFails?: boolean } = {}) {
  const uploads: Array<{ mimeType: string; size: number }> = [];
  const subscribes: Array<{ model: string; input: any; options: { timeoutMs: number } }> = [];
  const fetched: string[] = [];
  let s = 0;
  let d = 0;
  const gateway: FalGateway = {
    async upload(bytes, mimeType) {
      if (opts.uploadFails) throw new Error('storage down');
      uploads.push({ mimeType, size: bytes.length });
      return `https://v3.fal.media/files/upload-${uploads.length}.png`;
    },
    async subscribe(model, inp, options) {
      subscribes.push({ model, input: inp, options });
      const step = steps[Math.min(s, steps.length - 1)];
      s += 1;
      if (step.throws) throw step.throws;
      return { data: step.data, requestId: 'req_test' };
    },
  };
  const fetchImpl = (async (url: string) => {
    fetched.push(String(url));
    const bytes = downloads[Math.min(d, downloads.length - 1)];
    d += 1;
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
  return { gateway, fetchImpl, uploads, subscribes, fetched };
}
const engineWith = (steps: Step[], downloads?: Buffer[], key = 'test-fal-key', opts: { uploadFails?: boolean } = {}) => {
  const fake = fakeFal(steps, downloads, opts);
  const engine = new FalTryOnEngine({ gateway: fake.gateway, fetchImpl: fake.fetchImpl, sleep: async () => {}, apiKey: () => key, model: () => DEFAULT_FAL_MODEL });
  return { engine, ...fake };
};
const done = { data: { images: [{ url: 'https://v3.fal.media/files/result.png', content_type: 'image/png' }] } };

describe('Phase 25 - fal.ai try-on engine (fal.subscribe)', () => {
  it('uploads both photos, subscribes to the configured model with prompt and image_urls, and returns the picture', async () => {
    const { engine, subscribes, uploads, fetched } = engineWith([done]);
    const result = await engine.generate(input());

    expect(uploads).toHaveLength(2);
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0].model).toBe(DEFAULT_FAL_MODEL);
    expect(subscribes[0].input.image_urls).toEqual(['https://v3.fal.media/files/upload-1.png', 'https://v3.fal.media/files/upload-2.png']);
    expect(subscribes[0].input.prompt).toMatch(/first image/);
    expect(subscribes[0].input.num_images).toBe(1);
    expect(fetched).toEqual(['https://v3.fal.media/files/result.png']);

    expect(result.provider).toBe('fal');
    expect(result.imageModel).toBe(DEFAULT_FAL_MODEL);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(2);
    expect(result.height).toBe(3);
  });

  it('sends the photos inline when fal file storage is unavailable', async () => {
    const { engine, subscribes } = engineWith([done], undefined, 'test-fal-key', { uploadFails: true });
    await engine.generate(input());
    expect(subscribes[0].input.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(subscribes[0].input.image_urls[1]).toMatch(/^data:image\/png;base64,/);
  });

  it('accepts a picture sent back as a data URL', async () => {
    const url = `data:image/png;base64,${png(0x55).toString('base64')}`;
    const { engine, fetched } = engineWith([{ data: { images: [{ url }] } }]);
    const result = await engine.generate(input());
    expect(fetched).toHaveLength(0);
    expect(result.bytes.equals(png(0x55))).toBe(true);
  });

  it('is not configured without a key and says so', async () => {
    const { engine, subscribes } = engineWith([done], undefined, '');
    expect(engine.isConfigured()).toBe(false);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
    expect(subscribes).toHaveLength(0);
  });

  it('rejects an unsupported garment type before calling fal', async () => {
    const { engine, subscribes, uploads } = engineWith([done]);
    await expect(engine.generate({ ...input(), category: 'hats' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CATEGORY' });
    expect(subscribes).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('retries once when fal is busy and then succeeds', async () => {
    const { engine, subscribes } = engineWith([{ throws: falError(503) }, done]);
    const result = await engine.generate(input());
    expect(result.provider).toBe('fal');
    expect(subscribes).toHaveLength(2);
  });

  it('gives up with a retryable error after the last busy answer', async () => {
    const { engine, subscribes } = engineWith([{ throws: falError(503) }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(subscribes).toHaveLength(FAL_MAX_ATTEMPTS);
  });

  it('asks again when the model answers with no picture, and alternates the full and the short prompt', async () => {
    const noMedia = { throws: falError(422, { detail: [{ type: 'no_media_generated', msg: 'The model did not generate the expected output' }] }) };
    const { engine, subscribes } = engineWith([noMedia, noMedia, noMedia, done]);
    const result = await engine.generate({ ...input(), garmentInfo: { name: 'Linen Shirt', colour: 'White' } });
    expect(result.provider).toBe('fal');
    expect(subscribes).toHaveLength(4);
    expect(subscribes[0].input.prompt.length).toBeGreaterThan(subscribes[1].input.prompt.length); // full, then short
    expect(subscribes[2].input.prompt).toBe(subscribes[0].input.prompt);
    expect(subscribes[1].input.prompt).toBe(subscribes[3].input.prompt);
  });

  it('reports no_media_generated as a retryable NO_IMAGE_RETURNED, not as blocked content', () => {
    const err = fromFalError(falError(422, { detail: [{ type: 'no_media_generated', msg: 'may occur for reasons including unsafe content' }] }));
    expect(err).toMatchObject({ code: 'NO_IMAGE_RETURNED', retryable: true });
  });

  it('maps a content-policy refusal to CONTENT_BLOCKED and does not retry', async () => {
    const { engine, subscribes } = engineWith([{ throws: falError(422, { detail: [{ type: 'content_policy_violation' }] }) }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'CONTENT_BLOCKED', retryable: false });
    expect(subscribes).toHaveLength(1);
  });

  it('does not retry a rejected key and never repeats the key in the error', async () => {
    const { engine, subscribes } = engineWith([{ throws: falError(401, { detail: 'bad key test-fal-key' }, 'Unauthorized test-fal-key') }]);
    const err = await engine.generate(input()).catch((e) => e);
    expect(err).toBeInstanceOf(TryOnEngineError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('test-fal-key');
    expect(subscribes).toHaveLength(1);
  });

  it('turns a queue timeout into TIMEOUT and does not wait a second time', async () => {
    const { engine, subscribes } = engineWith([{ throws: new Error('Client timed out waiting for the request to complete after 75000ms') }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(subscribes).toHaveLength(1);
  });

  it('gives the queue the configured time limit', async () => {
    const fake = fakeFal([done]);
    const engine = new FalTryOnEngine({ gateway: fake.gateway, fetchImpl: fake.fetchImpl, sleep: async () => {}, apiKey: () => 'k', jobTimeoutMs: 1234 });
    await engine.generate(input());
    expect(fake.subscribes[0].options.timeoutMs).toBe(1234);
  });

  it('fails clearly when fal returns no picture', async () => {
    const { engine } = engineWith([{ data: { images: [] } }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'NO_IMAGE_RETURNED' });
  });

  it('fromFalError: network errors without a status are retryable upstream errors', () => {
    expect(fromFalError(new Error('fetch failed'))).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });
});

describe('Phase 25 - engine selector', () => {
  const fakeResult = (provider: 'fal' | 'gemini'): EngineResult => ({
    bytes: png(), mimeType: 'image/png', imageModel: `${provider}-model`, promptModel: 'x', prompt: 'p', provider,
    timings: { promptMs: 0, imageMs: 1, totalMs: 1 },
  });
  const fake = (provider: 'fal' | 'gemini', opts: { configured?: boolean; fail?: TryOnEngineError } = {}) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      isConfigured: () => opts.configured ?? true,
      imageModel: () => `${provider}-model`,
      status: () => ({ configured: opts.configured ?? true, imageModel: `${provider}-model`, promptModel: 'gemini-prompt' }),
      generate: async () => { calls += 1; if (opts.fail) throw opts.fail; return fakeResult(provider); },
    };
  };

  it('uses Gemini direct when there is no fal key', async () => {
    const fal = fake('fal', { configured: false });
    const gemini = fake('gemini');
    const sel = new TryOnEngineSelector(fal as never, gemini as never, () => 'auto');
    expect(sel.status()).toMatchObject({ provider: 'gemini', imageModel: 'gemini-model', configured: true });
    expect((await sel.generate(input())).provider).toBe('gemini');
    expect(fal.calls).toBe(0);
  });

  it('uses fal first when the fal key is set', async () => {
    const fal = fake('fal');
    const gemini = fake('gemini');
    const sel = new TryOnEngineSelector(fal as never, gemini as never, () => 'auto');
    expect(sel.status()).toMatchObject({ provider: 'fal', imageModel: 'fal-model', fallback: 'gemini' });
    expect((await sel.generate(input())).provider).toBe('fal');
    expect(gemini.calls).toBe(0);
  });

  it('falls back to Gemini when fal is down', async () => {
    const fal = fake('fal', { fail: new TryOnEngineError('UPSTREAM_ERROR', 'down', true) });
    const gemini = fake('gemini');
    const sel = new TryOnEngineSelector(fal as never, gemini as never, () => 'auto');
    expect((await sel.generate(input())).provider).toBe('gemini');
    expect(fal.calls).toBe(1);
    expect(gemini.calls).toBe(1);
  });

  it('does not try Gemini for problems that would repeat (blocked content, bad input)', async () => {
    for (const code of ['CONTENT_BLOCKED', 'INVALID_INPUT', 'UNSUPPORTED_CATEGORY'] as const) {
      const fal = fake('fal', { fail: new TryOnEngineError(code, 'no', false) });
      const gemini = fake('gemini');
      const sel = new TryOnEngineSelector(fal as never, gemini as never, () => 'auto');
      await expect(sel.generate(input())).rejects.toMatchObject({ code });
      expect(gemini.calls).toBe(0);
    }
  });

  it('passes the fal error through when there is no Gemini key to fall back on', async () => {
    const fal = fake('fal', { fail: new TryOnEngineError('TIMEOUT', 'slow', true) });
    const gemini = fake('gemini', { configured: false });
    const sel = new TryOnEngineSelector(fal as never, gemini as never, () => 'auto');
    await expect(sel.generate(input())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('Phase 25 - TRYON_PROVIDER setting', () => {
  const ok = (provider: 'fal' | 'gemini') => ({
    bytes: png(), mimeType: 'image/png', imageModel: `${provider}-model`, promptModel: 'x', prompt: 'p', provider,
    timings: { promptMs: 0, imageMs: 1, totalMs: 1 },
  });
  const eng = (provider: 'fal' | 'gemini', configured = true, fail?: TryOnEngineError) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      isConfigured: () => configured,
      imageModel: () => `${provider}-model`,
      status: () => ({ configured, imageModel: `${provider}-model`, promptModel: 'gp' }),
      generate: async () => { calls += 1; if (fail) throw fail; return ok(provider) as EngineResult; },
    };
  };
  const down = () => new TryOnEngineError('UPSTREAM_ERROR', 'down', true);

  it('gemini mode never calls fal, even when a fal key exists', async () => {
    const fal = eng('fal'); const gem = eng('gemini');
    const sel = new TryOnEngineSelector(fal as never, gem as never, () => 'gemini');
    expect((await sel.generate(input())).provider).toBe('gemini');
    expect(fal.calls).toBe(0);
    expect(sel.status()).toMatchObject({ mode: 'gemini', provider: 'gemini', fallback: null });
  });

  it('fal mode uses fal only and does not fall back to Gemini', async () => {
    const fal = eng('fal', true, down()); const gem = eng('gemini');
    const sel = new TryOnEngineSelector(fal as never, gem as never, () => 'fal');
    await expect(sel.generate(input())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(gem.calls).toBe(0);
    expect(sel.status()).toMatchObject({ mode: 'fal', provider: 'fal', fallback: null });
  });

  it('fal mode without a fal key says it is not configured, even if Gemini is ready', () => {
    const sel = new TryOnEngineSelector(eng('fal', false) as never, eng('gemini') as never, () => 'fal');
    expect(sel.isConfigured()).toBe(false);
  });

  it('auto mode shows both services in the status', () => {
    const sel = new TryOnEngineSelector(eng('fal') as never, eng('gemini') as never, () => 'auto');
    expect(sel.status()).toMatchObject({ mode: 'auto', provider: 'fal', fallback: 'gemini', fal: { configured: true }, gemini: { configured: true } });
  });
});

describe('Phase 25 - never hand back an unchanged photo', () => {
  it('fal: a result identical to the shopper photo is retried, then fails clearly', async () => {
    const person = png(0x11);
    const same = { data: { images: [{ url: 'https://v3.fal.media/files/same.png' }] } };
    const { engine, subscribes } = engineWith([same], [person]);
    await expect(engine.generate({ person: { bytes: person, mimeType: 'image/png' }, garment: img(0x22), category: 'tops' })).rejects.toMatchObject({ code: 'NO_IMAGE_RETURNED' });
    expect(subscribes).toHaveLength(FAL_MAX_ATTEMPTS);
  });

  it('fal: a real new picture after an unchanged one is accepted', async () => {
    const person = png(0x11);
    const { engine } = engineWith([done, done], [person, png(0x99)]);
    const result = await engine.generate({ person: { bytes: person, mimeType: 'image/png' }, garment: img(0x22), category: 'tops' });
    expect(result.bytes.equals(png(0x99))).toBe(true);
  });

  it('FLUX (the default model) gets a caption of the finished picture that keeps the person and copies the garment', async () => {
    const { engine, subscribes } = engineWith([done]);
    await engine.generate(input());
    const prompt: string = subscribes[0].input.prompt;
    expect(subscribes[0].model).toBe('blackforestlabs/flux-3/klein/edit-image');
    expect(prompt).toMatch(/^A photorealistic photo of the person from the first image, with the same face, hair, pose and background/);
    expect(prompt).toMatch(/from the second image in place of the clothing on the upper body/);
    expect(prompt).toMatch(/matches the second image exactly in colour, fabric, pattern, print/);
    expect(prompt).toMatch(/stay the same\./);
    expect(prompt).not.toMatch(/Edit the first image|Do not return/); // no instructions or negations for FLUX
  });

  it('Gemini through fal keeps the instruction-style prompt', async () => {
    const fake = fakeFal([done]);
    const engine = new FalTryOnEngine({ gateway: fake.gateway, fetchImpl: fake.fetchImpl, sleep: async () => {}, apiKey: () => 'k', model: () => 'fal-ai/gemini-25-flash-image/edit' });
    await engine.generate(input());
    const prompt: string = fake.subscribes[0].input.prompt;
    expect(fake.subscribes[0].model).toBe('fal-ai/gemini-25-flash-image/edit');
    expect(prompt).toMatch(/^Edit the first image: put the/);
    expect(prompt).toMatch(/Do not return the first or the second image unchanged/);
    expect(fake.subscribes[0].input.enable_prompt_expansion).toBeUndefined();
  });

  it('sends the FLUX options: two images, one picture, prompt expansion on, and no fixed image size', async () => {
    const { engine, subscribes } = engineWith([done]);
    await engine.generate(input());
    const sent = subscribes[0].input;
    expect(sent.image_urls).toHaveLength(2);
    expect(sent.num_images).toBe(1);
    expect(sent.output_format).toBe('png');
    expect(sent.enable_prompt_expansion).toBe(true);
    expect(sent.image_size).toBeUndefined(); // the picture keeps the first photo's size
  });

  it("refuses a picture the model's own safety check flagged, and does not retry", async () => {
    const { engine, subscribes } = engineWith([{ data: { images: [{ url: 'https://v3.fal.media/files/result.png' }], has_nsfw_concepts: [true] } }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'CONTENT_BLOCKED', retryable: false });
    expect(subscribes).toHaveLength(1);
  });
});

describe('Phase 25 - results are saved to Cloudinary and shown from there', () => {
  const request = (id: string) => ({
    eventId: `evt_${id}`,
    eventType: 'tryon.generation.requested' as const,
    eventVersion: 1 as const,
    occurredAt: new Date().toISOString(),
    correlationId: `corr_${id}`,
    generationId: id,
    tenantId: 'tenant_cld',
    userId: 'user_cld',
    personImage: { bucket: 'customer-uploads' as const, objectKey: `cld/${id}/person.png` },
    garmentImage: { bucket: 'brand-assets' as const, objectKey: `cld/${id}/garment.png` },
    modelConfig: { modelKey: 'default-tryon', modelVersion: 'v1' },
    options: { category: 'tops', quality: 'standard' as const },
  });
  const engineReturning = (bytes: Buffer): TryOnEngine => ({
    isConfigured: () => true,
    imageModel: () => 'fal-ai/gemini-25-flash-image/edit',
    status: () => ({ configured: true, imageModel: 'fal-ai/gemini-25-flash-image/edit' }),
    generate: async () => ({
      bytes, mimeType: 'image/png', width: 2, height: 3, imageModel: 'fal-ai/gemini-25-flash-image/edit', promptModel: 'direct', prompt: 'p', provider: 'fal',
      timings: { promptMs: 0, imageMs: 1, totalMs: 1 },
    }),
  });

  it('uploads the finished picture to Cloudinary and puts the link in the result', async () => {
    await storageAdapter.upload('customer-uploads', 'cld/g1/person.png', png(0x11), 'image/png');
    await storageAdapter.upload('brand-assets', 'cld/g1/garment.png', png(0x22), 'image/png');
    const made = png(0x66);
    const configured = vi.spyOn(cloudinaryStorage, 'isConfigured').mockReturnValue(true);
    const upload = vi.spyOn(cloudinaryStorage, 'uploadBuffer').mockResolvedValue('https://res.cloudinary.com/demo/image/upload/v1/tryon/results/tryon_res_g1.png');
    try {
      const out = await runTryOnPipeline(request('g1'), engineReturning(made));
      expect(out.eventType).toBe('tryon.generation.completed');
      if (out.eventType !== 'tryon.generation.completed') return;
      expect(out.result.publicUrl).toBe('https://res.cloudinary.com/demo/image/upload/v1/tryon/results/tryon_res_g1.png');
      expect(out.model.key).toBe('fal:fal-ai/gemini-25-flash-image/edit');
      expect(upload).toHaveBeenCalledTimes(1);
      expect((upload.mock.calls[0][0] as Buffer).equals(made)).toBe(true);
      expect(upload.mock.calls[0][1]).toMatchObject({ publicId: 'tryon_res_g1' });
    } finally {
      configured.mockRestore();
      upload.mockRestore();
    }
  });

  it('still completes with the private copy when Cloudinary is not set up or fails', async () => {
    await storageAdapter.upload('customer-uploads', 'cld/g2/person.png', png(0x11), 'image/png');
    await storageAdapter.upload('brand-assets', 'cld/g2/garment.png', png(0x22), 'image/png');
    const configured = vi.spyOn(cloudinaryStorage, 'isConfigured').mockReturnValue(true);
    const upload = vi.spyOn(cloudinaryStorage, 'uploadBuffer').mockResolvedValue(null);
    try {
      const out = await runTryOnPipeline(request('g2'), engineReturning(png(0x66)));
      expect(out.eventType).toBe('tryon.generation.completed');
      if (out.eventType === 'tryon.generation.completed') expect(out.result.publicUrl).toBeUndefined();
    } finally {
      configured.mockRestore();
      upload.mockRestore();
    }
  });
});
