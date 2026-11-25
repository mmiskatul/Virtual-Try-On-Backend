import { config } from '../../infrastructure/config.js';
import { logger } from '../../infrastructure/logger.js';
import { TryOnEngineError, geminiTryOnEngine, type EngineImage, type EngineResult, type GeminiTryOnEngine } from './gemini.engine.js';
import { falTryOnEngine, type FalTryOnEngine } from './fal.engine.js';
import type { ShopperFit } from './shopper_fit.js';
import type { GarmentInfo } from './tryon_prompt.js';

export interface TryOnInput {
  person: EngineImage;
  garment: EngineImage;
  category: string;
  prompt?: string;
  shopper?: ShopperFit;
  /** What the shop knows about the garment, so the prompt can describe it. */
  garmentInfo?: GarmentInfo;
  /** Styling choices (ids from STYLE_OPTIONS), for example tucked_in or sleeves_rolled. */
  styleOptions?: string[];
}

/** What the pipeline needs from an engine. Both the Gemini engine and the fal engine fit this. */
export interface TryOnEngine {
  isConfigured(): boolean;
  imageModel(): string;
  status(): { configured: boolean; imageModel: string; promptModel?: string; provider?: string };
  generate(input: TryOnInput): Promise<EngineResult>;
}

export type ProviderMode = 'auto' | 'fal' | 'gemini';

/** Failures that would happen again with any provider, so there is no point trying the other one. */
const NO_FALLBACK = new Set(['INVALID_INPUT', 'UNSUPPORTED_CATEGORY', 'CONTENT_BLOCKED']);

/**
 * Picks who makes the picture, following TRYON_PROVIDER from the .env file:
 *   auto   - fal.ai first when FAL_KEY is set; if fal fails for a reason about fal (busy, timeout, bad key) and a Gemini
 *            key exists, the same job is retried on Gemini direct. With no FAL_KEY it is Gemini direct only.
 *   fal    - fal.ai only, no fallback.
 *   gemini - Gemini direct only.
 * The keys and model names are read by the engines from the .env file; nothing is stored in code.
 */
export class TryOnEngineSelector implements TryOnEngine {
  constructor(
    private readonly fal: Pick<FalTryOnEngine, 'isConfigured' | 'imageModel' | 'generate'> = falTryOnEngine,
    private readonly gemini: Pick<GeminiTryOnEngine, 'isConfigured' | 'imageModel' | 'generate' | 'status'> = geminiTryOnEngine,
    private readonly getMode: () => ProviderMode = () => config.tryonProvider
  ) {}

  /** The service that is tried first. */
  public provider(): 'fal' | 'gemini' {
    const mode = this.getMode();
    if (mode === 'fal') return 'fal';
    if (mode === 'gemini') return 'gemini';
    return this.fal.isConfigured() ? 'fal' : 'gemini';
  }

  /** The service used when the first one fails, or null when there is none. Only `auto` falls back. */
  public fallback(): 'gemini' | null {
    return this.getMode() === 'auto' && this.provider() === 'fal' && this.gemini.isConfigured() ? 'gemini' : null;
  }

  public isConfigured(): boolean {
    return this.provider() === 'fal' ? this.fal.isConfigured() : this.gemini.isConfigured();
  }

  public imageModel(): string {
    return this.provider() === 'fal' ? this.fal.imageModel() : this.gemini.imageModel();
  }

  public status() {
    const provider = this.provider();
    return {
      mode: this.getMode(),
      configured: this.isConfigured(),
      imageModel: this.imageModel(),
      promptModel: provider === 'fal' ? 'direct' : this.gemini.status().promptModel,
      provider,
      fallback: this.fallback(),
      fal: { configured: this.fal.isConfigured(), imageModel: this.fal.imageModel() },
      gemini: { configured: this.gemini.isConfigured(), imageModel: this.gemini.imageModel() },
    };
  }

  public async generate(input: TryOnInput): Promise<EngineResult> {
    if (this.provider() === 'gemini') return this.gemini.generate(input);
    try {
      return await this.fal.generate(input);
    } catch (err: unknown) {
      if (!this.fallback() || !(err instanceof TryOnEngineError) || NO_FALLBACK.has(err.code)) throw err;
      logger.warn({ code: err.code, message: err.message }, 'tryon.fal_failed_using_gemini');
      return this.gemini.generate(input);
    }
  }
}

export const tryOnEngine = new TryOnEngineSelector();
