import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getValidatedEnv } from './env.schema.js';

export type LogicalBucket =
  | 'customer-uploads'
  | 'brand-assets'
  | 'garment-processing'
  | 'generated-results'
  | 'temporary';

export interface StoredObjectMeta {
  bucket: LogicalBucket;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  etag?: string;
}

export interface StorageAdapter {
  readonly driverName: 'supabase' | 'local_private';
  upload(bucket: LogicalBucket, objectKey: string, buffer: Buffer, contentType: string): Promise<StoredObjectMeta>;
  download(bucket: LogicalBucket, objectKey: string): Promise<Buffer>;
  delete(bucket: LogicalBucket, objectKey: string): Promise<void>;
  exists(bucket: LogicalBucket, objectKey: string): Promise<boolean>;
  createSignedUploadUrl(bucket: LogicalBucket, objectKey: string, contentType: string, expiresInSec?: number): Promise<{ url: string; method: 'PUT' | 'POST'; expiresAt: string; headers?: Record<string, string> }>;
  createSignedDownloadUrl(bucket: LogicalBucket, objectKey: string, expiresInSec?: number): Promise<{ url: string; expiresAt: string }>;
  copy(srcBucket: LogicalBucket, srcKey: string, destBucket: LogicalBucket, destKey: string): Promise<void>;
  getMetadata(bucket: LogicalBucket, objectKey: string): Promise<StoredObjectMeta | null>;
  health(): Promise<{ ok: boolean; driver: string }>;
}

function sanitizeObjectKey(objectKey: string): string {
  const cleaned = objectKey.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) {
    throw new Error('Invalid objectKey path traversal sequence rejected.');
  }
  return cleaned;
}

export function signStorageToken(bucket: string, objectKey: string, op: 'read' | 'write', expEpochSec: number): string {
  const secret = getValidatedEnv().JWT_SECRET;
  const payload = `${op}:${bucket}:${objectKey}:${expEpochSec}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyStorageToken(bucket: string, objectKey: string, op: 'read' | 'write', expEpochSec: number, sig: string): boolean {
  if (Date.now() / 1000 > expEpochSec) return false;
  const expected = signStorageToken(bucket, objectKey, op, expEpochSec);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Private Local Object Store (writes outside web-accessible static directories)
 * Used when external Supabase Storage keys are absent, issuing HMAC-signed Fastify URLs.
 */
class LocalPrivateStorageDriver implements StorageAdapter {
  public readonly driverName = 'local_private' as const;
  private rootDir = path.resolve(process.cwd(), '.data', 'private_objects');

  private resolvePath(bucket: LogicalBucket, objectKey: string): string {
    const safeKey = sanitizeObjectKey(objectKey);
    const target = path.resolve(this.rootDir, bucket, safeKey);
    if (!target.startsWith(path.resolve(this.rootDir, bucket))) {
      throw new Error('Object key escapes private bucket directory.');
    }
    return target;
  }

  public async upload(bucket: LogicalBucket, objectKey: string, buffer: Buffer, contentType: string): Promise<StoredObjectMeta> {
    const target = this.resolvePath(bucket, objectKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    await fs.writeFile(`${target}.meta.json`, JSON.stringify({ contentType, sizeBytes: buffer.length }), 'utf8');
    return {
      bucket,
      objectKey: sanitizeObjectKey(objectKey),
      contentType,
      sizeBytes: buffer.length,
      etag: crypto.createHash('md5').update(buffer).digest('hex'),
    };
  }

  public async download(bucket: LogicalBucket, objectKey: string): Promise<Buffer> {
    const target = this.resolvePath(bucket, objectKey);
    return fs.readFile(target);
  }

  public async delete(bucket: LogicalBucket, objectKey: string): Promise<void> {
    const target = this.resolvePath(bucket, objectKey);
    await fs.rm(target, { force: true });
    await fs.rm(`${target}.meta.json`, { force: true });
  }

  public async exists(bucket: LogicalBucket, objectKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(bucket, objectKey));
      return true;
    } catch {
      return false;
    }
  }

  public async createSignedUploadUrl(bucket: LogicalBucket, objectKey: string, contentType: string, expiresInSec = 300) {
    const cleanKey = sanitizeObjectKey(objectKey);
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const sig = signStorageToken(bucket, cleanKey, 'write', exp);
    const base = getValidatedEnv().PUBLIC_BACKEND_URL.replace(/\/+$/, '');
    const qs = new URLSearchParams({ bucket, key: cleanKey, exp: String(exp), sig });
    return {
      url: `${base}/api/v1/storage/signed-upload?${qs}`,
      method: 'PUT' as const,
      expiresAt: new Date(exp * 1000).toISOString(),
      headers: { 'Content-Type': contentType },
    };
  }

  public async createSignedDownloadUrl(bucket: LogicalBucket, objectKey: string, expiresInSec = 300) {
    const cleanKey = sanitizeObjectKey(objectKey);
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const sig = signStorageToken(bucket, cleanKey, 'read', exp);
    const base = getValidatedEnv().PUBLIC_BACKEND_URL.replace(/\/+$/, '');
    const qs = new URLSearchParams({ bucket, key: cleanKey, exp: String(exp), sig });
    return {
      url: `${base}/api/v1/storage/signed-download?${qs}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  public async copy(srcBucket: LogicalBucket, srcKey: string, destBucket: LogicalBucket, destKey: string): Promise<void> {
    const buf = await this.download(srcBucket, srcKey);
    const meta = await this.getMetadata(srcBucket, srcKey);
    await this.upload(destBucket, destKey, buf, meta?.contentType || 'application/octet-stream');
  }

  public async getMetadata(bucket: LogicalBucket, objectKey: string): Promise<StoredObjectMeta | null> {
    try {
      const target = this.resolvePath(bucket, objectKey);
      const stat = await fs.stat(target);
      let contentType = 'application/octet-stream';
      try {
        const meta = JSON.parse(await fs.readFile(`${target}.meta.json`, 'utf8'));
        contentType = meta.contentType || contentType;
      } catch {
        // default
      }
      return {
        bucket,
        objectKey: sanitizeObjectKey(objectKey),
        contentType,
        sizeBytes: stat.size,
      };
    } catch {
      return null;
    }
  }

  public async health() {
    await fs.mkdir(this.rootDir, { recursive: true });
    return { ok: true, driver: this.driverName };
  }
}

