import { z } from 'zod';

export const StorageObjectRefSchema = z.object({
  bucket: z.string().min(1),
  objectKey: z.string().min(1),
  contentType: z.string().min(1).default('image/jpeg'),
});

export const TryOnGenerationRequestedV1Schema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('tryon.generation.requested'),
  eventVersion: z.literal(1),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
  generationId: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  personImage: StorageObjectRefSchema,
  garmentImage: StorageObjectRefSchema,
  modelConfig: z.object({
    modelKey: z.string().min(1).default('default-tryon'),
    modelVersion: z.string().min(1).default('v1'),
  }),
  options: z.object({
    category: z.string().min(1).default('tops'),
    quality: z.enum(['fast_preview', 'standard', 'high_fidelity']).default('standard'),
    prompt: z.string().optional(),
    // Who is trying it on (checked values only): used so the garment fits the way their size would.
    gender: z.enum(['female', 'male']).optional(),
    size: z.string().max(8).optional(),
    garmentSize: z.string().max(8).optional(),
    // What the shop knows about the garment (read from the catalogue on the server), so the prompt can describe it.
    garmentInfo: z
      .object({
        name: z.string().max(100).optional(),
        type: z.string().max(60).optional(),
        colour: z.string().max(40).optional(),
        fabric: z.string().max(120).optional(),
        pattern: z.string().max(60).optional(),
        details: z.string().max(240).optional(),
        specs: z.record(z.string(), z.string().max(60)).optional(),
        audience: z.enum(['women', 'men', 'both']).optional(),
        tags: z.array(z.string().max(30)).max(10).optional(),
      })
      .optional(),
  }),
});

export const TryOnGenerationCompletedV1Schema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('tryon.generation.completed'),
  eventVersion: z.literal(1),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
  generationId: z.string().min(1),
  status: z.literal('completed'),
  result: StorageObjectRefSchema.extend({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    /** A permanent link to the picture on Cloudinary, when Cloudinary is set up. The private copy is kept too. */
    publicUrl: z.string().url().optional(),
  }),
  metrics: z.object({
    queueTimeMs: z.number().nonnegative().default(0),
    preprocessingTimeMs: z.number().nonnegative().default(0),
    inferenceTimeMs: z.number().nonnegative().default(0),
    postprocessingTimeMs: z.number().nonnegative().default(0),
    totalTimeMs: z.number().nonnegative().default(0),
  }),
  model: z.object({
    key: z.string().min(1),
    version: z.string().min(1),
  }),
});

export const TryOnGenerationFailedV1Schema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('tryon.generation.failed'),
  eventVersion: z.literal(1),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
  generationId: z.string().min(1),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().default(false),
  }),
  metrics: z.object({
    totalTimeMs: z.number().nonnegative().default(0),
  }),
});

export const PlatformTestPingV1Schema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('platform.test.ping'),
  eventVersion: z.literal(1),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type TryOnGenerationRequestedV1 = z.infer<typeof TryOnGenerationRequestedV1Schema>;
export type TryOnGenerationCompletedV1 = z.infer<typeof TryOnGenerationCompletedV1Schema>;
export type TryOnGenerationFailedV1 = z.infer<typeof TryOnGenerationFailedV1Schema>;
export type PlatformTestPingV1 = z.infer<typeof PlatformTestPingV1Schema>;

