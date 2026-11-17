import { timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service authentication between the backend and the AI service.
 * The shared secret (INTERNAL_SERVICE_KEY) is sent in this header on every call to the AI service.
 */
export const SERVICE_KEY_HEADER = 'x-service-key';

/** Headers for a backend -> AI service request. */
export function aiServiceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = (process.env.INTERNAL_SERVICE_KEY || '').trim();
  return key ? { ...extra, [SERVICE_KEY_HEADER]: key } : { ...extra };
}

/** Constant-time comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
