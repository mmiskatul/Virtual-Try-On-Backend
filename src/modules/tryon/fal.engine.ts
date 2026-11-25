import { config } from '../../infrastructure/config.js';
import { fitInstruction, type ShopperFit } from './shopper_fit.js';
import { SUPPORTED_CATEGORIES, TryOnEngineError, sniffImage, type EngineImage, type EngineResult } from './gemini.engine.js';

/**
 * Virtual try-on through fal.ai. fal hosts Google's Gemini 2.5 Flash Image "edit" model: we send the shopper's photo and
 * the garment photo plus an instruction, and it sends back one edited picture.
 *
 * Like the Gemini engine, if fal cannot finish the job fails with a clear reason. A fake or composited picture is never returned.
 */

export const DEFAULT_FAL_MODEL = 'fal-ai/gemini-25-flash-image/edit';
const FAL_ROOT = 'https://fal.run';
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface FalEngineDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: () => string;
  model?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dataUrl = (img: EngineImage) => `data:${img.mimeType};base64,${img.bytes.toString('base64')}`;

export class FalTryOnEngine {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getKey: () => string;
  private readonly getModel: () => string;

  constructor(deps: FalEngineDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? defaultSleep;
    this.getKey = deps.apiKey ?? (() => (config.falKey || '').trim());
    this.getModel = deps.model ?? (() => (config.falModel || '').trim());
  }

  public isConfigured(): boolean {
    return Boolean(this.getKey());
  }

  public imageModel(): string {
    return this.getModel() || DEFAULT_FAL_MODEL;
  }

  public status() {
    return { configured: this.isConfigured(), imageModel: this.imageModel(), promptModel: 'direct' };
  }

  private async call(body: unknown, timeoutMs: number): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${FAL_ROOT}/${this.imageModel()}`, {
        method: 'POST',
        // The key goes in a header, never in the URL, so it cannot appear in logs.
        headers: { Authorization: `Key ${this.getKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TryOnEngineError('TIMEOUT', 'The picture took too long to create. Please try again.', true);
      }
      throw new TryOnEngineError('UPSTREAM_ERROR', 'Could not reach the image service. Please try again.', true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 422 && /content_policy|safety|prohibited/i.test(text)) {
        throw new TryOnEngineError('CONTENT_BLOCKED', 'This photo or garment could not be used. Please try a different photo.', false);
      }
      if (res.status === 401 || res.status === 403) {
        throw new TryOnEngineError('UPSTREAM_ERROR', 'The image service did not accept our key (HTTP ' + res.status + ').', false);
      }
      throw new TryOnEngineError(
        'UPSTREAM_ERROR',
        `The image service answered with an error (HTTP ${res.status}). ${text.slice(0, 160)}`.trim(),
        RETRYABLE_STATUS.has(res.status)
      );
    }
    return res.json();
  }

  /** fal answers with a link to the picture (or a data URL). Turn either into bytes. */
  private async readImage(url: string): Promise<Buffer> {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      return Buffer.from(url.slice(comma + 1), 'base64');
    }
    if (!/^https:\/\//i.test(url)) {
      throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new TryOnEngineError('UPSTREAM_ERROR', 'The picture was created but could not be downloaded. Please try again.', true);
    }
    if (!res.ok) {
      throw new TryOnEngineError('UPSTREAM_ERROR', 'The picture was created but could not be downloaded. Please try again.', true);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  public async generate(input: { person: EngineImage; garment: EngineImage; category: string; prompt?: string; shopper?: ShopperFit }): Promise<EngineResult> {
    const started = Date.now();
    const category = (input.category || 'tops').toLowerCase();
    if (!(SUPPORTED_CATEGORIES as readonly string[]).includes(category)) {
      throw new TryOnEngineError('UNSUPPORTED_CATEGORY', `Unsupported garment type '${category}'. Use one of: ${SUPPORTED_CATEGORIES.join(', ')}.`, false);
    }
    if (!this.isConfigured()) {
      throw new TryOnEngineError('NOT_CONFIGURED', 'Virtual try-on is not set up yet. The fal.ai key is missing.', false);
    }

    const styling = input.prompt || 'A natural, authentic studio shot with accurate fabric drape and a tailored fit.';
    const prompt =
      `Virtual try-on task: dress the person from the first image in the ${category} garment from the second image. ` +
      `Keep the person's face, body pose, skin tone and the background natural. ` +
      `Match the garment's colour, fabric, cut and pattern exactly. ${fitInstruction(input.shopper, category)} ${styling}`
        .replace(/\s+/g, ' ')
        .trim();
    const body = { prompt, image_urls: [dataUrl(input.person), dataUrl(input.garment)], num_images: 1, output_format: 'png' };

    const t0 = Date.now();
    let lastError: TryOnEngineError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await this.call(body, 90_000);
        const url: string | undefined = data?.images?.[0]?.url;
        if (!url) throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);
        const bytes = await this.readImage(url);
        const info = sniffImage(bytes);
        if (!info) throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);
        const done = Date.now();
        return {
          bytes,
          mimeType: info.mimeType,
          width: info.width,
          height: info.height,
          imageModel: this.imageModel(),
          promptModel: 'direct',
          prompt,
          provider: 'fal',
          timings: { promptMs: 0, imageMs: done - t0, totalMs: done - started },
        };
      } catch (err: unknown) {
        lastError = err instanceof TryOnEngineError ? err : new TryOnEngineError('UPSTREAM_ERROR', 'Could not create the picture.', true);
        if (!lastError.retryable || attempt === 2) break;
        await this.sleep(1500 * (attempt + 1));
      }
    }
    throw lastError ?? new TryOnEngineError('UPSTREAM_ERROR', 'Could not create the picture.', true);
  }
}

export const falTryOnEngine = new FalTryOnEngine();
