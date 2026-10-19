import crypto from 'node:crypto';

export interface IdempotencyRecord {
  key: string;
  tenantId: string;
  requestHash: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  statusCode?: number;
  responsePayload?: any;
  createdAt: number;
}

export class IdempotencyManager {
  private cache: Map<string, IdempotencyRecord> = new Map();
  private readonly ttlMs: number = 24 * 60 * 60 * 1000; // 24 Hours

  public getCompositeKey(idempotencyKey: string, tenantId: string): string {
    return `${tenantId}:${idempotencyKey}`;
  }

  public computeHash(payload: any): string {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  public getRecord(compositeKey: string): IdempotencyRecord | undefined {
    const record = this.cache.get(compositeKey);
    if (!record) return undefined;
    if (Date.now() - record.createdAt > this.ttlMs) {
      this.cache.delete(compositeKey);
      return undefined;
    }
    return record;
  }

  public startOperation(compositeKey: string, key: string, tenantId: string, requestHash: string): void {
    this.cache.set(compositeKey, {
      key,
      tenantId,
      requestHash,
      status: 'PROCESSING',
      createdAt: Date.now()
    });
  }

  public completeOperation(compositeKey: string, statusCode: number, responsePayload: any): void {
    const existing = this.cache.get(compositeKey);
    if (existing) {
      existing.status = 'COMPLETED';
      existing.statusCode = statusCode;
      existing.responsePayload = responsePayload;
    }
  }

  public failOperation(compositeKey: string): void {
    this.cache.delete(compositeKey);
  }
}

export const idempotencyManager = new IdempotencyManager();
