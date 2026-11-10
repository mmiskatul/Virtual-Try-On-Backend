import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';
import { requiresSslConnection } from '../src/infrastructure/prisma.js';
import { sanitizeEnvValue } from '../src/infrastructure/env_manager.js';
import { sanitizeObject } from '../src/infrastructure/sanitization.js';

const app = createApp('all');

async function runSecurityTests() {
  db.reset();
  console.log('\n=============================================================');
  console.log('🛡️  Running Security, Vulnerability & Infrastructure Tests');
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

  // 1. Sanitization & Prototype Pollution Protection
  console.log('--- [1. Input Sanitization & Secret Preservation] ---');
  const sanitized = sanitizeObject({
    name: '  <b>Maya</b>  ',
    password: ' <Pass123> ',
    __proto__: { polluted: true },
  });
  assert(sanitized.name === 'bMaya/b', 'HTML angle brackets stripped from normal fields');
  assert(sanitized.password === ' <Pass123> ', 'Passwords preserve angle brackets and spaces verbatim');
  assert((sanitized as any).polluted === undefined, 'Prototype pollution keys dropped');
  assert(sanitizeEnvValue('smtp.gmail.com\r\nJWT_SECRET=evil') === 'smtp.gmail.comJWT_SECRET=evil', 'CR/LF stripped to prevent .env injection');

  // 2. Supabase & SSL Detection
  console.log('\n--- [2. Supabase SSL Detection] ---');
  assert(requiresSslConnection('postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'), 'Supabase pooler enables SSL');
  assert(requiresSslConnection('postgresql://postgres:pw@db.xyz.supabase.co:5432/postgres'), 'Supabase direct enables SSL');
  assert(requiresSslConnection('postgresql://user:pw@ep-cool.neon.tech/neondb'), 'Neon enables SSL');
  assert(!requiresSslConnection('postgresql://postgres:pw@localhost:5432/vton'), 'Local Postgres does not force SSL');
  assert(!requiresSslConnection('postgresql://postgres:pw@db.xyz.supabase.co:5432/postgres?sslmode=disable'), 'Explicit sslmode=disable respected');

  // Login tokens for role tests
  const custLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/login',
    payload: { email: 'sarah.miller@example.com', password: 'password123' },
  });
  const custToken = JSON.parse(custLogin.body).token;

  const brandLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'elena@auraatelier.com', password: 'Aura@123456' },
  });
  const brandToken = JSON.parse(brandLogin.body).token;

  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'admin@vton-platform.io', password: 'Admin@123456' },
  });
  const adminToken = JSON.parse(adminLogin.body).token;

  // 3. Role & Tenant Authorization Guards
  console.log('\n--- [3. Role & Tenant Authorization] ---');
  for (const [method, url] of [
    ['GET', '/api/v1/products'],
    ['GET', '/api/v1/fabrics'],
    ['GET', '/api/v1/brand/orders'],
    ['GET', '/api/v1/inventory/logs'],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${custToken}` },
    });
    assert(res.statusCode === 403, `Customer blocked from ${method} ${url} (got ${res.statusCode})`);
  }

  const unauthInternal = await app.inject({ method: 'GET', url: '/api/v1/internal/tenants' });
  assert(unauthInternal.statusCode === 401, 'GET /api/v1/internal/tenants blocks unauthenticated caller');

  const custInternal = await app.inject({
    method: 'GET',
    url: '/api/v1/internal/tenants',
    headers: { authorization: `Bearer ${custToken}` },
  });
  assert(custInternal.statusCode === 403, 'GET /api/v1/internal/tenants blocks non-admin caller');

  const adminInternal = await app.inject({
    method: 'GET',
    url: '/api/v1/internal/tenants',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert(adminInternal.statusCode === 200, 'GET /api/v1/internal/tenants allows Super Admin token');

  const pubStorefront = await app.inject({ method: 'GET', url: '/api/v1/internal/storefront/aura-atelier' });
  const pubStorefrontBody = JSON.parse(pubStorefront.body);
  assert(pubStorefront.statusCode === 200 && pubStorefrontBody.tenant.contactEmail === undefined, 'Public storefront omits private contactEmail');

  // 4. Checkout Negative Quantity & Invalid Order Status Fixes
  console.log('\n--- [4. Checkout & Order Input Validation] ---');
  const negCheckout = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    payload: {
      items: [{ productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: -5 }],
      customerEmail: 'buyer@example.com',
      shippingAddress: { fullName: 'Buyer', street: '123 St', city: 'NYC', zipCode: '10001', country: 'US' },
    },
  });
  assert(negCheckout.statusCode === 400, 'Negative checkout quantity rejected with 400');

  const badOrderStatus = await app.inject({
    method: 'PATCH',
    url: '/api/v1/brand/orders/ord_demo_1001/status',
    headers: { authorization: `Bearer ${brandToken}` },
    payload: { status: 'HACKED_STATUS' },
  });
  assert(badOrderStatus.statusCode === 400, 'Invalid order status rejected with 400');

  // 5. Try-On JobId SSRF / Path Traversal Protection
  console.log('\n--- [5. SSRF & Path Traversal Guards] ---');
  const badJobId = await app.inject({
    method: 'GET',
    url: '/api/v1/try-on/status/..%2F..%2Fadmin',
  });
  assert(badJobId.statusCode === 400, 'Path traversal jobId rejected with 400');

  // 6. Secret Masking & Infrastructure Admin API
  console.log('\n--- [6. Admin Infrastructure & Secret Masking] ---');
  const aiCfgRes = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/ai-engine/config',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const aiCfg = JSON.parse(aiCfgRes.body);
  assert(aiCfgRes.statusCode === 200, 'GET /api/v1/admin/ai-engine/config returns 200');
  assert(aiCfg.gemini.apiKey === undefined && aiCfg.fal.apiKey === undefined, 'Plaintext API keys not leaked in AI config response');

  const infraCust = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/infrastructure/config',
    headers: { authorization: `Bearer ${custToken}` },
  });
  assert(infraCust.statusCode === 403, 'Non-admin blocked from /api/v1/admin/infrastructure/config');

  const infraAdmin = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/infrastructure/config',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert(infraAdmin.statusCode === 200, 'Admin can read /api/v1/admin/infrastructure/config');

  const badDbTest = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/infrastructure/database/test',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { databaseUrl: 'http://169.254.169.254/latest/meta-data/' },
  });
  assert(badDbTest.statusCode === 400, 'Database test rejects non-Postgres SSRF URL');

  // 7. OTP Brute-Force Lockout
  console.log('\n--- [7. OTP Brute-Force Lockout] ---');
  await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/auth/register',
    payload: { name: 'Brute Test', email: 'brute@example.com', password: 'Password123' },
  });
  let lockedOut = false;
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/auth/verify-email',
      payload: { email: 'brute@example.com', code: '000000' },
    });
    if (res.statusCode === 429) {
      lockedOut = true;
      break;
    }
  }
  assert(lockedOut, 'Repeated invalid OTP attempts trigger 429 lockout and token invalidation');

  db.reset();

  console.log('\n=============================================================');
  console.log(`📊 Security Suite Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=============================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runSecurityTests().catch((err) => {
  console.error('Fatal security test error:', err);
  process.exit(1);
});

