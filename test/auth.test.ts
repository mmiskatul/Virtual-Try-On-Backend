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

