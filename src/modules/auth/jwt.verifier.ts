import crypto from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { getValidatedEnv } from '../../infrastructure/env.schema.js';
import { logger } from '../../infrastructure/logger.js';
import { User, UserRole } from '../../domain/types.js';
import { maskIpAddress } from '../audit/audit.service.js';

export interface VerifiedJwtClaims {
  userId?: string;
  sub?: string;
  email?: string;
  role?: string;
  tenantId?: string;
  sid?: string;
  authSource: 'fastify_jwt' | 'supabase_jwt';
  appMetadata?: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceLabel: string;
  ipMasked?: string;
  revokedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

// In-memory session & revocation cache mirroring Prisma `user_sessions` for fast auth checks and offline unit tests
const memorySessions = new Map<string, SessionRecord>();
const revokedSessionIds = new Set<string>();

interface JwkEntry {
  kid?: string;
  alg?: string;
  kty: string;
  [key: string]: unknown;
}

let cachedJwks: { keys: JwkEntry[]; fetchedAt: number } | null = null;

function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

async function getSupabaseJwks(supabaseUrl: string): Promise<JwkEntry[]> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < 10 * 60 * 1000) {
    return cachedJwks.keys;
  }
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch Supabase JWKS (${res.status})`);
  }
  const data = (await res.json()) as { keys?: JwkEntry[] };
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  cachedJwks = { keys, fetchedAt: now };
  return keys;
}

/**
 * Verifies a Supabase Auth JWT using either HS256 (`SUPABASE_JWT_SECRET`) or asymmetric JWKS (`SUPABASE_URL`).
 */
export async function verifySupabaseJwt(token: string): Promise<VerifiedJwtClaims | null> {
  const env = getValidatedEnv();
  const supabaseSecret = process.env.SUPABASE_JWT_SECRET || env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL || env.SUPABASE_URL;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, any>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec) {
    throw new Error('Supabase token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) {
    throw new Error('Supabase token not active yet');
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sigBuf = base64UrlDecode(signatureB64);

  let verified = false;
  if (header.alg === 'HS256' && supabaseSecret) {
    const expected = crypto.createHmac('sha256', supabaseSecret).update(signingInput).digest();
    verified = sigBuf.length === expected.length && crypto.timingSafeEqual(sigBuf, expected);
  } else if ((header.alg === 'RS256' || header.alg === 'ES256') && supabaseUrl) {
    const keys = await getSupabaseJwks(supabaseUrl);
    const matchingKey = keys.find((k) => !header.kid || k.kid === header.kid);
    if (matchingKey) {
      const pubKey = crypto.createPublicKey({ key: matchingKey as any, format: 'jwk' });
      const alg = header.alg === 'RS256' ? 'RSA-SHA256' : 'SHA256';
      verified = crypto.verify(alg, signingInput, pubKey, sigBuf);
    }
  }

  if (!verified) return null;

  const appMeta = (payload.app_metadata && typeof payload.app_metadata === 'object' ? payload.app_metadata : {}) as Record<
    string,
    unknown
  >;

  return {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
    role: typeof appMeta.role === 'string' ? appMeta.role : typeof payload.role === 'string' ? payload.role : undefined,
    tenantId: typeof appMeta.tenant_id === 'string' ? appMeta.tenant_id : undefined,
    sid: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    authSource: 'supabase_jwt',
    appMetadata: appMeta,
  };
}

/**
 * Dual JWT verifier: accepts Fastify-issued HMAC JWT or configured Supabase Auth JWT.
 */
export async function verifyDualJwt(request: FastifyRequest, token: string): Promise<VerifiedJwtClaims> {
  try {
    const decoded = request.server.jwt.verify<Record<string, any>>(token);
    if (decoded && (decoded.userId || decoded.sub)) {
      return {
        userId: typeof decoded.userId === 'string' ? decoded.userId : decoded.sub,
        sub: typeof decoded.sub === 'string' ? decoded.sub : undefined,
        email: typeof decoded.email === 'string' ? decoded.email : undefined,
        role: typeof decoded.role === 'string' ? decoded.role : undefined,
        tenantId: typeof decoded.tenantId === 'string' ? decoded.tenantId : undefined,
        sid: typeof decoded.sid === 'string' ? decoded.sid : undefined,
        authSource: 'fastify_jwt',
      };
    }
  } catch {
    // Fall through to optional Supabase Auth JWT verification
  }

  const supabaseClaims = await verifySupabaseJwt(token);
  if (supabaseClaims && (supabaseClaims.sub || supabaseClaims.email)) {
    return supabaseClaims;
  }

  throw new Error('Invalid or expired token');
}

/**
 * Resolves a verified JWT principal into our domain `User`, bridging `authUserId` or `email` for Supabase logins.
 */
export async function resolveUserFromClaims(claims: VerifiedJwtClaims): Promise<User | undefined> {
  if (claims.userId) {
    const direct = db.getUserById(claims.userId);
    if (direct) return direct;
  }

  const prisma = getGlobalPrisma();
  if (claims.sub && prisma) {
    try {
      const profile = await prisma.userProfile.findUnique({
        where: { authUserId: claims.sub },
        include: { user: true },
      });
      if (profile?.user) {
        return db.getUserById(profile.user.id) || {
          id: profile.user.id,
          tenantId: profile.user.tenantId ?? undefined,
          name: profile.user.name,
          email: profile.user.email,
          passwordHash: profile.user.passwordHash,
          role: profile.user.role as UserRole,
          emailVerified: profile.user.emailVerified,
          createdAt: Number(profile.user.createdAt),
        };
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.supabase_profile_lookup_failed');
    }
  }

  if (claims.email) {
    const byEmail = db.getUserByEmail(claims.email.toLowerCase());
    if (byEmail) return byEmail;
  }

  return undefined;
}

/**
 * Creates a persistent tracked session in PostgreSQL `user_sessions` (plus in-memory mirror).
 */
export async function createUserSession(params: {
  userId: string;
  deviceLabel?: string;
  ipAddress?: string;
  ttlSeconds?: number;
}): Promise<SessionRecord> {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlSeconds ?? 7 * 24 * 3600) * 1000);
  const ipMasked = maskIpAddress(params.ipAddress);
  const deviceLabel = (params.deviceLabel || 'Web Session').slice(0, 250);

  const session: SessionRecord = {
    id,
    userId: params.userId,
    deviceLabel,
    ipMasked,
    revokedAt: null,
    expiresAt,
    createdAt: now,
  };
  memorySessions.set(id, session);

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      await prisma.userSession.create({
        data: {
          id,
          userId: params.userId,
          deviceLabel,
          ipMasked: ipMasked ?? null,
          expiresAt,
        },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.session_create_prisma_warning');
    }
  }

  return session;
}

export async function isSessionRevoked(sessionId?: string): Promise<boolean> {
  if (!sessionId) return false;
  if (revokedSessionIds.has(sessionId)) return true;

  const mem = memorySessions.get(sessionId);
  if (mem) {
    if (mem.revokedAt) return true;
    if (mem.expiresAt.getTime() < Date.now()) return true;
  }

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      const row = await prisma.userSession.findUnique({ where: { id: sessionId } });
      if (row) {
        if (row.revokedAt) {
          revokedSessionIds.add(sessionId);
          return true;
        }
        if (row.expiresAt.getTime() < Date.now()) {
          return true;
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.session_lookup_warning');
    }
  }

  return false;
}

export async function revokeUserSession(sessionId: string): Promise<boolean> {
  const now = new Date();
  revokedSessionIds.add(sessionId);
  const mem = memorySessions.get(sessionId);
  if (mem) {
    mem.revokedAt = now;
  }

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      await prisma.userSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.session_revoke_warning');
    }
  }
  return true;
}

export async function revokeAllUserSessions(userId: string): Promise<number> {
  const now = new Date();
  let count = 0;
  for (const [sid, s] of memorySessions.entries()) {
    if (s.userId === userId && !s.revokedAt) {
      s.revokedAt = now;
      revokedSessionIds.add(sid);
      count++;
    }
  }

  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      const res = await prisma.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      count = Math.max(count, res.count);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.revoke_all_warning');
    }
  }
  return count;
}

export async function listUserSessions(userId: string): Promise<SessionRecord[]> {
  const prisma = getGlobalPrisma();
  if (prisma) {
    try {
      const rows = await prisma.userSession.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });
      if (rows.length > 0) {
        return rows.map((r: any) => ({
          id: r.id,
          userId: r.userId,
          deviceLabel: r.deviceLabel,
          ipMasked: r.ipMasked ?? undefined,
          revokedAt: r.revokedAt,
          expiresAt: r.expiresAt,
          createdAt: r.createdAt,
        }));
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'auth.list_sessions_warning');
    }
  }

  return Array.from(memorySessions.values())
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
