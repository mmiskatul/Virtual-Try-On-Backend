import { Redis } from 'ioredis';
import { logger } from './logger.js';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export class RedisClientAdapter {
  private client: Redis | null = null;
  private connected = false;
  private fallback = new Map<string, MemoryEntry>();

  public async connect(redisUrl?: string): Promise<boolean> {
    if (!redisUrl) return false;
    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 2500,
      });
      this.client.on('error', (err: Error) => {
        if (this.connected) logger.warn({ err: err.message }, 'Redis error detected');
        this.connected = false;
      });
      await this.client.connect();
      await this.client.ping();
      this.connected = true;
      return true;
    } catch {
      this.connected = false;
      try {
        this.client?.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
      return false;
    }
  }

  public isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  public async get(key: string): Promise<string | null> {
    if (this.client && this.connected) {
      return this.client.get(key);
    }
    const item = this.fallback.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.fallback.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSec = 300): Promise<void> {
    if (this.client && this.connected) {
      await this.client.set(key, value, 'EX', ttlSec);
      return;
    }
    this.fallback.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  public async del(key: string): Promise<void> {
    if (this.client && this.connected) {
      await this.client.del(key);
      return;
    }
    this.fallback.delete(key);
  }

  public async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    if (this.client && this.connected) {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, ttlSec);
      return count;
    }
    const cur = await this.get(key);
    const next = (cur ? Number(cur) : 0) + 1;
    await this.set(key, String(next), ttlSec);
    return next;
  }

  public async health(): Promise<{ driver: 'redis' | 'memory_fallback'; ok: boolean }> {
    if (this.client && this.connected) {
      try {
        const res = await this.client.ping();
        return { driver: 'redis', ok: res === 'PONG' };
      } catch {
        return { driver: 'redis', ok: false };
      }
    }
    return { driver: 'memory_fallback', ok: true };
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => this.client?.disconnect());
      this.client = null;
      this.connected = false;
    }
  }
}

export const redisAdapter = new RedisClientAdapter();

