import { randomBytes } from 'node:crypto';
import process from 'node:process';

// Imported first by every test so the seeded demo accounts and ephemeral secrets exist for isolated tests.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= randomBytes(32).toString('hex');
process.env.SEED_ADMIN_PASSWORD = 'Test-Admin-Pass-1';
process.env.SEED_ADMIN_EMAIL = 'admin@vton-platform.io';
// Tests use many Bearer-only requests and hammer the same endpoints; production keeps both protections on.
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ALLOW_BEARER_WITHOUT_SESSION = 'true';
