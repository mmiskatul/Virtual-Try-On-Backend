import crypto from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthPortal, AuthToken, AuthTokenType, User } from '../../domain/types.js';
import { db } from '../../infrastructure/database.js';
import { emailService, EmailSendResult } from '../../infrastructure/email.service.js';
import { getValidatedEnv } from '../../infrastructure/env.schema.js';
import { resolveOptionalAuthUser } from '../../infrastructure/auth.guard.js';
import { BRAND_MEMBER_ROLE_CODES, PLATFORM_ADMIN_ROLE_CODES } from '../../modules/rbac/rbac.catalog.js';
import {
  clearPortalAuthCookies,
  extractCookieToken,
  setPortalAuthCookies,
  wantsCookieOnlyTransport,
} from '../../infrastructure/auth_cookies.js';
import {
  consumeOAuthExchangeCode,
  issueSessionTokens,
  resolveUserFromClaims,
  revokeUserSession,
  rotateRefreshSession,
} from '../../modules/auth/jwt.verifier.js';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

export function validateStrongPassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password.length > 128) {
    return 'Password cannot exceed 128 characters.';
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

export function sanitizePublicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    emailVerified: Boolean(user.emailVerified),
  };
}

export async function issuePortalAuthSession(
  request: FastifyRequest,
  reply: FastifyReply,
  portal: AuthPortal,
  user: User,
  deviceLabel?: string,
) {
  const issued = await issueSessionTokens(request, user, { portal, deviceLabel });
  setPortalAuthCookies(reply, request, portal, {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    sessionId: issued.session.id,
    refreshTtlSec: issued.refreshTtlSec,
  });

  const cookieOnly = wantsCookieOnlyTransport(request);
  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    session: issued.session,
    accessExpiresAt: issued.accessExpiresAt,
    responseFields: {
      ...(cookieOnly ? {} : { token: issued.accessToken }),
      sessionId: issued.session.id,
      session: {
        id: issued.session.id,
        portal,
        expiresAt: issued.session.expiresAt.toISOString(),
        accessExpiresAt: issued.accessExpiresAt.toISOString(),
      },
    },
  };
}

export interface VerifiedGoogleProfile {
  email: string;
  name: string;
  picture?: string;
}

/**
 * Verifies a Google OIDC id_token against Google tokeninfo and configured audience.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  fallbackName?: string,
  defaultLabel = 'User',
): Promise<
  | { ok: true; profile: VerifiedGoogleProfile }
  | { ok: false; status: number; error: string; message: string }
> {
  const trimmed = idToken.trim();
  if (!trimmed) {
    return { ok: false, status: 401, error: 'Unauthorized', message: 'Valid Google ID token is required.' };
  }

  let tokenInfo: Record<string, any>;
  try {
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(trimmed)}`);
    if (!verifyRes.ok) {
      return { ok: false, status: 401, error: 'Unauthorized', message: 'Invalid Google ID token.' };
    }
    tokenInfo = (await verifyRes.json()) as Record<string, any>;
  } catch {
    return { ok: false, status: 502, error: 'UpstreamError', message: 'Unable to verify Google ID token.' };
  }

  const expectedClientId = getValidatedEnv().GOOGLE_CLIENT_ID.trim();
  if (expectedClientId && tokenInfo.aud !== expectedClientId) {
    return { ok: false, status: 403, error: 'Forbidden', message: 'Google token audience mismatch.' };
  }

  const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === 'true';
  const email = typeof tokenInfo.email === 'string' ? normalizeEmail(tokenInfo.email) : '';
  const cleanFallback = typeof fallbackName === 'string' ? fallbackName.trim() : '';
  const name =
    (typeof tokenInfo.name === 'string' && tokenInfo.name.trim()) ||
    cleanFallback ||
    email.split('@')[0] ||
    defaultLabel;

  if (!emailVerified || !email || !isValidEmail(email)) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'Verified Google email required.' };
  }

  const picture = typeof tokenInfo.picture === 'string' && tokenInfo.picture.trim() ? tokenInfo.picture.trim() : undefined;
  return { ok: true, profile: { email, name, picture } };
}

/**
 * Claims a single-use OAuth exchange code bound to a specific portal and resolves its domain user.
 */
