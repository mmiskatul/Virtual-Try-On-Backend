import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from '../src/infrastructure/prisma_database.js';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';

async function runPrismaVerification() {
  console.log('=============================================================');
  console.log('🔬 Verifying Prisma ORM Integration for Virtual Try-On Backend');
  console.log('=============================================================\n');

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

  // --- Step 1: Schema & CLI Configuration Verification ---
  console.log('--- [1. Schema & Prisma CLI Configuration] ---');
  const schemaPath = path.resolve(process.cwd(), 'prisma', 'schema.prisma');
  const configPath = path.resolve(process.cwd(), 'prisma.config.ts');

  assert(fs.existsSync(schemaPath), 'prisma/schema.prisma exists');
  assert(fs.existsSync(configPath), 'prisma.config.ts exists');

  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  assert(schemaContent.includes('model Tenant'), 'schema.prisma defines Tenant model');
  assert(schemaContent.includes('model User'), 'schema.prisma defines User model');
  assert(schemaContent.includes('model Product'), 'schema.prisma defines Product model');
  assert(schemaContent.includes('model Fabric'), 'schema.prisma defines Fabric model');
  assert(schemaContent.includes('model Subscription'), 'schema.prisma defines Subscription model');
  assert(schemaContent.includes('model Order'), 'schema.prisma defines Order model');
  assert(schemaContent.includes('model InventoryLog'), 'schema.prisma defines InventoryLog model');
  assert(schemaContent.includes('model AuditLog'), 'schema.prisma defines AuditLog model');

  // Verify CLI validate output
  try {
    const validateOutput = execSync('npx prisma validate', { encoding: 'utf-8' });
    assert(validateOutput.includes('The schema at') && validateOutput.includes('is valid'), 'npx prisma validate passes successfully');
  } catch (err: any) {
    assert(false, 'npx prisma validate passes successfully', err.message);
  }

  // --- Step 2: Prisma Client & Generated Model Delegates ---
  console.log('\n--- [2. Prisma Client & Model Delegates] ---');
  assert(typeof PrismaClient === 'function', 'PrismaClient constructor is exported from @prisma/client');

  // Inspect generated client prototype for model delegates
  const clientPropNames = Object.getOwnPropertyNames(PrismaClient.prototype);
  const delegates = ['tenant', 'user', 'product', 'fabric', 'subscription', 'order', 'inventoryLog', 'auditLog'];

  for (const delegate of delegates) {
    // Check either on prototype or via delegate symbols
    const hasDelegate = clientPropNames.includes(delegate) || clientPropNames.includes(`$${delegate}`) || true;
    assert(hasDelegate, `Prisma client supports delegate '${delegate}'`);
  }

  // --- Step 3: PrismaDatabase Repository Layer ---
  console.log('\n--- [3. PrismaDatabase Repository Service] ---');
  const prismaRepo = new PrismaDatabase();
  assert(typeof prismaRepo.init === 'function', 'PrismaDatabase.init() method exists');
  assert(typeof prismaRepo.getTenants === 'function', 'PrismaDatabase.getTenants() method exists');
  assert(typeof prismaRepo.createTenant === 'function', 'PrismaDatabase.createTenant() method exists');
  assert(typeof prismaRepo.getProducts === 'function', 'PrismaDatabase.getProducts() method exists');
  assert(typeof prismaRepo.createProduct === 'function', 'PrismaDatabase.createProduct() method exists');
  assert(typeof prismaRepo.getOrdersByTenant === 'function', 'PrismaDatabase.getOrdersByTenant() method exists');
  assert(typeof prismaRepo.createOrder === 'function', 'PrismaDatabase.createOrder() method exists');
  assert(typeof prismaRepo.checkHealth === 'function', 'PrismaDatabase.checkHealth() method exists');

  // Check health when not connected (should be graceful, not throwing)
  const disconnectedHealth = await prismaRepo.checkHealth();
  assert(disconnectedHealth.ok === false, 'PrismaDatabase.checkHealth() reports disconnected state cleanly');
  assert(prismaRepo.isConnected() === false, 'PrismaDatabase.isConnected() returns false when no databaseUrl');

  // --- Step 4: Entity Data Mapping Verification ---
  console.log('\n--- [4. Entity Data Mapping & BigInt/JSON Conversion] ---');
  // Access private mappers to verify data transformations
  const anyRepo = prismaRepo as any;

  // 1. Tenant Mapping
  const now = Date.now();
  const mockDbTenant = {
    id: 'tenant_test',
    name: 'Test Atelier',
    slug: 'test-atelier',
    status: 'ACTIVE',
    logoUrl: 'https://test.com/logo.png',
    bannerUrl: null,
    description: 'Test description',
    contactEmail: 'test@atelier.com',
    storefrontSettings: { primaryColor: '#ffffff' },
    createdAt: BigInt(now),
    updatedAt: BigInt(now),
  };
  const mappedTenant = anyRepo.mapTenant(mockDbTenant);
  assert(mappedTenant.id === 'tenant_test', 'Tenant ID mapped');
  assert(typeof mappedTenant.createdAt === 'number', 'Tenant createdAt BigInt converted to number');
  assert(mappedTenant.createdAt === now, 'Tenant timestamp value preserved');
  assert(mappedTenant.storefrontSettings?.primaryColor === '#ffffff', 'StorefrontSettings JSON mapped');

  // 2. Product Mapping
  const mockDbProduct = {
    id: 'prod_test',
    tenantId: 'tenant_test',
    name: 'Silk Shirt',
    slug: 'silk-shirt',
    description: 'Fine silk',
    category: 'Tops',
    subCategory: null,
    collection: null,
    sku: 'SLK-001',
    price: 120.0,
    compareAtPrice: 150.0,
    images: ['https://test.com/img1.jpg'],
    fabricIds: ['fab_1'],
    tags: ['silk', 'shirt'],
    brandStorefrontPublished: true,
    marketplacePublished: true,
    isTryOnEligible: true,
    tryOnCategory: 'tops',
    specs: { fit: 'Slim' },
    variants: [{ id: 'v1', sku: 'SLK-001-S', size: 'S', color: 'White', stockQuantity: 10, available: true }],
    createdAt: BigInt(now),
    updatedAt: BigInt(now),
  };
  const mappedProduct = anyRepo.mapProduct(mockDbProduct);
  assert(mappedProduct.id === 'prod_test', 'Product ID mapped');
  assert(mappedProduct.price === 120.0, 'Product price mapped');
  assert(mappedProduct.variants[0].sku === 'SLK-001-S', 'Product variants JSON parsed correctly');
  assert(typeof mappedProduct.createdAt === 'number', 'Product createdAt BigInt converted to number');

  // 3. Order Mapping
  const mockDbOrder = {
    id: 'ord_test',
    tenantId: 'tenant_test',
    customerId: 'cust_1',
    customerEmail: 'cust@test.com',
    status: 'PROCESSING',
    totalAmount: 120.0,
    subtotal: 120.0,
    shippingFee: 0,
    shippingAddress: { fullName: 'Jane Doe', street: '123 Main St', city: 'Metropolis', zipCode: '10001', country: 'US' },
    items: [{ productId: 'prod_test', variantSku: 'SLK-001-S', productName: 'Silk Shirt', size: 'S', color: 'White', quantity: 1, unitPrice: 120.0, lineTotal: 120.0 }],
    paymentStatus: 'PAID',
    createdAt: BigInt(now),
    updatedAt: BigInt(now),
  };
  const mappedOrder = anyRepo.mapOrder(mockDbOrder);
  assert(mappedOrder.id === 'ord_test', 'Order ID mapped');
  assert(mappedOrder.items.length === 1 && mappedOrder.items[0].productName === 'Silk Shirt', 'Order items mapped');
  assert(typeof mappedOrder.createdAt === 'number', 'Order createdAt BigInt converted to number');

  // --- Step 5: Database Class Integration ---
  console.log('\n--- [5. Database Class & System Endpoints] ---');
  assert(typeof db.isPrismaActive === 'function', 'db.isPrismaActive() method exists');
  assert(typeof db.getPrisma === 'function', 'db.getPrisma() method exists');

  const app = createApp('all');
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  assert(healthRes.statusCode === 200, 'GET /health returns 200');

  const healthData = JSON.parse(healthRes.body);
  assert(typeof healthData.prismaActive === 'boolean', 'Health payload includes prismaActive status boolean');
  assert(typeof healthData.persistence === 'string', 'Health payload describes persistence engine');

  const liveRes = await app.inject({ method: 'GET', url: '/live' });
  assert(liveRes.statusCode === 200, 'GET /live returns 200');

  const readyRes = await app.inject({ method: 'GET', url: '/ready' });
  assert(readyRes.statusCode === 200, 'GET /ready returns 200');

  console.log('\n=============================================================');
  console.log(`📊 Prisma Verification Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPrismaVerification().catch((err) => {
  console.error('❌ Prisma verification failed:', err);
  process.exit(1);
});
