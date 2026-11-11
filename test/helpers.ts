import { db } from '../src/infrastructure/database.js';

/** Only the super admin is seeded; tests create their own shop owner and customer like real users would. */
export function seedTestUsers() {
  const now = Date.now();
  db.createUser({
    id: 'user_aura_owner', tenantId: 'tenant_aura', name: 'Elena Rostova', email: 'elena@auraatelier.com',
    passwordHash: db.hashPassword('Test-Brand-Pass-1'), role: 'BRAND_OWNER', emailVerified: true, emailVerifiedAt: now, createdAt: now
  });
  db.createUser({
    id: 'user_customer_sarah', name: 'Sarah Miller', email: 'sarah.miller@example.com',
    passwordHash: db.hashPassword('Test-Customer-Pass-1'), role: 'CUSTOMER', emailVerified: true, emailVerifiedAt: now, createdAt: now
  });
}
