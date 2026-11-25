import { createFalClient } from '@fal-ai/client';
import { config } from '../../infrastructure/config.js';
import type { ShopperFit } from './shopper_fit.js';
import { PROMPT_VERSION, buildTryOnPrompt, promptStyleForModel, sameBytes, type GarmentInfo } from './tryon_prompt.js';
import { SUPPORTED_CATEGORIES, TryOnEngineError, sniffImage, type EngineImage, type EngineResult } from './gemini.engine.js';

/**
 * Virtual try-on through fal.ai, using fal's official client (`@fal-ai/client`):
 *
 *   fal.subscribe('blackforestlabs/flux-3/klein/edit-image', { input: { prompt, image_urls } })
 *
 * The model is set by FAL_MODEL. The default is FLUX.3 Klein image editing, which takes one to ten reference images and a
 * caption of the finished picture. Any other fal image-edit model with the same input shape (for example
 * fal-ai/gemini-25-flash-image/edit) also works. subscribe puts the job in fal's queue and waits for it, so a busy
 * moment is a short wait and not a failure. We upload the shopper photo and the garment photo to fal's file storage first
 * (falling back to inline data URLs), then download the finished picture.
 *
 * The key and the model name come from the .env file (FAL_KEY, FAL_MODEL). If fal cannot finish, the job fails with a
 * clear reason. A fake or composited picture is never returned.
 */

export const DEFAULT_FAL_MODEL = 'blackforestlabs/flux-3/klein/edit-image';
/** How long one fal job may take before we give up on it (the apps wait up to 120 s, and Gemini may still need time as a fallback). */
export const FAL_JOB_TIMEOUT_MS = 75_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/**
 * How many times one job is tried on fal. The model sometimes answers in a few seconds with text and no picture
 * (fal reports it as `no_media_generated`), and asking again often works, so a few quick tries are worth it.
 */
export const FAL_MAX_ATTEMPTS = 4;
/** Stop trying after this long, so there is still time left for the Gemini fallback before the app gives up (120 s). */
export const FAL_RETRY_BUDGET_MS = 60_000;

/** The two calls we make to fal. Kept small so tests can replace them without touching the network. */
export interface FalGateway {
  /** Put a photo in fal's file storage and return its URL. */
  upload(bytes: Buffer, mimeType: string): Promise<string>;
  /** Queue a job on a model and wait for its output (this is `fal.subscribe`). */
  subscribe(model: string, input: Record<string, unknown>, options: { timeoutMs: number }): Promise<{ data: any; requestId?: string }>;
}

