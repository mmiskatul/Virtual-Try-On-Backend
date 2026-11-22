import crypto from 'node:crypto';
import { storageAdapter } from '../../infrastructure/storage.adapter.js';
import {
  TryOnGenerationCompletedV1,
  TryOnGenerationFailedV1,
  TryOnGenerationRequestedV1,
} from '../../infrastructure/events.contract.js';
import { logger } from '../../infrastructure/logger.js';
import { GeminiTryOnEngine, TryOnEngineError, geminiTryOnEngine, validateImage } from './gemini.engine.js';

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Runs one try-on job inside the backend: read both photos from private storage, ask Gemini to create the picture,
 * save the picture to private storage, and return the "completed" or "failed" outcome.
 */
export async function runTryOnPipeline(
  req: TryOnGenerationRequestedV1,
  engine: GeminiTryOnEngine = geminiTryOnEngine
): Promise<TryOnGenerationCompletedV1 | TryOnGenerationFailedV1> {
  const started = Date.now();
  const failed = (code: string, message: string, retryable: boolean): TryOnGenerationFailedV1 => ({
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'tryon.generation.failed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: req.correlationId,
    generationId: req.generationId,
    error: { code, message, retryable },
    metrics: { totalTimeMs: Date.now() - started },
  });

  try {
    const [personBytes, garmentBytes] = await Promise.all([
      storageAdapter.download(req.personImage.bucket as never, req.personImage.objectKey),
      storageAdapter.download(req.garmentImage.bucket as never, req.garmentImage.objectKey),
    ]);
    const person = validateImage(personBytes, 'Your photo');
    const garment = validateImage(garmentBytes, 'The garment photo');
    const preparedAt = Date.now();

    const result = await engine.generate({ person, garment, category: req.options.category, prompt: req.options.prompt });

    const ext = EXTENSIONS[result.mimeType] || 'png';
    const objectKey = `${req.tenantId}/${req.generationId}/result.${ext}`;
    await storageAdapter.upload('generated-results', objectKey, result.bytes, result.mimeType);
    const finished = Date.now();

    return {
      eventId: `evt_${crypto.randomUUID()}`,
      eventType: 'tryon.generation.completed',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: req.correlationId,
      generationId: req.generationId,
      status: 'completed',
      result: {
        bucket: 'generated-results',
        objectKey,
        contentType: result.mimeType,
        ...(result.width && result.height ? { width: result.width, height: result.height } : {}),
      },
      metrics: {
        queueTimeMs: 0,
        preprocessingTimeMs: preparedAt - started,
        inferenceTimeMs: result.timings.totalMs,
        postprocessingTimeMs: Math.max(0, finished - preparedAt - result.timings.totalMs),
        totalTimeMs: finished - started,
      },
      model: { key: `gemini:${result.imageModel}`, version: 'v1' },
    };
  } catch (err: unknown) {
    if (err instanceof TryOnEngineError) {
      return failed(err.code, err.message, err.retryable);
    }
    logger.warn({ err: (err as Error)?.message, generationId: req.generationId }, 'tryon.pipeline_unexpected_error');
    return failed('PIPELINE_ERROR', 'Something went wrong while creating the picture. Please try again.', true);
  }
}
