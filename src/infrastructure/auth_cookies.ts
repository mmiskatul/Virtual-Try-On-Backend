import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

export type AuthPortal = 'marketplace' | 'brand' | 'admin';

export interface PortalCookieNames {
  access: string;
  refresh: string;
  session: string;
}

export const PORTAL_COOKIE_NAMES: Record<AuthPortal, PortalCookieNames> = {
  marketplace: {
    access: 'vtry_mkt_access',
    refresh: 'vtry_mkt_refresh',
    session: 'vtry_mkt_sid',
  },
  brand: {
    access: 'vtry_brand_access',
    refresh: 'vtry_brand_refresh',
    session: 'vtry_brand_sid',
  },
  admin: {
    access: 'vtry_admin_access',
    refresh: 'vtry_admin_refresh',
    session: 'vtry_admin_sid',
  },
};

export const ACCESS_TOKEN_TTL_SEC = Number(process.env.ACCESS_TOKEN_TTL_SEC || 15 * 60); // 15 minutes
export const ACCESS_TOKEN_EXPIRES_IN = `${ACCESS_TOKEN_TTL_SEC}s`;

export const REFRESH_TTL_BY_PORTAL: Record<AuthPortal, number> = {
  marketplace: Number(process.env.MARKETPLACE_REFRESH_TTL_SEC || 7 * 24 * 60 * 60), // 7 days
  brand: Number(process.env.BRAND_REFRESH_TTL_SEC || 7 * 24 * 60 * 60), // 7 days
  admin: Number(process.env.ADMIN_REFRESH_TTL_SEC || 24 * 60 * 60), // 24 hours
};

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return result;
  }

  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const rawName = part.slice(0, eqIndex).trim();
    const rawVal = part.slice(eqIndex + 1).trim();
    if (!rawName) continue;
    try {
      result[rawName] = decodeURIComponent(rawVal);
    } catch {
      result[rawName] = rawVal;
    }
  }

  return result;
}

function normalizeHeader(value: string | string[] | undefined): string {
  if (!value) return '';
  return Array.isArray(value) ? value[0] || '' : value;
}

function parseOriginPortOrHost(originOrReferer: string): string {
  if (!originOrReferer) return '';
  try {
    const u = new URL(originOrReferer);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`.toLowerCase();
  } catch {
    return '';
  }
}

function configuredPortalHost(portalUrl: string): string {
  try {
    const u = new URL(portalUrl);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`.toLowerCase();
  } catch {
    return '';
  }
}

export function resolvePortalFromRequest(
  request: FastifyRequest,
  fallbackPortal?: AuthPortal,
): AuthPortal {
  const explicit = normalizeHeader(request.headers['x-auth-portal']).trim().toLowerCase();
  if (explicit === 'marketplace' || explicit === 'brand' || explicit === 'admin') {
    return explicit;
  }

  const url = (request.url || '').toLowerCase();
  if (url.startsWith('/api/v1/marketplace')) {
    return 'marketplace';
  }
  if (url.startsWith('/api/v1/admin')) {
    return 'admin';
  }

  const originOrReferer =
    normalizeHeader(request.headers.origin) || normalizeHeader(request.headers.referer);
  const requestHost = parseOriginPortOrHost(originOrReferer);
  if (requestHost) {
    if (requestHost === configuredPortalHost(config.superAdminUrl) || requestHost.endsWith(':3002')) {
      return 'admin';
    }
    if (requestHost === configuredPortalHost(config.brandDashboardUrl) || requestHost.endsWith(':3001')) {
      return 'brand';
    }
    if (requestHost === configuredPortalHost(config.marketplaceUrl) || requestHost.endsWith(':3000')) {
      return 'marketplace';
    }
  }

  if (url.startsWith('/api/v1/commerce') || url.startsWith('/api/v1/try-on')) {
    return 'marketplace';
  }

  // Fallback for shared routes (e.g. /api/v1/auth/sessions, /api/v1/storage/*) without Origin/X-Auth-Portal
  if (!fallbackPortal) {
    const cookies = parseCookies(request.headers.cookie);
    const presentPortals = (['marketplace', 'brand', 'admin'] as AuthPortal[]).filter(
      (portal) => Boolean(cookies[PORTAL_COOKIE_NAMES[portal].access] || cookies[PORTAL_COOKIE_NAMES[portal].refresh]),
    );
    if (presentPortals.length === 1) {
      return presentPortals[0];
    }
  }

  return fallbackPortal || 'brand';
}

export function extractCookieToken(
  request: FastifyRequest,
  kind: keyof PortalCookieNames,
  fallbackPortal?: AuthPortal,
): { portal: AuthPortal; token: string | null } {
  const portal = resolvePortalFromRequest(request, fallbackPortal);
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[PORTAL_COOKIE_NAMES[portal][kind]] || null;
  return { portal, token };
}

export function wantsCookieOnlyTransport(request: FastifyRequest): boolean {
  const header = normalizeHeader(request.headers['x-auth-transport']).trim().toLowerCase();
  return header === 'cookie';
}

function shouldUseSecureCookie(request?: FastifyRequest): boolean {
  if (process.env.COOKIE_SECURE === 'true') {
    return true;
  }
  if (!request) {
    return false;
  }
  const forwardedProto = normalizeHeader(request.headers['x-forwarded-proto']).trim().toLowerCase();
  if (forwardedProto === 'https') {
    return true;
  }
  return request.protocol === 'https';
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge: number;
    secure: boolean;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    `SameSite=${options.sameSite || 'Lax'}`,
  ];
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function appendSetCookies(reply: FastifyReply, newCookies: string[]): void {
  const existing = reply.getHeader('set-cookie');
  const prevList = !existing
    ? []
    : Array.isArray(existing)
      ? existing.map(String)
      : [String(existing)];
  reply.header('Set-Cookie', [...prevList, ...newCookies]);
}

export function setPortalAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  portal: AuthPortal,
  tokens: {
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    refreshTtlSec?: number;
  },
): void {
  const names = PORTAL_COOKIE_NAMES[portal];
  const secure = shouldUseSecureCookie(request);
  const refreshTtlSec = tokens.refreshTtlSec ?? REFRESH_TTL_BY_PORTAL[portal];

  appendSetCookies(reply, [
    serializeCookie(names.access, tokens.accessToken, {
      maxAge: ACCESS_TOKEN_TTL_SEC,
      secure,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    }),
    serializeCookie(names.refresh, tokens.refreshToken, {
      maxAge: refreshTtlSec,
      secure,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    }),
    serializeCookie(names.session, tokens.sessionId, {
      maxAge: refreshTtlSec,
      secure,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    }),
  ]);
}

export function clearPortalAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  portal: AuthPortal,
): void {
  const names = PORTAL_COOKIE_NAMES[portal];
  const secure = shouldUseSecureCookie(request);

  appendSetCookies(reply, [
    serializeCookie(names.access, '', { maxAge: 0, secure, httpOnly: true, sameSite: 'Lax', path: '/' }),
    serializeCookie(names.refresh, '', { maxAge: 0, secure, httpOnly: true, sameSite: 'Lax', path: '/' }),
    serializeCookie(names.session, '', { maxAge: 0, secure, httpOnly: true, sameSite: 'Lax', path: '/' }),
  ]);
}

