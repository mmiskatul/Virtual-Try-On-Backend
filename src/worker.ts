import { getValidatedEnv } from './infrastructure/env.schema.js';
import { logger } from './infrastructure/logger.js';
import { initGlobalPrisma, disconnectPrisma } from './infrastructure/prisma.js';
import {
  QUEUE_GENERATION_RESULTS,
  rabbitMqBus,
} from './infrastructure/rabbitmq.js';
import { redisAdapter } from './infrastructure/redis.js';
import {
  claimEventIdempotency,
  outboxRelayWorker,
} from './infrastructure/outbox.js';
import {
  TryOnGenerationCompletedV1Schema,
  TryOnGenerationFailedV1Schema,
} from './infrastructure/events.contract.js';
import { getGlobalPrisma } from './infrastructure/prisma.js';

async function startWorker() {
  const env = getValidatedEnv();
  logger.info('Booting V-TRY Fastify background Outbox + Result Worker...');

  if (env.DATABASE_URL) {
    initGlobalPrisma(env.DATABASE_URL);
  }
  await redisAdapter.connect(env.REDIS_URL);
  const amqpOk = await rabbitMqBus.connect(env.RABBITMQ_URL);

  if (amqpOk) {
    await rabbitMqBus.consume(QUEUE_GENERATION_RESULTS, async (rawEvent) => {
      const eventType = String(rawEvent?.eventType || '');
      const eventId = String(rawEvent?.eventId || '');
      if (!eventId) return;

      const claimed = await claimEventIdempotency(eventId, eventType);
      if (!claimed) {
        logger.info({ eventId }, 'Duplicate completion/failure event skipped idempotently');
        return;
      }

      const prisma = getGlobalPrisma();
      if (!prisma) return;

      if (eventType === 'tryon.generation.completed') {
        const evt = TryOnGenerationCompletedV1Schema.parse(rawEvent);
        await prisma.$transaction(async (tx) => {
          await tx.generationJob.updateMany({
            where: { id: evt.generationId, status: { not: 'COMPLETED' } },
            data: {
              status: 'COMPLETED',
              resultBucket: evt.result.bucket,
              resultObjectKey: evt.result.objectKey,
              latencyMs: Math.round(evt.metrics.totalTimeMs),
              modelKey: evt.model.key,
              modelVersion: evt.model.version,
              updatedAt: BigInt(Date.now()),
            },
          });
          await tx.usageLedger.updateMany({
            where: { generationId: evt.generationId, status: 'RESERVED' },
            data: { finalUnits: 1, status: 'CONSUMED', updatedAt: BigInt(Date.now()) },
          });
        });
        logger.info({ generationId: evt.generationId }, 'Settled completed try-on generation');
      } else if (eventType === 'tryon.generation.failed') {
        const evt = TryOnGenerationFailedV1Schema.parse(rawEvent);
        await prisma.$transaction(async (tx) => {
          await tx.generationJob.updateMany({
            where: { id: evt.generationId, status: { notIn: ['COMPLETED', 'FAILED'] } },
            data: {
              status: 'FAILED',
              errorCode: evt.error.code,
              errorMessage: evt.error.message,
              latencyMs: Math.round(evt.metrics.totalTimeMs),
              updatedAt: BigInt(Date.now()),
            },
          });
          await tx.usageLedger.updateMany({
            where: { generationId: evt.generationId, status: 'RESERVED' },
            data: { finalUnits: 0, status: 'RELEASED', updatedAt: BigInt(Date.now()) },
          });
        });
        logger.info({ generationId: evt.generationId }, 'Released credit reservation on failed generation');
      }
    });
  }

  outboxRelayWorker.start(2000);

  const shutdown = async () => {
    logger.info('Shutting down Fastify worker cleanly...');
    outboxRelayWorker.stop();
    await rabbitMqBus.close();
    await redisAdapter.disconnect();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startWorker().catch((err) => {
  logger.error({ err }, 'Worker crashed during boot');
  process.exit(1);
});

