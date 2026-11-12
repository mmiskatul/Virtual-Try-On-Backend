import './setup_env.js';
import { seedTestUsers } from './helpers.js';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { emailService } from '../src/infrastructure/email.service.js';

const app = createApp('all');

async function runAuthTests() {
  db.reset();
  seedTestUsers();
  console.log('\n=============================================================');
  console.log('🔐 Running Complete Auth, Verification & Recovery Test Suite');
  console.log('=============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` (${detail})` : ''}`);
      failed++;
    }
  }

  // --- 1. Seeded Demo Accounts Work Out-of-the-Box ---
  console.log('--- [1. Seeded Demo Accounts] ---');
  const demoCustomerLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
  });
  assert(demoCustomerLogin.statusCode === 200, 'Seeded customer sarah.miller@example.com logs in');

  const demoBrandLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' },
  });
  assert(demoBrandLogin.statusCode === 200, 'Seeded brand owner elena@auraatelier.com logs in');

  const demoAdminLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' },
  });
  assert(demoAdminLogin.statusCode === 200, 'Seeded super admin logs in');

  // --- 2. Customer Registration -> Unverified Block -> Resend -> Verify via OTP -> Login ---
  console.log('\n--- [2. Customer Registration & Email Verification] ---');
  const custRegRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/register',
    payload: {
      name: 'Maya Lin',
      email: 'Maya.Lin@Example.com',
      password: 'Password123',
    },
  });
  assert(custRegRes.statusCode === 201, 'Customer register returns 201');
  const custRegBody = JSON.parse(custRegRes.body);
  assert(custRegBody.requiresEmailVerification === true, 'Customer register requires email verification');
  assert(custRegBody.user.email === 'maya.lin@example.com', 'Email normalized to lowercase');
  assert(custRegBody.devPreview === undefined, 'Register response must never expose verification codes');
  const firstOtp = emailService.getTestPreview('maya.lin@example.com')?.otpCode || '';
  assert(firstOtp.length === 6, 'Test outbox captured 6-digit OTP code');

  // Unverified login must be blocked with EMAIL_NOT_VERIFIED
  const unverifiedLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    payload: { email: 'maya.lin@example.com', password: 'Password123' },
  });
  assert(unverifiedLogin.statusCode === 403, 'Unverified customer login blocked with 403');
  assert(JSON.parse(unverifiedLogin.body).code === 'EMAIL_NOT_VERIFIED', 'Error code is EMAIL_NOT_VERIFIED');

  // Resend verification invalidates first OTP and issues second OTP
  const resendRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/resend-verification',
    payload: { email: 'maya.lin@example.com', portal: 'marketplace' },
  });
  assert(resendRes.statusCode === 200, 'Resend verification returns 200');
  const resendBody = JSON.parse(resendRes.body);
  assert(resendBody.devPreview === undefined, 'Resend response must never expose verification codes');
  const secondOtp = emailService.getTestPreview('maya.lin@example.com')?.otpCode || '';
  assert(Boolean(secondOtp) && secondOtp.length === 6, 'Resend issues new 6-digit OTP');

  // Old OTP rejected
  const oldOtpRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/verify-email',
    payload: { email: 'maya.lin@example.com', code: firstOtp },
  });
  assert(oldOtpRes.statusCode === 400, 'Invalidated first OTP rejected with 400');

  // New OTP accepted
  const verifyOtpRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/verify-email',
    payload: { email: 'maya.lin@example.com', code: secondOtp },
  });
  assert(verifyOtpRes.statusCode === 200, 'Valid OTP verifies customer email');
  assert(JSON.parse(verifyOtpRes.body).user.emailVerified === true, 'Customer user emailVerified is now true');

  // Verified login succeeds
  const verifiedLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    payload: { email: 'maya.lin@example.com', password: 'Password123' },
  });
  assert(verifiedLogin.statusCode === 200, 'Verified customer login succeeds');
  const custToken = JSON.parse(verifiedLogin.body).token;

  const custMeRes = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/me',
    headers: { authorization: `Bearer ${custToken}` },
  });
  assert(custMeRes.statusCode === 200, 'GET /api/v1/marketplace/auth/me succeeds with token');

  // --- 3. Brand Registration & URL Token Verification ---
  console.log('\n--- [3. Brand Registration & URL Token Verification] ---');
  const brandRegRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      brandName: 'Lumiere Mode',
      slug: 'lumiere-mode',
      ownerName: 'Claire Moreau',
      email: 'claire@lumieremode.com',
      password: 'BrandPass99',
    },
  });
  assert(brandRegRes.statusCode === 201, 'Brand registration returns 201');
  const brandRegBody = JSON.parse(brandRegRes.body);
  assert(brandRegBody.requiresEmailVerification === true, 'Brand registration requires verification');
  assert(brandRegBody.devPreview === undefined, 'Brand register response must never expose verification URLs');
  const verifyActionUrl = new URL(emailService.getTestPreview('claire@lumieremode.com')?.actionUrl || '');
  const verifyToken = verifyActionUrl.searchParams.get('token');
  assert(Boolean(verifyToken), 'Brand verification URL contains raw token');

  // Unverified brand login blocked
  const unverifiedBrandLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'BrandPass99' },
  });
  assert(unverifiedBrandLogin.statusCode === 403, 'Unverified brand login blocked with 403');

  // Verify brand email via URL token
  const verifyTokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    payload: { token: verifyToken },
  });
  assert(verifyTokenRes.statusCode === 200, 'Brand email verified via token link');
  const verifyTokenBody = JSON.parse(verifyTokenRes.body);
  assert(Boolean(verifyTokenBody.sessionId), 'Brand verify-email issues auto-login sessionId');
  assert(verifyTokenBody.tenant?.slug === 'lumiere-mode', 'Brand verify-email returns tenant profile');
  const rawVerifyCookies = verifyTokenRes.headers['set-cookie'];
  const verifyCookieList = Array.isArray(rawVerifyCookies)
    ? rawVerifyCookies
    : rawVerifyCookies
      ? [rawVerifyCookies]
      : [];
  const verifyCookieHeader = verifyCookieList.map((c) => c.split(';')[0]).join('; ');
  for (const cookieName of ['vtry_brand_access=', 'vtry_brand_refresh=', 'vtry_brand_sid=']) {
    const matchedLine = verifyCookieList.find((c) => c.startsWith(cookieName)) || '';
    assert(Boolean(matchedLine), `Brand verify-email sets ${cookieName.replace('=', '')} cookie`);
    assert(/;\s*HttpOnly/i.test(matchedLine), `Brand verify-email ${cookieName.replace('=', '')} has HttpOnly flag`);
    assert(/;\s*SameSite=Lax/i.test(matchedLine), `Brand verify-email ${cookieName.replace('=', '')} has SameSite=Lax flag`);
  }

  const brandMissingSidHeader = verifyCookieList
    .filter((c) => !c.startsWith('vtry_brand_sid='))
    .map((c) => c.split(';')[0])
    .join('; ');
  const brandMissingSidRes = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: {
      cookie: brandMissingSidHeader,
      'x-auth-portal': 'brand',
      'x-auth-transport': 'cookie',
    },
  });
  assert(brandMissingSidRes.statusCode === 401, 'Brand cookie-transport rejects /api/v1/auth/me when vtry_brand_sid is missing');

  const brandAutoMe = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: {
      cookie: verifyCookieHeader,
      'x-auth-portal': 'brand',
      'x-auth-transport': 'cookie',
    },
  });
  assert(brandAutoMe.statusCode === 200, 'Verified brand session immediately accesses /api/v1/auth/me without separate login');

  // Verified brand login succeeds
  const verifiedBrandLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'BrandPass99' },
  });
  assert(verifiedBrandLogin.statusCode === 200, 'Verified brand login succeeds');
  assert(JSON.parse(verifiedBrandLogin.body).tenant.slug === 'lumiere-mode', 'Tenant returned on brand login');

  // --- 4. Role Separation Enforcement ---
  console.log('\n--- [4. Portal Role Separation] ---');
  const custOnBrand = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'maya.lin@example.com', password: 'Password123' },
  });
  assert(custOnBrand.statusCode === 403, 'Customer blocked from Brand portal login');

  const brandOnMarketplace = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'BrandPass99' },
  });
  assert(brandOnMarketplace.statusCode === 403, 'Brand owner blocked from Customer marketplace login');

  const brandOnAdmin = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'BrandPass99' },
  });
  assert(brandOnAdmin.statusCode === 403, 'Brand owner blocked from Super Admin portal login');

  // --- 5. Forgot Password & Reset Password Flow ---
  console.log('\n--- [5. Forgot Password & Reset Password Flow] ---');
  const unknownForgot = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email: 'does-not-exist@example.com', portal: 'brand' },
  });
  assert(unknownForgot.statusCode === 200, 'Forgot password returns generic 200 for unknown email (no enumeration)');

  const forgotRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    payload: { email: 'claire@lumieremode.com', portal: 'brand' },
  });
  assert(forgotRes.statusCode === 200, 'Forgot password returns 200 for existing brand owner');
  const forgotBody = JSON.parse(forgotRes.body);
  assert(forgotBody.devPreview === undefined, 'Forgot password response must never expose reset tokens');
  const resetUrl = new URL(emailService.getTestPreview('claire@lumieremode.com')?.actionUrl || '');
  const resetToken = resetUrl.searchParams.get('token');
  assert(Boolean(resetToken), 'Forgot password test outbox captured reset token');

  const checkTokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-reset-token',
    payload: { token: resetToken },
  });
  assert(checkTokenRes.statusCode === 200 && JSON.parse(checkTokenRes.body).valid === true, 'verify-reset-token validates token');

  const weakResetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    payload: { token: resetToken, newPassword: 'weak' },
  });
  assert(weakResetRes.statusCode === 400, 'Reset password rejects weak password');

  const resetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    payload: { token: resetToken, newPassword: 'NewSecurePassword99' },
  });
  assert(resetRes.statusCode === 200, 'Reset password succeeds with strong password');

  // Token replay must fail
  const replayResetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    payload: { token: resetToken, newPassword: 'AnotherPassword99' },
  });
  assert(replayResetRes.statusCode === 400, 'Reused password reset token rejected');

  // Old password rejected, new password accepted
  const oldPassLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'BrandPass99' },
  });
  assert(oldPassLogin.statusCode === 401, 'Old password fails after reset');

  const newPassLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'claire@lumieremode.com', password: 'NewSecurePassword99' },
  });
  assert(newPassLogin.statusCode === 200, 'New password succeeds after reset');

  // --- 6. Super Admin Forgot & Reset Password (OTP Flow) ---
  console.log('\n--- [6. Super Admin Password Recovery via 6-digit OTP] ---');
  const adminForgotRes = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/forgot-password',
    payload: { email: 'admin@vton-platform.io', portal: 'admin' },
  });
  assert(adminForgotRes.statusCode === 200, 'Admin forgot password returns 200');
  assert(JSON.parse(adminForgotRes.body).devPreview === undefined, 'Admin forgot password must never expose OTPs');
  const adminOtp = emailService.getTestPreview('admin@vton-platform.io')?.otpCode;
  assert(Boolean(adminOtp), 'Admin reset OTP generated');

  const adminResetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/reset-password',
    payload: { email: 'admin@vton-platform.io', code: adminOtp, newPassword: 'AdminNewPass99' },
  });
  assert(adminResetRes.statusCode === 200, 'Admin password reset via OTP succeeds');

  const adminNewLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'admin@vton-platform.io', password: 'AdminNewPass99' },
  });
  assert(adminNewLogin.statusCode === 200, 'Admin logs in with new password');

  // --- 7. HttpOnly Cookie Session, Access & Rotating Refresh Flow ---
  console.log('\n--- [7. HttpOnly Cookie Session, Access & Rotating Refresh Flow] ---');
  const extractSetCookies = (header: string | string[] | undefined): Record<string, { value: string; raw: string }> => {
    const arr = !header ? [] : Array.isArray(header) ? header : [header];
    const map: Record<string, { value: string; raw: string }> = {};
    for (const line of arr) {
      const semi = line.indexOf(';');
      const pair = semi === -1 ? line : line.slice(0, semi);
      const eq = pair.indexOf('=');
      if (eq > 0) {
        map[pair.slice(0, eq).trim()] = { value: decodeURIComponent(pair.slice(eq + 1).trim()), raw: line };
      }
    }
    return map;
  };

  const cookieLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    headers: { 'x-auth-transport': 'cookie', 'x-auth-portal': 'marketplace' },
    payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
  });
  assert(cookieLogin.statusCode === 200, 'Cookie-only marketplace login succeeds');
  const cookieLoginBody = JSON.parse(cookieLogin.body);
  assert(cookieLoginBody.token === undefined, 'Cookie transport omits raw token from JSON response body');
  assert(Boolean(cookieLoginBody.session?.id), 'Cookie login returns non-secret session metadata');

  const mktCookies1 = extractSetCookies(cookieLogin.headers['set-cookie']);
  for (const cname of ['vtry_mkt_access', 'vtry_mkt_refresh', 'vtry_mkt_sid']) {
    assert(Boolean(mktCookies1[cname]?.value), `${cname} cookie set on login`);
    assert(/;\s*HttpOnly/i.test(mktCookies1[cname]?.raw || ''), `${cname} cookie has HttpOnly flag on login`);
    assert(/;\s*SameSite=Lax/i.test(mktCookies1[cname]?.raw || ''), `${cname} cookie has SameSite=Lax flag on login`);
  }

  const cookieHeader1 = `vtry_mkt_access=${encodeURIComponent(mktCookies1.vtry_mkt_access.value)}; vtry_mkt_refresh=${encodeURIComponent(mktCookies1.vtry_mkt_refresh.value)}; vtry_mkt_sid=${encodeURIComponent(mktCookies1.vtry_mkt_sid.value)}`;
  const meFromCookie = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/me',
    headers: { cookie: cookieHeader1, 'x-auth-portal': 'marketplace', 'x-auth-transport': 'cookie' },
  });
  assert(meFromCookie.statusCode === 200, '/me authenticates via HttpOnly access + session cookies without Bearer header');
  assert(JSON.parse(meFromCookie.body).user.email === 'sarah.miller@example.com', '/me returns expected cookie user');

  const meMissingSid = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/me',
    headers: {
      cookie: `vtry_mkt_access=${encodeURIComponent(mktCookies1.vtry_mkt_access.value)}`,
      'x-auth-portal': 'marketplace',
      'x-auth-transport': 'cookie',
    },
  });
  assert(meMissingSid.statusCode === 401, 'Cookie-mode /me rejects missing vtry_mkt_sid');

  const meMismatchSid = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/me',
    headers: {
      cookie: `vtry_mkt_access=${encodeURIComponent(mktCookies1.vtry_mkt_access.value)}; vtry_mkt_sid=tampered_sid_value`,
      'x-auth-portal': 'marketplace',
      'x-auth-transport': 'cookie',
    },
  });
  assert(meMismatchSid.statusCode === 401, 'Cookie-mode /me rejects mismatched vtry_mkt_sid');

  const refreshRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/refresh',
    headers: { cookie: cookieHeader1, 'x-auth-transport': 'cookie', 'x-auth-portal': 'marketplace' },
  });
  assert(refreshRes.statusCode === 200, 'Refresh endpoint rotates HttpOnly cookies cleanly');
  assert(JSON.parse(refreshRes.body).token === undefined, 'Cookie-mode /refresh omits token from JSON body');
  const mktCookies2 = extractSetCookies(refreshRes.headers['set-cookie']);
  for (const cname of ['vtry_mkt_access', 'vtry_mkt_refresh', 'vtry_mkt_sid']) {
    assert(Boolean(mktCookies2[cname]?.value), `Rotated ${cname} cookie issued`);
    assert(/;\s*HttpOnly/i.test(mktCookies2[cname]?.raw || ''), `Rotated ${cname} has HttpOnly flag`);
  }
  assert(
    mktCookies2.vtry_mkt_refresh.value !== mktCookies1.vtry_mkt_refresh.value,
    'Refresh cookie rotates to a brand-new JTI token',
  );

  const cookieHeader2 = `vtry_mkt_access=${encodeURIComponent(mktCookies2.vtry_mkt_access.value)}; vtry_mkt_refresh=${encodeURIComponent(mktCookies2.vtry_mkt_refresh.value)}; vtry_mkt_sid=${encodeURIComponent(mktCookies2.vtry_mkt_sid.value)}`;
  const logoutRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/logout',
    headers: { cookie: cookieHeader2, 'x-auth-portal': 'marketplace' },
  });
  assert(logoutRes.statusCode === 200, '/logout succeeds cleanly');
  const clearedCookies = extractSetCookies(logoutRes.headers['set-cookie']);
  assert(/Max-Age=0/i.test(clearedCookies.vtry_mkt_access?.raw || ''), '/logout expires vtry_mkt_access cookie');
  assert(/Max-Age=0/i.test(clearedCookies.vtry_mkt_refresh?.raw || ''), '/logout expires vtry_mkt_refresh cookie');
  assert(/Max-Age=0/i.test(clearedCookies.vtry_mkt_sid?.raw || ''), '/logout expires vtry_mkt_sid cookie');

  const revokedMe = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/me',
    headers: { cookie: cookieHeader2, 'x-auth-portal': 'marketplace' },
  });
  assert(revokedMe.statusCode === 401, 'Old access cookie fails after /logout session revocation');

  // Verify /refresh rejects mismatched vtry_mkt_sid and revokes the session
  const bindingLogin1 = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    headers: { 'x-auth-transport': 'cookie', 'x-auth-portal': 'marketplace' },
    payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
  });
  assert(bindingLogin1.statusCode === 200, 'Second cookie login succeeds for sid mismatch checks');
  const bindCookies1 = extractSetCookies(bindingLogin1.headers['set-cookie']);
  const mismatchRefreshRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/refresh',
    headers: {
      cookie: `vtry_mkt_refresh=${encodeURIComponent(bindCookies1.vtry_mkt_refresh.value)}; vtry_mkt_sid=tampered_sid_value`,
      'x-auth-transport': 'cookie',
      'x-auth-portal': 'marketplace',
    },
  });
  assert(mismatchRefreshRes.statusCode === 401, '/refresh rejects mismatched vtry_mkt_sid');
  const clearedOnMismatch = extractSetCookies(mismatchRefreshRes.headers['set-cookie']);
  assert(/Max-Age=0/i.test(clearedOnMismatch.vtry_mkt_sid?.raw || ''), '/refresh mismatch clears vtry_mkt_sid cookie');

  const validAfterMismatchRefresh = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/refresh',
    headers: {
      cookie: `vtry_mkt_refresh=${encodeURIComponent(bindCookies1.vtry_mkt_refresh.value)}; vtry_mkt_sid=${encodeURIComponent(bindCookies1.vtry_mkt_sid.value)}`,
      'x-auth-transport': 'cookie',
      'x-auth-portal': 'marketplace',
    },
  });
  assert(validAfterMismatchRefresh.statusCode === 401, 'Mismatched /refresh revokes session so subsequent valid refresh also fails');

  // Verify /session rejects mismatched vtry_mkt_sid and clears cookies
  const bindingLogin2 = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    headers: { 'x-auth-transport': 'cookie', 'x-auth-portal': 'marketplace' },
    payload: { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' },
  });
  assert(bindingLogin2.statusCode === 200, 'Third cookie login succeeds for /session sid check');
  const bindCookies2 = extractSetCookies(bindingLogin2.headers['set-cookie']);
  const sessionMismatchRes = await app.inject({
    method: 'GET',
    url: '/api/v1/marketplace/auth/session',
    headers: {
      cookie: `vtry_mkt_access=${encodeURIComponent(bindCookies2.vtry_mkt_access.value)}; vtry_mkt_refresh=${encodeURIComponent(bindCookies2.vtry_mkt_refresh.value)}; vtry_mkt_sid=wrong_sid`,
      'x-auth-portal': 'marketplace',
    },
  });
  assert(sessionMismatchRes.statusCode === 200, '/session returns 200 when clearing mismatched sid');
  assert(JSON.parse(sessionMismatchRes.body).authenticated === false, '/session reports authenticated: false on vtry_mkt_sid mismatch');
  const clearedSessionCookies = extractSetCookies(sessionMismatchRes.headers['set-cookie']);
  assert(/Max-Age=0/i.test(clearedSessionCookies.vtry_mkt_access?.raw || ''), '/session mismatch clears vtry_mkt_access');
  assert(/Max-Age=0/i.test(clearedSessionCookies.vtry_mkt_sid?.raw || ''), '/session mismatch clears vtry_mkt_sid');

  // --- 9. Brand Google OAuth & Single-Use Cookie Handoff ---
  console.log('\n--- [9. Brand Google OAuth & Cookie Exchange] ---');
  const originalFetch = globalThis.fetch;
  try {
    const missingTokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-google',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: {},
    });
    assert(missingTokenRes.statusCode === 401, 'Brand Google OAuth rejects missing idToken with 401');

    // Mock Google tokeninfo verification cleanly for isolated unit test
    const expectedAud = process.env.GOOGLE_CLIENT_ID || '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        const parsed = new URL(urlStr);
        const tok = parsed.searchParams.get('id_token') || '';
        if (tok === 'tok_wrong_audience') {
          return new Response(
            JSON.stringify({ email: 'aud.mismatch@gmail.com', email_verified: true, name: 'Wrong Aud', aud: 'wrong-client-id.apps.googleusercontent.com' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (tok === 'tok_customer_account') {
          return new Response(
            JSON.stringify({ email: 'sarah.miller@example.com', email_verified: true, name: 'Sarah Miller', ...(expectedAud ? { aud: expectedAud } : {}) }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (tok === 'tok_new_brand_google') {
          return new Response(
            JSON.stringify({ email: 'aria.atelier@gmail.com', email_verified: true, name: 'Aria Laurent', ...(expectedAud ? { aud: expectedAud } : {}) }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (tok === 'tok_suspended_brand') {
          return new Response(
            JSON.stringify({ email: 'elena@auraatelier.com', email_verified: true, name: 'Elena Vance', ...(expectedAud ? { aud: expectedAud } : {}) }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    if (expectedAud) {
      const wrongAudRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth-google',
        headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
        payload: { idToken: 'tok_wrong_audience' },
      });
      assert(wrongAudRes.statusCode === 403 && JSON.parse(wrongAudRes.body).error === 'Forbidden', 'Rejects mismatched Google token audience');
    }

    const mismatchRoleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-google',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { idToken: 'tok_customer_account' },
    });
    assert(mismatchRoleRes.statusCode === 403, 'Customer email rejected on Brand Google OAuth');
    assert(JSON.parse(mismatchRoleRes.body).error === 'PortalMismatch', 'PortalMismatch error returned for customer email');

    const newBrandGoogleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-google',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { idToken: 'tok_new_brand_google' },
    });
    assert(newBrandGoogleRes.statusCode === 200, 'First-time Google user creates brand owner + tenant');
    const newBrandGoogleBody = JSON.parse(newBrandGoogleRes.body);
    assert(newBrandGoogleBody.isNewBrand === true, 'Brand Google OAuth flags newly created workspace');
    assert(newBrandGoogleBody.user?.role === 'BRAND_OWNER', 'Brand Google OAuth assigns BRAND_OWNER role');
    assert(Boolean(newBrandGoogleBody.user?.emailVerified), 'Brand Google OAuth marks emailVerified true');
    assert(Boolean(newBrandGoogleBody.tenant?.id && newBrandGoogleBody.tenant?.slug), 'Brand Google OAuth provisions tenant & slug');
    assert(Boolean(newBrandGoogleBody.oauthExchangeCode), 'Brand Google OAuth returns single-use oauthExchangeCode');
    assert(newBrandGoogleBody.token === undefined, 'Cookie transport omits raw access token from oauth-google response');

    // Cross-portal exchange attempt must fail without consuming valid code? Note: claim deletes? Wait: let's test wrong portal after valid OR check
    // Note: consumeOAuthExchangeCode deletes the key when retrieved, so test valid brand exchange directly first, then replay!
    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-exchange',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { code: newBrandGoogleBody.oauthExchangeCode },
    });
    assert(exchangeRes.statusCode === 200, 'Brand oauth-exchange accepts valid one-time code');
    const exchangedCookies = extractSetCookies(exchangeRes.headers['set-cookie']);
    for (const cname of ['vtry_brand_access', 'vtry_brand_refresh', 'vtry_brand_sid']) {
      assert(Boolean(exchangedCookies[cname]?.value), `Brand oauth-exchange sets ${cname} cookie`);
      assert(/;\s*HttpOnly/i.test(exchangedCookies[cname]?.raw || ''), `Brand oauth-exchange ${cname} has HttpOnly flag`);
    }

    const meAfterExchange = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `vtry_brand_access=${encodeURIComponent(exchangedCookies.vtry_brand_access?.value || '')}; vtry_brand_sid=${encodeURIComponent(exchangedCookies.vtry_brand_sid?.value || '')}`,
        'x-auth-portal': 'brand',
      },
    });
    assert(meAfterExchange.statusCode === 200, 'Exchanged HttpOnly cookies authenticate GET /api/v1/auth/me');
    assert(JSON.parse(meAfterExchange.body).user?.email === 'aria.atelier@gmail.com', 'Authenticated Google user matches profile');

    const replayExchange = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-exchange',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { code: newBrandGoogleBody.oauthExchangeCode },
    });
    assert(replayExchange.statusCode === 401, 'Replayed Brand oauthExchangeCode is rejected');

    // Returning brand user logs into existing tenant cleanly
    const returningGoogleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-google',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { idToken: 'tok_new_brand_google' },
    });
    const returningBody = JSON.parse(returningGoogleRes.body);
    assert(returningGoogleRes.statusCode === 200 && returningBody.isNewBrand === false, 'Returning Google user signs into existing brand');
    assert(returningBody.tenant?.id === newBrandGoogleBody.tenant?.id, 'Returning Google user retains exact tenantId');

    // Suspended brand tenant blocked from Google sign-in
    db.updateTenant('tenant_aura', { status: 'SUSPENDED' });
    const suspendedGoogleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth-google',
      headers: { 'x-auth-portal': 'brand', 'x-auth-transport': 'cookie' },
      payload: { idToken: 'tok_suspended_brand' },
    });
    assert(suspendedGoogleRes.statusCode === 403 && JSON.parse(suspendedGoogleRes.body).error === 'TenantSuspended', 'Suspended brand blocked on Google OAuth');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Reset snapshot cleanly back to baseline demo data
  db.reset();
  seedTestUsers();

  console.log('\n=============================================================');
  console.log(`📊 Auth Suite Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=============================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAuthTests().catch((err) => {
  console.error('Fatal auth test error:', err);
  process.exit(1);
});