/**
 * Private Supabase Storage REST Adapter (never exposes service-role key to frontends).
 */
class SupabaseStorageDriver implements StorageAdapter {
  public readonly driverName = 'supabase' as const;

  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string
  ) {}

  private authHeaders(extra?: Record<string, string>) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...(extra || {}),
    };
  }

  public async upload(bucket: LogicalBucket, objectKey: string, buffer: Buffer, contentType: string): Promise<StoredObjectMeta> {
    const cleanKey = sanitizeObjectKey(objectKey);
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/${bucket}/${cleanKey}`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      throw new Error(`Supabase upload failed (${res.status}): ${await res.text()}`);
    }
    return { bucket, objectKey: cleanKey, contentType, sizeBytes: buffer.length };
  }

  public async download(bucket: LogicalBucket, objectKey: string): Promise<Buffer> {
    const cleanKey = sanitizeObjectKey(objectKey);
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/${bucket}/${cleanKey}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Supabase download failed (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  public async delete(bucket: LogicalBucket, objectKey: string): Promise<void> {
    const cleanKey = sanitizeObjectKey(objectKey);
    await fetch(`${this.supabaseUrl}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [cleanKey] }),
    });
  }

  public async exists(bucket: LogicalBucket, objectKey: string): Promise<boolean> {
    const meta = await this.getMetadata(bucket, objectKey);
    return meta !== null;
  }

  public async createSignedUploadUrl(bucket: LogicalBucket, objectKey: string, contentType: string, expiresInSec = 300) {
    const cleanKey = sanitizeObjectKey(objectKey);
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${cleanKey}`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSec }),
    });
    if (!res.ok) throw new Error(`Supabase signed upload URL failed (${res.status})`);
    const data: any = await res.json();
    const signedPath = data.url?.startsWith('http') ? data.url : `${this.supabaseUrl}/storage/v1${data.url}`;
    return {
      url: signedPath,
      method: 'PUT' as const,
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      headers: { 'Content-Type': contentType },
    };
  }

  public async createSignedDownloadUrl(bucket: LogicalBucket, objectKey: string, expiresInSec = 300) {
    const cleanKey = sanitizeObjectKey(objectKey);
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/sign/${bucket}/${cleanKey}`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSec }),
    });
    if (!res.ok) throw new Error(`Supabase signed download URL failed (${res.status})`);
    const data: any = await res.json();
    const signedUrl = data.signedURL?.startsWith('http')
      ? data.signedURL
      : `${this.supabaseUrl}/storage/v1${data.signedURL}`;
    return {
      url: signedUrl,
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    };
  }

  public async copy(srcBucket: LogicalBucket, srcKey: string, destBucket: LogicalBucket, destKey: string): Promise<void> {
    const buf = await this.download(srcBucket, srcKey);
    await this.upload(destBucket, destKey, buf, 'image/jpeg');
  }

  public async getMetadata(bucket: LogicalBucket, objectKey: string): Promise<StoredObjectMeta | null> {
    const cleanKey = sanitizeObjectKey(objectKey);
    const res = await fetch(`${this.supabaseUrl}/storage/v1/object/info/${bucket}/${cleanKey}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      bucket,
      objectKey: cleanKey,
      contentType: json.metadata?.mimetype || 'application/octet-stream',
      sizeBytes: Number(json.metadata?.size || 0),
    };
  }

  public async health() {
    try {
      const res = await fetch(`${this.supabaseUrl}/storage/v1/bucket`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      return { ok: res.ok, driver: this.driverName };
    } catch {
      return { ok: false, driver: this.driverName };
    }
  }
}

export function createStorageAdapter(): StorageAdapter {
  const env = getValidatedEnv();
  if (
    (env.STORAGE_DRIVER === 'supabase' || env.STORAGE_DRIVER === 'auto') &&
    env.SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return new SupabaseStorageDriver(env.SUPABASE_URL.replace(/\/+$/, ''), env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return new LocalPrivateStorageDriver();
}

export const storageAdapter: StorageAdapter = createStorageAdapter();

