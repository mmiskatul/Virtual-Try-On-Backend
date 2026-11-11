import crypto from 'node:crypto';

// Imported first by every test so the seeded demo accounts and ephemeral secrets exist for isolated tests.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.INTERNAL_SERVICE_KEY ||= crypto.randomBytes(24).toString('hex');
process.env.SEED_ADMIN_PASSWORD = 'Test-Admin-Pass-1';
process.env.SEED_ADMIN_EMAIL = 'admin@vton-platform.io';
