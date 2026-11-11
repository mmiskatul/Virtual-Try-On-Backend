import amqplib, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';

export const VTON_EXCHANGE = 'vton.events';
export const VTON_DLX = 'vton.dlx';
export const QUEUE_GENERATION_REQUESTS = 'tryon.generation.requests';
export const QUEUE_GENERATION_RESULTS = 'tryon.generation.results';
export const QUEUE_GENERATION_DLQ = 'tryon.generation.dlq';
export const QUEUE_NOTIFICATIONS = 'platform.notifications.outbox';

export class RabbitMqBus {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connected = false;

  public async connect(amqpUrl?: string): Promise<boolean> {
    if (!amqpUrl) return false;
    try {
      const conn = await amqplib.connect(amqpUrl, { timeout: 3000 });
      const ch = await conn.createChannel();
      await ch.prefetch(5);

      await ch.assertExchange(VTON_DLX, 'topic', { durable: true });
      await ch.assertExchange(VTON_EXCHANGE, 'topic', { durable: true });

      await ch.assertQueue(QUEUE_GENERATION_DLQ, { durable: true });
      await ch.bindQueue(QUEUE_GENERATION_DLQ, VTON_DLX, '#');

      await ch.assertQueue(QUEUE_GENERATION_REQUESTS, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': VTON_DLX,
          'x-dead-letter-routing-key': 'dlq.tryon.requested',
        },
      });
      await ch.bindQueue(QUEUE_GENERATION_REQUESTS, VTON_EXCHANGE, 'tryon.generation.requested');

      await ch.assertQueue(QUEUE_GENERATION_RESULTS, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': VTON_DLX,
          'x-dead-letter-routing-key': 'dlq.tryon.result',
        },
      });
      await ch.bindQueue(QUEUE_GENERATION_RESULTS, VTON_EXCHANGE, 'tryon.generation.completed');
      await ch.bindQueue(QUEUE_GENERATION_RESULTS, VTON_EXCHANGE, 'tryon.generation.failed');
      await ch.bindQueue(QUEUE_GENERATION_RESULTS, VTON_EXCHANGE, 'tryon.generation.progress');

      await ch.assertQueue(QUEUE_NOTIFICATIONS, { durable: true });
      await ch.bindQueue(QUEUE_NOTIFICATIONS, VTON_EXCHANGE, 'platform.notification.#');

      conn.on('close', () => {
        this.connected = false;
      });
      conn.on('error', (err) => {
        logger.warn({ err: err.message }, 'RabbitMQ connection error');
        this.connected = false;
      });

      this.connection = conn;
      this.channel = ch;
      this.connected = true;
      return true;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'RabbitMQ unavailable; outbox relay will stay paused until broker connects');
      this.connected = false;
      return false;
    }
  }

  public isConnected(): boolean {
    return this.connected && this.channel !== null;
  }

  public async publish(routingKey: string, event: Record<string, unknown>, correlationId: string): Promise<boolean> {
    if (!this.channel || !this.connected) return false;
    const ok = this.channel.publish(
      VTON_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(event), 'utf8'),
      {
        persistent: true,
        contentType: 'application/json',
        correlationId,
        messageId: String(event.eventId || ''),
        timestamp: Date.now(),
      }
    );
    return ok;
  }

  public async consume(
    queue: string,
    handler: (payload: any, msg: ConsumeMessage) => Promise<void>
  ): Promise<void> {
    if (!this.channel || !this.connected) return;
    await this.channel.consume(queue, async (msg) => {
      if (!msg) return;
      const retries = Number(msg.properties.headers?.['x-retry-count'] || 0);
      try {
        const parsed = JSON.parse(msg.content.toString('utf8'));
        await handler(parsed, msg);
        this.channel?.ack(msg);
      } catch (err: any) {
        logger.error({ queue, retries, err: err?.message }, 'Consumer message handling failed');
        if (retries < 3 && this.channel) {
          this.channel.ack(msg);
          this.channel.sendToQueue(queue, msg.content, {
            persistent: true,
            correlationId: msg.properties.correlationId,
            headers: { ...(msg.properties.headers || {}), 'x-retry-count': retries + 1 },
          });
        } else {
          // Exceeded bounded retries -> route to DLX/DLQ without requeue loop
          this.channel?.nack(msg, false, false);
        }
      }
    });
  }

  public async close(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // ignore
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore
    }
    this.channel = null;
    this.connection = null;
    this.connected = false;
  }
}

export const rabbitMqBus = new RabbitMqBus();