export async function claimPortalOAuthExchangeCode(
  code: string,
  expectedPortal: AuthPortal,
): Promise<
  | { ok: true; user: User; deviceLabel?: string }
  | { ok: false; status: number; error: string; message: string }
> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'Exchange code is required.' };
  }

  const claimed = await consumeOAuthExchangeCode(cleanCode);
  if (!claimed || claimed.portal !== expectedPortal) {
    return {
      ok: false,
      status: 401,
      error: 'InvalidExchangeCode',
      message: 'OAuth handoff code is invalid or expired.',
    };
  }

  const user = await resolveUserFromClaims({ userId: claimed.userId, authSource: 'fastify_jwt' });
  if (!user) {
    return { ok: false, status: 403, error: 'Forbidden', message: 'Account not found.' };
  }

  return { ok: true, user, deviceLabel: claimed.deviceLabel };
}

function resolvePortal(requestedPortal: unknown, fallback: AuthPortal): AuthPortal {
  if (requestedPortal === 'marketplace' || requestedPortal === 'brand' || requestedPortal === 'admin') {
    return requestedPortal;
  }
  return fallback;
}

export function extractRequestOrigin(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.trim()) return origin.trim();
  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer.trim()) {
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function issueAuthTokenAndSendEmail(params: {
  user: User;
  type: AuthTokenType;
  portal: AuthPortal;
  requestOrigin?: string;
}): Promise<EmailSendResult> {
  const { user, type, portal, requestOrigin } = params;
  const now = Date.now();
  const ttlMs = type === 'EMAIL_VERIFICATION' ? EMAIL_VERIFICATION_TTL_MS : PASSWORD_RESET_TTL_MS;
  const expiresInMinutes = Math.round(ttlMs / 60000);

  db.invalidateAuthTokens(user.id, type);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const otpCode = String(crypto.randomInt(100000, 1000000));

  const record: AuthToken = {
    id: `tok_${now}_${crypto.randomBytes(4).toString('hex')}`,
    userId: user.id,
    email: user.email,
    type,
    tokenHash: db.hashToken(rawToken),
    otpCodeHash: db.hashToken(otpCode),
    portal,
    expiresAt: now + ttlMs,
    createdAt: now,
  };
  db.createAuthToken(record);

  if (type === 'EMAIL_VERIFICATION') {
    return emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      portal,
      rawToken,
      otpCode,
      expiresInMinutes,
      requestOrigin,
    });
  }

  return emailService.sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    portal,
    rawToken,
    otpCode,
    expiresInMinutes,
    requestOrigin,
  });
}

export async function dispatchVerificationForUser(user: User, portal: AuthPortal, requestOrigin?: string) {
  return issueAuthTokenAndSendEmail({
    user,
    type: 'EMAIL_VERIFICATION',
    portal,
    requestOrigin,
  });
}

function findMatchingToken(body: { token?: string; email?: string; code?: string }, type: AuthTokenType): AuthToken | undefined {
  if (body.token && typeof body.token === 'string' && body.token.trim().length > 0) {
    return db.findAuthTokenByRawToken(body.token, type);
  }
  if (body.email && body.code && typeof body.email === 'string' && typeof body.code === 'string') {
    return db.findAuthTokenByOtp(body.email, body.code, type);
  }
  return undefined;
}

