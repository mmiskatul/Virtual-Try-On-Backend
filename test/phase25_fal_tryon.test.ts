import './setup_env.js';
import { describe, expect, it } from 'vitest';
import { FalTryOnEngine, DEFAULT_FAL_MODEL } from '../src/modules/tryon/fal.engine.js';
import { TryOnEngineSelector } from '../src/modules/tryon/tryon.engine.js';
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

type Call = { url: string; headers: Record<string, string>; body?: any };
type Reply = { status?: number; json?: unknown; bytes?: Buffer };

/** A fake fal: answers each call from the list, in order, and remembers what was asked. */
function fakeFal(replies: Reply[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: (init.headers || {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (r.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status ?? 200 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const engineWith = (replies: Reply[], key = 'test-fal-key') => {
  const fake = fakeFal(replies);
  const engine = new FalTryOnEngine({ fetchImpl: fake.fetchImpl, sleep: async () => {}, apiKey: () => key, model: () => DEFAULT_FAL_MODEL });
  return { engine, calls: fake.calls };
};
const imageReply = { json: { images: [{ url: 'https://v3.fal.media/files/result.png', content_type: 'image/png' }] } };

describe('Phase 25 - fal.ai try-on engine', () => {
  it('sends both photos and the instruction to the configured fal model and returns the picture', async () => {
    const { engine, calls } = engineWith([imageReply, { bytes: png(0x77) }]);
    const result = await engine.generate(input());

    expect(calls[0].url).toBe(`https://fal.run/${DEFAULT_FAL_MODEL}`);
    expect(calls[0].headers.Authorization).toBe('Key test-fal-key');
    expect(calls[0].url).not.toContain('test-fal-key');
    expect(calls[0].body.image_urls).toHaveLength(2);
    expect(calls[0].body.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(calls[0].body.prompt).toMatch(/first image/);
    expect(calls[0].body.num_images).toBe(1);

    expect(result.provider).toBe('fal');
    expect(result.imageModel).toBe(DEFAULT_FAL_MODEL);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(2);
    expect(result.height).toBe(3);
  });

  it('accepts a picture sent back as a data URL', async () => {
    const dataUrl = `data:image/png;base64,${png(0x55).toString('base64')}`;
    const { engine, calls } = engineWith([{ json: { images: [{ url: dataUrl }] } }]);
    const result = await engine.generate(input());
    expect(calls).toHaveLength(1);
    expect(result.bytes.equals(png(0x55))).toBe(true);
  });

  it('is not configured without a key and says so', async () => {
    const { engine } = engineWith([imageReply], '');
    expect(engine.isConfigured()).toBe(false);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
  });

  it('rejects an unsupported garment type before calling fal', async () => {
    const { engine, calls } = engineWith([imageReply]);
    await expect(engine.generate({ ...input(), category: 'hats' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CATEGORY' });
    expect(calls).toHaveLength(0);
  });

  it('retries when fal is busy and then succeeds', async () => {
    const { engine, calls } = engineWith([{ status: 503, json: {} }, imageReply, { bytes: png() }]);
    const result = await engine.generate(input());
    expect(result.provider).toBe('fal');
    expect(calls).toHaveLength(3);
  });

  it('maps a content-policy refusal to CONTENT_BLOCKED and does not retry', async () => {
    const { engine, calls } = engineWith([{ status: 422, json: { detail: [{ type: 'content_policy_violation' }] } }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'CONTENT_BLOCKED', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a rejected key and never repeats the key in the error', async () => {
    const { engine, calls } = engineWith([{ status: 401, json: { detail: 'bad key test-fal-key' } }]);
    const err = await engine.generate(input()).catch((e) => e);
    expect(err).toBeInstanceOf(TryOnEngineError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('test-fal-key');
    expect(calls).toHaveLength(1);
  });

  it('fails clearly when fal returns no picture', async () => {
    const { engine } = engineWith([{ json: { images: [] } }]);
    await expect(engine.generate(input())).rejects.toMatchObject({ code: 'NO_IMAGE_RETURNED' });
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
