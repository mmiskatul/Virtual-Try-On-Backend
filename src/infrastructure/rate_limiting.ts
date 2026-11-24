import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Request throttling for the public API.
 *  - Per-IP limits, with much stricter limits on authentication and anonymous try-on routes.
 *  - Per-account lockout after repeated failed logins.
 *  (One-time-code guessing is already limited per email by the auth service.)
 * State is in memory (per instance). Set RATE_LIMIT_DISABLED=true only in automated tests.
 */

const disabled = () => process.env.RATE_LIMIT_DISABLED === 'true';

interface Category {
  name: string;
  max: number;
}

const AUTH_SENSITIVE =
  /\/auth\/(login|register|oauth-exchange|oauth-google|verify-email|resend-verification|forgot-password|verify-reset-token|reset-password|check-email|change-password|accept-invite)$/;
const AUTH_REFRESH = /\/auth\/refresh$/;
const TRYON_PUBLIC = /^\/api\/v1\/try-on\/(direct|submit|upload|upload-url|jobs)$/;

function categoryOf(req: FastifyRequest): Category {
  const path = req.url.split('?')[0];
  if (path.startsWith('/api/v1/public/')) return { name: 'public-api', max: 300 };
  if (req.method === 'POST' && AUTH_SENSITIVE.test(path)) return { name: 'auth', max: 10 };
  if (req.method === 'POST' && AUTH_REFRESH.test(path)) return { name: 'refresh', max: 30 };
  if (req.method === 'POST' && TRYON_PUBLIC.test(path)) return { name: 'tryon', max: 12 };
  return { name: 'default', max: 600 };
}

export function registerRateLimiting(app: FastifyInstance): void {
  app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    max: (req: FastifyRequest) => categoryOf(req).max,
    keyGenerator: (req: FastifyRequest) => {
      const cat = categoryOf(req);
      // Always bucket by IP only. Putting the client-supplied API key in the bucket would let an attacker
      // rotate fake keys to get a fresh limit on every request.
      return `${cat.name}:${req.ip}`;
    },
    allowList: (req: FastifyRequest) => {
      if (disabled()) return true;
      const path = req.url.split('?')[0];
      return path === '/live' || path === '/ready' || path === '/health';
    },
    errorResponseBuilder: (_req: FastifyRequest, context: { after: string }) => ({
      statusCode: 429,
      error: 'TooManyRequests',
      code: 'RATE_LIMITED',
      message: `Too many requests. Please try again in ${context.after}.`,
    }),
  });
}

/** Sliding-window attempt counter (in memory). */
class AttemptCounter {
  private map = new Map<string, number[]>();

  /** Records an attempt. Returns 0 when allowed, otherwise the seconds until it is allowed again. */
  hit(key: string, max: number, windowMs: number): number {
    const now = Date.now();
    const list = (this.map.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.map.set(key, list);
      return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    }
    list.push(now);
    this.map.set(key, list);
    if (this.map.size > 50_000) this.prune(windowMs);
    return 0;
  }

  /** Counts without recording. */
  count(key: string, windowMs: number): { n: number; oldest: number } {
    const now = Date.now();
    const list = (this.map.get(key) || []).filter((t) => now - t < windowMs);
    return { n: list.length, oldest: list[0] || now };
  }

  push(key: string) {
    const list = this.map.get(key) || [];
    list.push(Date.now());
    this.map.set(key, list);
  }

  clear(key: string) {
    this.map.delete(key);
  }

  private prune(windowMs: number) {
    const now = Date.now();
    for (const [k, list] of this.map) {
      if (!list.some((t) => now - t < windowMs)) this.map.delete(k);
    }
  }
}

const failedLogins = new AttemptCounter();

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

export const loginThrottle = {
  /** Seconds remaining if this account is locked, otherwise 0. */
  lockedFor(portal: string, email: string): number {
    if (disabled()) return 0;
    const { n, oldest } = failedLogins.count(`${portal}:${email.toLowerCase()}`, LOGIN_WINDOW_MS);
    if (n < LOGIN_MAX_FAILURES) return 0;
    return Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - Date.now()) / 1000));
  },
  recordFailure(portal: string, email: string) {
    if (!disabled()) failedLogins.push(`${portal}:${email.toLowerCase()}`);
  },
  clear(portal: string, email: string) {
    failedLogins.clear(`${portal}:${email.toLowerCase()}`);
  },
};
