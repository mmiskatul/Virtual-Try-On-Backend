import { config } from '../../infrastructure/config.js';
import { fitInstruction, type ShopperFit } from './shopper_fit.js';

/**
 * The virtual try-on engine. It asks Google Gemini to dress the person in the garment and gives back the image.
 * This replaces the separate Python AI service: the backend now calls Gemini itself.
 *
 * Steps (kept from the old service):
 *   1. A Gemini vision model looks at both photos and writes a good fitting prompt (best effort, never blocks).
 *   2. A Gemini image model creates the picture.
 * If Gemini cannot finish, the job fails with a clear reason. A fake or composited picture is never returned.
 */

export type GeminiErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CATEGORY'
  | 'CONTENT_BLOCKED'
  | 'NO_IMAGE_RETURNED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT';

export class TryOnEngineError extends Error {
  constructor(
    public readonly code: GeminiErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'TryOnEngineError';
  }
}

export interface EngineImage {
  bytes: Buffer;
  mimeType: string;
}

export interface EngineResult {
  bytes: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  imageModel: string;
  promptModel: string;
  prompt: string;
  /** Which service made the picture. Older callers may leave it out, which means Gemini direct. */
  provider?: 'fal' | 'gemini';
  timings: { promptMs: number; imageMs: number; totalMs: number };
}

export const SUPPORTED_CATEGORIES = ['tops', 'bottoms', 'dresses', 'outerwear'] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Vision models tried (in order) to write the fitting prompt. */
const PROMPT_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

const isImageModelName = (name: string) => /image|nano-banana/i.test(name);
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: () => string;
  configuredModel?: () => string;
  imageModel?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Work out what an image is from its first bytes (we never trust a filename or a header). */
export function sniffImage(bytes: Buffer): { mimeType: string; width?: number; height?: number } | null {
  if (bytes.length < 12) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length >= 24) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk the markers until a frame header gives the size
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
    return { mimeType: 'image/jpeg' };
  }
  // WebP
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && bytes.length >= 30) {
      return { mimeType: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    return { mimeType: 'image/webp' };
  }
  return null;
}

/** Check a photo is a real, reasonably sized image and tell Gemini what kind it is. */
export function validateImage(bytes: Buffer, label: string): EngineImage {
  if (!bytes || bytes.length === 0) {
    throw new TryOnEngineError('INVALID_INPUT', `${label} is empty.`, false);
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new TryOnEngineError('INVALID_INPUT', `${label} is larger than 10 MB.`, false);
  }
  const info = sniffImage(bytes);
  if (!info) {
    throw new TryOnEngineError('INVALID_INPUT', `${label} must be a JPG, PNG or WebP image.`, false);
  }
  return { bytes, mimeType: info.mimeType };
}

const inline = (img: EngineImage) => ({ inlineData: { mimeType: img.mimeType, data: img.bytes.toString('base64') } });

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BLOCK_REASONS = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER']);

export class GeminiTryOnEngine {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getKey: () => string;
  private readonly getModel: () => string;
  private readonly getImageModel: () => string;

  constructor(deps: EngineDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? defaultSleep;
    this.getKey = deps.apiKey ?? (() => (config.geminiApiKey || '').trim());
    this.getModel = deps.configuredModel ?? (() => (config.geminiModel || '').trim());
    this.getImageModel = deps.imageModel ?? (() => (config.geminiImageModel || '').trim());
  }

  public isConfigured(): boolean {
    return Boolean(this.getKey());
  }

  /** The model that makes the picture: the configured one if it is an image model, otherwise the default image model. */
  public imageModel(): string {
    const configured = this.getModel();
    if (configured && isImageModelName(configured)) return configured;
    return this.getImageModel() || DEFAULT_IMAGE_MODEL;
  }

  public status() {
    return { configured: this.isConfigured(), imageModel: this.imageModel(), promptModel: this.promptModels()[0] };
  }

  private promptModels(): string[] {
    const configured = this.getModel();
    const textModel = configured && !isImageModelName(configured) ? configured : '';
    return [textModel, ...PROMPT_MODELS].filter((m, i, all) => m && all.indexOf(m) === i);
  }

