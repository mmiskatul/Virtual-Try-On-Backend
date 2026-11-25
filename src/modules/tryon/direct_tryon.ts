import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../../infrastructure/config.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { storageAdapter } from '../../infrastructure/storage.adapter.js';
import type { ShopperFit } from './shopper_fit.js';
import { MAX_IMAGE_BYTES, TryOnEngineError, validateImage, type EngineImage } from './gemini.engine.js';
import { tryOnEngine } from './tryon.engine.js';
import type { GarmentInfo } from './tryon_prompt.js';

/**
 * One-step try-on for the marketplace routes (/try-on/direct and /try-on/submit).
 * The shopper's photo and the garment arrive as a data URL or a public https link; the picture is created
 * straight away by Gemini and hosted for the shopper to see.
 */

const DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i;

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:127.') || v6.startsWith('::ffff:10.');
}

/** Only public https addresses are fetched, so a shopper can never make the server read internal services. */
async function assertPublicHttps(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TryOnEngineError('INVALID_INPUT', 'An image link was not valid.', false);
  }
  if (url.protocol !== 'https:') throw new TryOnEngineError('INVALID_INPUT', 'Image links must use https.', false);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new TryOnEngineError('INVALID_INPUT', 'That image link is not allowed.', false);
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new TryOnEngineError('INVALID_INPUT', 'That image link is not allowed.', false);
  }
  return url;
}

/** Turn a data URL or a public https link into a checked image. */
export async function loadImageInput(value: unknown, label: string): Promise<EngineImage> {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TryOnEngineError('INVALID_INPUT', `${label} is required.`, false);
  }
  const raw = value.trim();
  const data = DATA_URL.exec(raw);
  if (data) return validateImage(Buffer.from(data[2], 'base64'), label);

  const url = await assertPublicHttps(raw);
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res || !res.ok) throw new TryOnEngineError('INVALID_INPUT', `${label} could not be downloaded.`, false);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) throw new TryOnEngineError('INVALID_INPUT', `${label} is larger than 10 MB.`, false);
  return validateImage(Buffer.from(await res.arrayBuffer()), label);
}

export interface HostedResult {
  url: string;
  storage: 'cloudinary' | 'private_storage';
  bucket?: 'generated-results';
  objectKey?: string;
}

/** Results of recent one-step jobs, so the status route can show them again. Kept small on purpose. */
const recent = new Map<string, { status: 'COMPLETED' | 'FAILED'; result?: HostedResult; error?: { code: string; message: string } }>();
const MAX_RECENT = 500;
export function rememberDirectResult(jobId: string, entry: { status: 'COMPLETED' | 'FAILED'; result?: HostedResult; error?: { code: string; message: string } }) {
  recent.set(jobId, entry);
  if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value as string);
}
export const getDirectResult = (jobId: string) => recent.get(jobId);

/** Save the picture where the shopper can see it: Cloudinary when it is set up, otherwise private storage with a link that expires. */
export async function hostResult(jobId: string, tenantId: string, bytes: Buffer, mimeType: string): Promise<HostedResult> {
  if (cloudinaryStorage.isConfigured()) {
    const url = await cloudinaryStorage.uploadBuffer(bytes, {
      publicId: `tryon_res_${jobId}`,
      folder: `${config.cloudinaryFolder}/results`,
      tags: ['virtual-try-on', 'generated-result', jobId],
    });
    if (url) return { url, storage: 'cloudinary' };
  }
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const objectKey = `${tenantId}/${jobId}/result.${ext}`;
  await storageAdapter.upload('generated-results', objectKey, bytes, mimeType);
  const signed = await storageAdapter.createSignedDownloadUrl('generated-results', objectKey, 3600);
  return { url: signed.url, storage: 'private_storage', bucket: 'generated-results', objectKey };
}

/** A fresh link for a result that is kept in private storage (the first one expires). */
export async function refreshResultUrl(result: HostedResult): Promise<string> {
  if (result.storage === 'private_storage' && result.bucket && result.objectKey) {
    return (await storageAdapter.createSignedDownloadUrl(result.bucket, result.objectKey, 3600)).url;
  }
  return result.url;
}

export async function runDirectTryOn(input: {
  jobId: string;
  tenantId: string;
  personImage: unknown;
  garmentImage: unknown;
  category: string;
  prompt?: string;
  shopper?: ShopperFit;
  garmentInfo?: GarmentInfo;
  styleOptions?: string[];
}) {
  const [person, garment] = await Promise.all([loadImageInput(input.personImage, 'Your photo'), loadImageInput(input.garmentImage, 'The garment photo')]);
  const generated = await tryOnEngine.generate({ person, garment, category: input.category, prompt: input.prompt, shopper: input.shopper, garmentInfo: input.garmentInfo, styleOptions: input.styleOptions });
  const hosted = await hostResult(input.jobId, input.tenantId, generated.bytes, generated.mimeType);
  return { generated, hosted };
}

/** The HTTP status that fits each kind of failure. */
export function httpStatusFor(err: TryOnEngineError): number {
  switch (err.code) {
    case 'INVALID_INPUT':
    case 'UNSUPPORTED_CATEGORY':
      return 400;
    case 'CONTENT_BLOCKED':
      return 422;
    case 'NOT_CONFIGURED':
      return 503;
    case 'TIMEOUT':
      return 504;
    default:
      return 502;
  }
}