export function registerSharedAuthRoutes(
  app: FastifyInstance,
  prefix: string,
  defaultPortal: AuthPortal
) {
  // Verify Email via Token link OR Email + 6-digit OTP Code
  app.post(`${prefix}/verify-email`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const tokenStr = typeof body.token === 'string' ? body.token.trim() : '';
    const emailStr = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const codeStr = typeof body.code === 'string' ? body.code.trim() : '';

    if (!tokenStr && (!emailStr || !codeStr)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'A verification token or an email address with 6-digit code is required.',
      });
    }

    if (!tokenStr && emailStr && db.isOtpLocked(emailStr, 'EMAIL_VERIFICATION')) {
      return reply.status(429).send({
        error: 'TooManyAttempts',
        message: 'Too many invalid verification attempts. Please request a new verification email.',
      });
    }

    const tokenRecord = findMatchingToken({ token: tokenStr, email: emailStr, code: codeStr }, 'EMAIL_VERIFICATION');
    if (!tokenRecord) {
      if (!tokenStr && emailStr) {
        const { locked } = db.recordOtpFailure(emailStr, 'EMAIL_VERIFICATION');
        if (locked) {
          return reply.status(429).send({
            error: 'TooManyAttempts',
            message: 'Too many invalid verification codes. Your active code has been invalidated; please request a new one.',
          });
        }
      }
      return reply.status(400).send({
        error: 'InvalidOrExpiredToken',
        code: 'INVALID_VERIFICATION_TOKEN',
        message: 'This verification link or code is invalid or has expired. Please request a new one.',
      });
    }

    const user = db.getUserById(tokenRecord.userId);
    if (!user) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'Associated user account could not be found.',
      });
    }

    db.clearOtpFailures(user.email, 'EMAIL_VERIFICATION');

    const updatedUser = db.updateUser(user.id, {
      emailVerified: true,
      emailVerifiedAt: Date.now(),
    });
    db.markAuthTokenUsed(tokenRecord.id);
    db.invalidateAuthTokens(user.id, 'EMAIL_VERIFICATION');

    db.recordAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      actorRole: user.role,
      action: 'EMAIL_VERIFIED',
      entity: 'User',
      entityId: user.id,
      details: { email: user.email, portal: tokenRecord.portal },
    });

    let extraSessionFields: Record<string, unknown> = {};
    if (defaultPortal === 'marketplace' && user.role === 'CUSTOMER') {
      const issued = await issuePortalAuthSession(
        request,
        reply,
        'marketplace',
        updatedUser || user,
        (request.headers['user-agent'] as string) || 'Marketplace Verified',
      );
      extraSessionFields = issued.responseFields;
      } else if (defaultPortal === 'brand' && BRAND_MEMBER_ROLE_CODES.has(user.role)) {
        const tenant = user.tenantId ? db.getTenantById(user.tenantId) : undefined;
        if (!tenant || tenant.status === 'ACTIVE') {
          const issued = await issuePortalAuthSession(
            request,
            reply,
            'brand',
            updatedUser || user,
            (request.headers['user-agent'] as string) || 'Brand Verified',
          );
          extraSessionFields = {
            ...issued.responseFields,
            ...(tenant ? { tenant } : {}),
          };
        }
      } else if (defaultPortal === 'admin' && PLATFORM_ADMIN_ROLE_CODES.has(user.role)) {
        const issued = await issuePortalAuthSession(
          request,
          reply,
          'admin',
          updatedUser || user,
          (request.headers['user-agent'] as string) || 'Admin Verified',
        );
        extraSessionFields = issued.responseFields;
      }

    return {
      message: 'Email verified successfully! You can now sign in to your account.',
      user: sanitizePublicUser(updatedUser || user),
      ...extraSessionFields,
    };
  });

  // Resend Email Verification
  app.post(`${prefix}/resend-verification`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const email = normalizeEmail(rawEmail);

    if (!email || !isValidEmail(email)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Please provide a valid email address.',
      });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
      return {
        message: 'If your account exists and is pending verification, a verification email has been sent.',
      };
    }

    if (user.emailVerified) {
      return {
        message: 'Your email address is already verified. You can sign in now.',
        alreadyVerified: true,
      };
    }

    // Anti-spam throttle: max 3 verification emails per 60 seconds per user
    if (db.countRecentAuthTokens(user.id, 'EMAIL_VERIFICATION', 60_000) >= 3) {
      return reply.status(429).send({
        error: 'TooManyRequests',
        message: 'Too many verification requests. Please wait a minute before trying again.',
      });
    }

    const portal = resolvePortal(body.portal, defaultPortal);
    const mailResult = await dispatchVerificationForUser(user, portal, extractRequestOrigin(request));

    if (!mailResult.delivered) {
      return reply.status(502).send({
        error: 'EmailDeliveryFailed',
        message: mailResult.error
          ? `We could not send the verification email: ${mailResult.error}`
          : 'We could not send the verification email right now. Please try again shortly.',
      });
    }

    return {
      message: 'Verification email sent! Check your inbox for the verification link or 6-digit code.',
    };
  });

  // Forgot Password (Request Reset Link & Code)
  app.post(`${prefix}/forgot-password`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const email = normalizeEmail(rawEmail);

    if (!email || !isValidEmail(email)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Please provide a valid email address.',
      });
    }

    const portal = resolvePortal(body.portal, defaultPortal);
    const user = db.getUserByEmail(email);

    if (user) {
      if (db.countRecentAuthTokens(user.id, 'PASSWORD_RESET', 60_000) >= 3) {
        return reply.status(429).send({
          error: 'TooManyRequests',
          message: 'Too many password reset requests. Please wait a minute before trying again.',
        });
      }

      await issueAuthTokenAndSendEmail({
        user,
        type: 'PASSWORD_RESET',
        portal,
        requestOrigin: extractRequestOrigin(request),
      });

      db.recordAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        actorRole: user.role,
        action: 'PASSWORD_RESET_REQUESTED',
        entity: 'User',
        entityId: user.id,
        details: { email: user.email, portal },
      });
    }

    return {
      message: 'If an account matches that email address, password reset instructions have been sent.',
    };
  });

  // Check Reset Token / Code Validity before Resetting
  app.post(`${prefix}/verify-reset-token`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const tokenStr = typeof body.token === 'string' ? body.token.trim() : '';
    const emailStr = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const codeStr = typeof body.code === 'string' ? body.code.trim() : '';

    if (!tokenStr && (!emailStr || !codeStr)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'A reset token or email with 6-digit code is required.',
      });
    }

    const tokenRecord = findMatchingToken({ token: tokenStr, email: emailStr, code: codeStr }, 'PASSWORD_RESET');
    if (!tokenRecord) {
      return reply.status(400).send({
        error: 'InvalidOrExpiredToken',
        code: 'INVALID_RESET_TOKEN',
        message: 'This password reset link or code is invalid or has expired.',
      });
    }

    return {
      valid: true,
      email: tokenRecord.email,
      expiresAt: tokenRecord.expiresAt,
    };
  });

  // Reset Password using Token OR Email + 6-digit OTP Code
  app.post(`${prefix}/reset-password`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const tokenStr = typeof body.token === 'string' ? body.token.trim() : '';
    const emailStr = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const codeStr = typeof body.code === 'string' ? body.code.trim() : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!tokenStr && (!emailStr || !codeStr)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'A password reset token or email with 6-digit code is required.',
      });
    }

    const passwordError = validateStrongPassword(newPassword);
    if (passwordError) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: passwordError,
      });
    }

    if (!tokenStr && emailStr && db.isOtpLocked(emailStr, 'PASSWORD_RESET')) {
      return reply.status(429).send({
        error: 'TooManyAttempts',
        message: 'Too many invalid reset attempts. Please request a new reset code.',
      });
    }

    const tokenRecord = findMatchingToken({ token: tokenStr, email: emailStr, code: codeStr }, 'PASSWORD_RESET');
    if (!tokenRecord) {
      if (!tokenStr && emailStr) {
        const { locked } = db.recordOtpFailure(emailStr, 'PASSWORD_RESET');
        if (locked) {
          return reply.status(429).send({
            error: 'TooManyAttempts',
            message: 'Too many invalid reset codes. Active codes were invalidated; please request a new reset email.',
          });
        }
      }
      return reply.status(400).send({
        error: 'InvalidOrExpiredToken',
        code: 'INVALID_RESET_TOKEN',
        message: 'This password reset link or code is invalid or has expired. Please request a new reset link.',
      });
    }

    const user = db.getUserById(tokenRecord.userId);
    if (!user) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'Associated user account could not be found.',
      });
    }

    db.clearOtpFailures(user.email, 'PASSWORD_RESET');

    const nextHash = db.hashPassword(newPassword);
    db.updateUser(user.id, {
      passwordHash: nextHash,
      emailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt || Date.now(),
    });
    db.markAuthTokenUsed(tokenRecord.id);
    db.invalidateAuthTokens(user.id, 'PASSWORD_RESET');

    const portal = resolvePortal(body.portal, tokenRecord.portal || defaultPortal);
    await emailService.sendPasswordChangedNotice({
      to: user.email,
      name: user.name,
      portal,
    });

    db.recordAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      actorRole: user.role,
      action: 'PASSWORD_RESET_COMPLETED',
      entity: 'User',
      entityId: user.id,
      details: { email: user.email, portal },
    });

    return {
      message: 'Your password has been reset successfully. You can now sign in with your new password.',
    };
  });

  // Rotate Refresh Token + issue fresh HttpOnly Access & Refresh cookies
  app.post(`${prefix}/refresh`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { token: refreshToken } = extractCookieToken(request, 'refresh', defaultPortal);
    if (!refreshToken) {
      clearPortalAuthCookies(reply, request, defaultPortal);
      return reply.status(401).send({
        error: 'SessionExpired',
        code: 'NO_REFRESH_TOKEN',
        message: 'No active refresh token cookie found. Please sign in again.',
      });
    }

    const { token: sidCookie } = extractCookieToken(request, 'session', defaultPortal);
    const rotated = await rotateRefreshSession(request, refreshToken, defaultPortal);
    if (!rotated.ok) {
      clearPortalAuthCookies(reply, request, defaultPortal);
      const isReuse = rotated.reason === 'refresh_reuse_detected';
      return reply.status(401).send({
        error: isReuse ? 'SessionCompromised' : 'SessionExpired',
        code: rotated.reason.toUpperCase(),
        message: isReuse
          ? 'Refresh token reuse detected. Session has been revoked for security.'
          : 'Your session has expired or been revoked. Please sign in again.',
      });
    }

    if (sidCookie && sidCookie !== rotated.sid) {
      await revokeUserSession(rotated.sid);
      clearPortalAuthCookies(reply, request, rotated.portal);
      return reply.status(401).send({
        error: 'SessionMismatch',
        code: 'SESSION_MISMATCH',
        message: 'Session cookie mismatch. Please sign in again.',
      });
    }

    if (rotated.user.tenantId) {
      const tenant = db.getTenantById(rotated.user.tenantId);
      if (tenant && tenant.status !== 'ACTIVE') {
        await revokeUserSession(rotated.sid);
        clearPortalAuthCookies(reply, request, rotated.portal);
        return reply.status(403).send({
          error: 'TenantSuspended',
          message: 'Your organization account is suspended.',
        });
      }
    }

    setPortalAuthCookies(reply, request, rotated.portal, {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      sessionId: rotated.sid,
      refreshTtlSec: rotated.refreshTtlSec,
    });

    const cookieOnly = wantsCookieOnlyTransport(request);
    return {
      ok: true,
      ...(cookieOnly ? {} : { token: rotated.accessToken }),
      sessionId: rotated.sid,
      session: {
        id: rotated.sid,
        portal: rotated.portal,
        expiresAt: rotated.expiresAt.toISOString(),
        accessExpiresAt: rotated.accessExpiresAt.toISOString(),
      },
      user: sanitizePublicUser(rotated.user),
    };
  });

  // Logout: revoke server session + invalidate refresh state + clear HttpOnly cookies
  app.post(`${prefix}/logout`, async (request: FastifyRequest, reply: FastifyReply) => {
    let sidToRevoke: string | undefined;
    const { user, sid } = await resolveOptionalAuthUser(request);
    if (sid) {
      sidToRevoke = sid;
    }

    if (!sidToRevoke) {
      const { token: refreshToken } = extractCookieToken(request, 'refresh', defaultPortal);
      if (refreshToken) {
        try {
          const decoded = app.jwt.verify<Record<string, any>>(refreshToken);
          if (typeof decoded?.sid === 'string') {
            sidToRevoke = decoded.sid;
          }
        } catch {
          // Expired or invalid refresh token; still clear cookies below
        }
      }
    }

    if (!sidToRevoke) {
      const { token: sidCookie } = extractCookieToken(request, 'session', defaultPortal);
      if (sidCookie) {
        sidToRevoke = sidCookie;
      }
    }

    if (sidToRevoke) {
      await revokeUserSession(sidToRevoke);
    }

    clearPortalAuthCookies(reply, request, defaultPortal);

    if (user) {
      db.recordAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        actorRole: user.role,
        action: 'AUTH_LOGOUT',
        entity: 'UserSession',
        entityId: sidToRevoke || 'cookie_clear',
        details: { portal: defaultPortal },
      });
    }

    return {
      ok: true,
      loggedOut: true,
      message: 'Signed out cleanly.',
    };
  });

  // Lightweight session check with silent refresh-cookie rotation (avoids 401 console errors on page load)
  app.get(`${prefix}/session`, async (request: FastifyRequest, reply: FastifyReply) => {
    const resolved = await resolveOptionalAuthUser(request);
    if (resolved.user) {
      const tenant = resolved.user.tenantId ? db.getTenantById(resolved.user.tenantId) : undefined;
      return {
        authenticated: true,
        refreshed: false,
        portal: defaultPortal,
        sessionId: resolved.sid || null,
        user: sanitizePublicUser(resolved.user),
        ...(tenant ? { tenant } : {}),
      };
    }

    const { token: refreshToken } = extractCookieToken(request, 'refresh', defaultPortal);
    if (refreshToken) {
      const { token: sidCookie } = extractCookieToken(request, 'session', defaultPortal);
      const rotated = await rotateRefreshSession(request, refreshToken, defaultPortal);
      if (rotated.ok) {
        if (sidCookie && sidCookie !== rotated.sid) {
          await revokeUserSession(rotated.sid);
          clearPortalAuthCookies(reply, request, rotated.portal);
          return { authenticated: false, portal: defaultPortal, user: null };
        }
        const tenant = rotated.user.tenantId ? db.getTenantById(rotated.user.tenantId) : undefined;
        if (tenant && tenant.status !== 'ACTIVE') {
          await revokeUserSession(rotated.sid);
          clearPortalAuthCookies(reply, request, defaultPortal);
          return { authenticated: false, portal: defaultPortal, user: null };
        }
        setPortalAuthCookies(reply, request, rotated.portal, {
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          sessionId: rotated.sid,
          refreshTtlSec: rotated.refreshTtlSec,
        });
        return {
          authenticated: true,
          refreshed: true,
          portal: rotated.portal,
          sessionId: rotated.sid,
          session: {
            id: rotated.sid,
            portal: rotated.portal,
            expiresAt: rotated.expiresAt.toISOString(),
            accessExpiresAt: rotated.accessExpiresAt.toISOString(),
          },
          user: sanitizePublicUser(rotated.user),
          ...(tenant ? { tenant } : {}),
        };
      }
      clearPortalAuthCookies(reply, request, defaultPortal);
    }

    return {
      authenticated: false,
      portal: defaultPortal,
      user: null,
    };
  });
}