  private async post(model: string, body: unknown, timeoutMs: number): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        // The key goes in a header, never in the URL, so it cannot appear in logs.
        headers: { 'x-goog-api-key': this.getKey(), 'Content-Type': 'application/json' },
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
      throw new TryOnEngineError(
        'UPSTREAM_ERROR',
        `The image service answered with an error (HTTP ${res.status}). ${text.slice(0, 160)}`.trim(),
        RETRYABLE_STATUS.has(res.status)
      );
    }
    return res.json();
  }

  /** Step 1: let a vision model write the fitting prompt. Best effort: any failure just uses a plain prompt. */
  private async writePrompt(person: EngineImage, garment: EngineImage, category: string, userPrompt?: string, shopper?: ShopperFit): Promise<{ prompt: string; model: string }> {
    const fallback = userPrompt || `A natural front-facing studio shot. The ${category} garment is worn naturally with realistic fabric drape.`;
    const ask = [
      'Analyze these two images and write a detailed prompt for a photorealistic fashion virtual try-on:',
      '- Image 1: the person (posture, lighting, skin tone, body proportions).',
      '- Image 2: the garment (fabric, colour, cut, collar, drape, texture, pattern).',
      `Category: ${category}.`,
      `Styling instructions: ${userPrompt || 'A natural, authentic studio shot with accurate fabric drape and a tailored fit.'}`,
      fitInstruction(shopper, category),
      'Describe how the garment from image 2 should look on the person in image 1.',
      'Output ONLY the final image prompt, with no introduction and no markdown.',
    ].filter(Boolean).join('\n');
    const body = { contents: [{ parts: [{ text: ask }, inline(person), inline(garment)] }] };

    for (const model of this.promptModels()) {
      try {
        const data = await this.post(model, body, 20_000);
        const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p.text || '').join('').trim();
        if (text) return { prompt: text.slice(0, 1500), model };
      } catch {
        // try the next model
      }
    }
    return { prompt: fallback, model: 'plain_prompt' };
  }

  /** Step 2: create the picture. Retries a couple of times when Gemini is busy. */
  private async makeImage(person: EngineImage, garment: EngineImage, category: string, prompt: string, shopper?: ShopperFit): Promise<{ bytes: Buffer; mimeType: string }> {
    const instruction =
      `Virtual try-on task: dress the person from the first image in the ${category} garment from the second image. ` +
      `Keep the person's face, body pose, skin tone and the background natural. ${fitInstruction(shopper, category)} ${prompt}`.replace(/\s+/g, ' ').trim();
    const body = {
      contents: [{ parts: [{ text: instruction }, inline(person), inline(garment)] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    };
    const model = this.imageModel();

    let lastError: TryOnEngineError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await this.post(model, body, 60_000);
        const candidate = data?.candidates?.[0];
        const parts: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> = candidate?.content?.parts || [];
        for (const part of parts) {
          const blob = part.inlineData || part.inline_data;
          if (blob?.data) {
            const bytes = Buffer.from(blob.data, 'base64');
            const info = sniffImage(bytes);
            if (info) return { bytes, mimeType: info.mimeType };
          }
        }
        const blocked = data?.promptFeedback?.blockReason || (BLOCK_REASONS.has(candidate?.finishReason) ? candidate.finishReason : '');
        if (blocked) {
          throw new TryOnEngineError('CONTENT_BLOCKED', 'This photo or garment could not be used. Please try a different photo.', false);
        }
        throw new TryOnEngineError('NO_IMAGE_RETURNED', 'No picture was created. Please try again.', true);
      } catch (err: unknown) {
        lastError = err instanceof TryOnEngineError ? err : new TryOnEngineError('UPSTREAM_ERROR', 'Could not create the picture.', true);
        if (!lastError.retryable || attempt === 2) break;
        await this.sleep(1500 * (attempt + 1));
      }
    }
    throw lastError ?? new TryOnEngineError('UPSTREAM_ERROR', 'Could not create the picture.', true);
  }

  public async generate(input: { person: EngineImage; garment: EngineImage; category: string; prompt?: string; shopper?: ShopperFit }): Promise<EngineResult> {
    const started = Date.now();
    const category = (input.category || 'tops').toLowerCase();
    if (!(SUPPORTED_CATEGORIES as readonly string[]).includes(category)) {
      throw new TryOnEngineError('UNSUPPORTED_CATEGORY', `Unsupported garment type '${category}'. Use one of: ${SUPPORTED_CATEGORIES.join(', ')}.`, false);
    }
    if (!this.isConfigured()) {
      throw new TryOnEngineError('NOT_CONFIGURED', 'Virtual try-on is not set up yet. The Gemini API key is missing.', false);
    }

    const t0 = Date.now();
    const { prompt, model: promptModel } = await this.writePrompt(input.person, input.garment, category, input.prompt, input.shopper);
    const t1 = Date.now();
    const image = await this.makeImage(input.person, input.garment, category, prompt, input.shopper);
    const t2 = Date.now();

    const info = sniffImage(image.bytes);
    return {
      bytes: image.bytes,
      mimeType: image.mimeType,
      width: info?.width,
      height: info?.height,
      imageModel: this.imageModel(),
      promptModel,
      prompt,
      provider: 'gemini',
      timings: { promptMs: t1 - t0, imageMs: t2 - t1, totalMs: Date.now() - started },
    };
  }
}

export const geminiTryOnEngine = new GeminiTryOnEngine();
