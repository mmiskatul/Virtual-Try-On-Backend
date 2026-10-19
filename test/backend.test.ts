import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';

let app = createApp('all');

async function runTests() {
  console.log('🧪 Running Comprehensive Unified Fastify 5 Backend Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // 1. Health & System
  console.log('--- [1. System & Health] ---');
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  assert(healthRes.statusCode === 200, 'GET /health returns 200');
  const healthBody = JSON.parse(healthRes.body);
  assert(healthBody.status === 'UP', 'Health status is UP');

  const liveRes = await app.inject({ method: 'GET', url: '/live' });
  assert(liveRes.statusCode === 200, 'GET /live returns 200');

  const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
  assert(metricsRes.statusCode === 200, 'GET /metrics returns 200');

  // 2. Brand Authentication & Operations
  console.log('\n--- [2. Brand API Operations] ---');
  const brandLoginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'elena@auraatelier.com', password: 'Aura@123456' }
  });
  assert(brandLoginRes.statusCode === 200, 'Brand login returns 200');
  const brandAuth = JSON.parse(brandLoginRes.body);
  const brandToken = brandAuth.token;
  assert(typeof brandToken === 'string', 'Brand JWT token received');

  const meRes = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${brandToken}` }
  });
  assert(meRes.statusCode === 200, 'GET /api/v1/auth/me returns 200');

  const prodsRes = await app.inject({
    method: 'GET',
    url: '/api/v1/products',
    headers: { authorization: `Bearer ${brandToken}` }
  });
  assert(prodsRes.statusCode === 200, 'GET /api/v1/products returns 200');
  const prods = JSON.parse(prodsRes.body).products;
  assert(Array.isArray(prods) && prods.length > 0, 'Products list returned');

  // Create Product
  const newProdRes = await app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: { authorization: `Bearer ${brandToken}` },
    payload: {
      name: 'Test Silk Camisole',
      category: 'Tops',
      price: 95.0,
      sku: 'TEST-CAM-001',
      isTryOnEligible: true,
      tryOnCategory: 'tops',
      variants: [
        { id: 'v_test_s', sku: 'TEST-CAM-001-S', size: 'S', color: 'Ivory', stockQuantity: 25, available: true }
      ]
    }
  });
  assert(newProdRes.statusCode === 201, 'POST /api/v1/products creates product');
  const createdProd = JSON.parse(newProdRes.body).product;

  // Inventory Adjustment
  const invAdjustRes = await app.inject({
    method: 'POST',
    url: '/api/v1/inventory/adjust',
    headers: { authorization: `Bearer ${brandToken}` },
    payload: {
      productId: createdProd.id,
      variantSku: 'TEST-CAM-001-S',
      change: -5,
      reason: 'Physical store allocation'
    }
  });
  assert(invAdjustRes.statusCode === 200, 'POST /api/v1/inventory/adjust succeeds');
  const newStock = JSON.parse(invAdjustRes.body).newStock;
  assert(newStock === 20, `Stock adjusted from 25 to 20 (got: ${newStock})`);

  // Cloudinary upload status
  const uploadStatusRes = await app.inject({ method: 'GET', url: '/api/v1/uploads/status' });
  assert(uploadStatusRes.statusCode === 200, 'GET /api/v1/uploads/status returns 200');

  // 3. Marketplace Discovery & Checkout
  console.log('\n--- [3. Marketplace Operations] ---');
  const marketProdsRes = await app.inject({ method: 'GET', url: '/api/v1/marketplace/products' });
  assert(marketProdsRes.statusCode === 200, 'GET /api/v1/marketplace/products returns 200');
  const marketProds = JSON.parse(marketProdsRes.body);
  assert(Array.isArray(marketProds) && marketProds.length > 0, 'Marketplace products found');

  // Single-seller checkout validation (Same brand - valid)
  const validCheckoutRes = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout/validate',
    payload: {
      items: [
        { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 }
      ]
    }
  });
  assert(validCheckoutRes.statusCode === 200, 'Valid single-brand cart returns 200');
  assert(JSON.parse(validCheckoutRes.body).valid === true, 'Cart validation flag is true');

  // Multi-brand checkout validation (Different brands - must reject)
  const invalidCheckoutRes = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout/validate',
    payload: {
      items: [
        { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 },
        { productId: 'prod_vogue_jacket_01', variantSku: 'VOG-BLZ-092-M', quantity: 1 }
      ]
    }
  });
  assert(invalidCheckoutRes.statusCode === 400, 'Multi-brand cart rejected with 400');
  assert(JSON.parse(invalidCheckoutRes.body).error === 'MultiSellerError', 'Error is MultiSellerError');

  // Place confirmed order
  const orderRes = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    payload: {
      items: [
        { productId: 'prod_aura_dress_01', variantSku: 'AUR-DRS-001-S', quantity: 1 }
      ],
      customerEmail: 'customer@test.com',
      shippingAddress: {
        fullName: 'Jane Doe',
        street: '123 Market St',
        city: 'New York',
        zipCode: '10001',
        country: 'US'
      }
    }
  });
  assert(orderRes.statusCode === 201, 'POST /api/v1/checkout creates order with 201');
  const orderData = JSON.parse(orderRes.body);
  assert(orderData.status === 'PROCESSING', 'Order status is PROCESSING');

  // 4. Super Admin Operations
  console.log('\n--- [4. Super Admin Governance Operations] ---');
  const adminLoginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email: 'admin@vton-platform.io', password: 'Admin@123456' }
  });
  assert(adminLoginRes.statusCode === 200, 'Super admin login returns 200');
  const adminToken = JSON.parse(adminLoginRes.body).token;
  assert(typeof adminToken === 'string', 'Super admin token received');

  const overviewRes = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/analytics/overview',
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert(overviewRes.statusCode === 200, 'GET /api/v1/admin/analytics/overview returns 200');
  const overview = JSON.parse(overviewRes.body);
  assert(overview.tenants.total >= 2, 'Tenants count returned');

  const adminTenantsRes = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/tenants',
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert(adminTenantsRes.statusCode === 200, 'GET /api/v1/admin/tenants returns 200');

  // Suspend tenant
  const suspendRes = await app.inject({
    method: 'PATCH',
    url: '/api/v1/admin/tenants/tenant_aura/status',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { status: 'SUSPENDED' }
  });
  assert(suspendRes.statusCode === 200, 'PATCH tenant status to SUSPENDED returns 200');

  // Re-activate tenant
  const activateRes = await app.inject({
    method: 'PATCH',
    url: '/api/v1/admin/tenants/tenant_aura/status',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { status: 'ACTIVE' }
  });
  assert(activateRes.statusCode === 200, 'PATCH tenant status back to ACTIVE returns 200');

  // Audit Logs
  const auditRes = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/audit-logs',
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert(auditRes.statusCode === 200, 'GET /api/v1/admin/audit-logs returns 200');
  const auditLogs = JSON.parse(auditRes.body);
  assert(Array.isArray(auditLogs) && auditLogs.length > 0, 'Audit logs recorded');

  console.log('\n=============================================================');
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
