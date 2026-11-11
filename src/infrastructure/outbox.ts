import crypto from 'node:crypto';
import { getGlobalPrisma } from './prisma.js';
import { rabbitMqBus } from './rabbitmq.js';
import { logger } from './logger.js';

export interface OutboxEnqueueInput {
  eventType: string;
  eventVersion?: number;
  aggregateId: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

/**
 * Persists an outbox event row using the active Prisma transaction or global Prisma client.
 * Guarantees committed database writes are never silently lost before RabbitMQ delivery.
 */
export async function enqueueOutboxEvent(
  txOrPrisma: any,
  input: OutboxEnqueueInput
): Promise<{ id: string }> {
  const row = await txOrPrisma.outboxEvent.create({
    data: {
      id: crypto.randomUUID(),
      eventType: input.eventType,
      eventVersion: input.eventVersion ?? 1,
      aggregateId: input.aggregateId,
      correlationId: input.correlationId,
      payload: input.payload,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  });
  return { id: row.id };
}

/**
 * Marks an incoming consumer eventId as processed atomically to guarantee idempotent consumption.
 * Returns `false` if this eventId was already processed (duplicate delivery).
 */
export async function claimEventIdempotency(eventId: string, eventType: string): Promise<boolean> {
  const prisma = getGlobalPrisma();
  if (!prisma) return true;
  try {
    await prisma.processedEvent.create({
      data: { eventId, eventType },
    });
    return true;
  } catch (err: any) {
    // Prisma P2002 unique violation => duplicate event already consumed
    if (err?.code === 'P2002') {
      return false;
    }
    throw err;
  }
}

export class OutboxRelayWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushBatch();
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async flushBatch(limit = 25): Promise<number> {
    if (this.running) return 0;
    const prisma = getGlobalPrisma();
    if (!prisma || !rabbitMqBus.isConnected()) return 0;

    this.running = true;
    let publishedCount = 0;
    try {
      const due = await prisma.outboxEvent.findMany({
        where: {
          status: 'PENDING',
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });

      for (const evt of due) {
        try {
          const ok = await rabbitMqBus.publish(
            evt.eventType,
            evt.payload as Record<string, unknown>,
            evt.correlationId
          );
          if (ok) {
            await prisma.outboxEvent.update({
              where: { id: evt.id },
              data: { status: 'PUBLISHED', publishedAt: new Date() },
            });
            publishedCount++;
          }
        } catch (err: any) {
          const nextAttempts = evt.attempts + 1;
          const backoffMs = Math.min(60_000, Math.pow(2, nextAttempts) * 1000);
          await prisma.outboxEvent.update({
            where: { id: evt.id },
            data: {
              attempts: nextAttempts,
              status: nextAttempts >= 5 ? 'DEAD_LETTER' : 'PENDING',
              nextAttemptAt: new Date(Date.now() + backoffMs),
              lastError: String(err?.message || err),
            },
          });
          logger.warn({ eventId: evt.id, nextAttempts }, 'Outbox relay delivery failed, scheduled retry');
        }
      }
    } finally {
      this.running = false;
    }
    return publishedCount;
  }
}

export const outboxRelayWorker = new OutboxRelayWorker();