export interface FalEngineDeps {
  gateway?: FalGateway;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: () => string;
  model?: () => string;
  jobTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dataUrl = (img: EngineImage) => `data:${img.mimeType};base64,${img.bytes.toString('base64')}`;

/** The real fal client. It is built per call so a key changed in the admin screen is used straight away. */
function realGateway(getKey: () => string): FalGateway {
  const client = () => createFalClient({ credentials: getKey() });
  return {
    async upload(bytes, mimeType) {
      return client().storage.upload(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    },
    async subscribe(model, input, options) {
      const result = await client().subscribe(model as never, {
        input: input as never,
        logs: false,
        pollInterval: 1000,
        timeout: options.timeoutMs,
      } as never);
      return { data: (result as { data: unknown }).data, requestId: (result as { requestId?: string }).requestId };
    },
  };
}

/** Turn whatever fal's client throws into a plain engine error that says what to do next. */
export function fromFalError(err: unknown): TryOnEngineError {
  if (err instanceof TryOnEngineError) return err;
  const e = err as { status?: number; message?: string; name?: string; body?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : 0;
  const detail = (e?.body as { detail?: unknown } | undefined)?.detail;
  const details: Array<{ type?: string; msg?: string }> = Array.isArray(detail) ? (detail as Array<{ type?: string; msg?: string }>) : [];
  const types = details.map((d) => String(d?.type || ''));

  // fal answered but the model made no picture (it may have replied with text only). Trying again, with a shorter prompt, often works.
  if (types.includes('no_media_generated')) {
    return new TryOnEngineError('NO_IMAGE_RETURNED', 'The picture could not be created from these photos. Please try again, or use a clearer photo of the garment.', true);
  }
  // Only fal's own error type counts as a refusal; the text of the error can echo our prompt back.
  if ((status === 422 || status === 400) && types.some((t) => /content_policy|safety|prohibited/i.test(t))) {
    return new TryOnEngineError('CONTENT_BLOCKED', 'This photo or garment could not be used. Please try a different photo.', false);
  }
  if (status === 401 || status === 403) {
    return new TryOnEngineError('UPSTREAM_ERROR', `The image service did not accept our key (HTTP ${status}).`, false);
  }
  if (status === 408 || /timed? ?out|timeout|aborted/i.test(e?.name + ' ' + (e?.message || ''))) {
    return new TryOnEngineError('TIMEOUT', 'The picture took too long to create. Please try again.', true);
  }
  if (status) {
    return new TryOnEngineError(
      'UPSTREAM_ERROR',
      `The image service answered with an error (HTTP ${status}). ${String(e?.message || '').slice(0, 160)}`.trim(),
      RETRYABLE_STATUS.has(status)
    );
  }
  return new TryOnEngineError('UPSTREAM_ERROR', 'Could not reach the image service. Please try again.', true);
}

export class FalTryOnEngine {
  private readonly gateway: FalGateway;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getKey: () => string;
  private readonly getModel: () => string;
  private readonly jobTimeoutMs: number;

  constructor(deps: FalEngineDeps = {}) {
    this.getKey = deps.apiKey ?? (() => (config.falKey || '').trim());
    this.getModel = deps.model ?? (() => (config.falModel || '').trim());
    this.gateway = deps.gateway ?? realGateway(this.getKey);
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? defaultSleep;
    this.jobTimeoutMs = deps.jobTimeoutMs ?? FAL_JOB_TIMEOUT_MS;
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

  /** fal gives us a link to the finished picture (or a data URL). Turn either into bytes. */
  private async readImage(url: string): Promise<Buffer> {
    if (url.startsWith('data:')) {
      return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
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

  /** Upload a photo to fal's storage; if that fails, send it inline as a data URL instead. */
  private async toUrl(img: EngineImage): Promise<string> {
    try {
      const url = await this.gateway.upload(img.bytes, img.mimeType);
      if (url) return url;
    } catch {
      // fall through to the inline copy
    }
    return dataUrl(img);
  }

  public async generate(input: { person: EngineImage; garment: EngineImage; category: string; prompt?: string; shopper?: ShopperFit; garmentInfo?: GarmentInfo; styleOptions?: string[] }): Promise<EngineResult> {
    const started = Date.now();
    const category = (input.category || 'tops').toLowerCase();
    if (!(SUPPORTED_CATEGORIES as readonly string[]).includes(category)) {
      throw new TryOnEngineError('UNSUPPORTED_CATEGORY', `Unsupported garment type '${category}'. Use one of: ${SUPPORTED_CATEGORIES.join(', ')}.`, false);
    }
    if (!this.isConfigured()) {
      throw new TryOnEngineError('NOT_CONFIGURED', 'Virtual try-on is not set up yet. The fal.ai key is missing.', false);
    }

    let lastError: TryOnEngineError | null = null;
    for (let attempt = 0; attempt < FAL_MAX_ATTEMPTS; attempt += 1) {
      // Two photos and one prompt: the prompt adapts to what the garment is (shirt, jeans, dress, saree ...).
      // Tries alternate between the full prompt and a much shorter one, since either can be the one the model accepts.
      const model = this.imageModel();
      const style = promptStyleForModel(model);
      const prompt = buildTryOnPrompt({ category, garment: input.garmentInfo, shopper: input.shopper, styling: input.prompt, styleOptions: input.styleOptions, compact: attempt % 2 === 1, style });
      try {
        const imageUrls = await Promise.all([this.toUrl(input.person), this.toUrl(input.garment)]);
        const { data } = await this.gateway.subscribe(
          model,
          {
            prompt,
            image_urls: imageUrls,
            num_images: 1,
            output_format: 'png',
            // FLUX edit models expand the caption using what is in the photos. The picture keeps the first photo's size.
            ...(style === 'caption' ? { enable_prompt_expansion: true } : {}),
          },
          { timeoutMs: this.jobTimeoutMs }
        );
        // The model's own safety check flagged the picture: it is blank or replaced, so do not hand it on.
        if (Array.isArray(data?.has_nsfw_concepts) && data.has_nsfw_concepts[0] === true) {
          throw new TryOnEngineError('CONTENT_BLOCKED', 'This photo or garment could not be used. Please try a different photo.', false);
        }
        const url: string | undefined = data?.images?.[0]?.url;
        if (!url) throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);

        const bytes = await this.readImage(url);
        const info = sniffImage(bytes);
        if (!info) throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);
        // The model sometimes hands back one of the photos it was given. That is not a try-on, so retry instead.
        if (sameBytes(bytes, input.person.bytes) || sameBytes(bytes, input.garment.bytes)) {
          throw new TryOnEngineError('NO_IMAGE_RETURNED', 'The picture was not changed. Please try again.', true);
        }
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
          promptVersion: PROMPT_VERSION,
          timings: { promptMs: 0, imageMs: done - started, totalMs: done - started },
        };
      } catch (err: unknown) {
        lastError = fromFalError(err);
        // A timeout already used up the wait, so do not wait again. Other failures get one more try.
        if (!lastError.retryable || lastError.code === 'TIMEOUT' || attempt === FAL_MAX_ATTEMPTS - 1) break;
        if (Date.now() - started > FAL_RETRY_BUDGET_MS) break;
        await this.sleep(1000);
      }
    }
    throw lastError ?? new TryOnEngineError('UPSTREAM_ERROR', 'Could not create the picture.', true);
  }
}

export const falTryOnEngine = new FalTryOnEngine();
