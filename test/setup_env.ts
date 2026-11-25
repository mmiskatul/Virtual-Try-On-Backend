import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll } from 'vitest';

// Imported first by every test so the seeded demo accounts and ephemeral secrets exist for isolated tests.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= randomBytes(32).toString('hex');
process.env.SEED_ADMIN_PASSWORD = 'Test-Admin-Pass-1';
process.env.SEED_ADMIN_EMAIL = 'admin@vton-platform.io';
// Tests use many Bearer-only requests and hammer the same endpoints; production keeps both protections on.
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ALLOW_BEARER_WITHOUT_SESSION = 'true';
// Webhook tests deliver to a local server and retry quickly.
process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
process.env.WEBHOOK_RETRY_DELAYS_MS = '20,20';
// Tests must never call the real fal.ai account, even when a developer's .env has a key. The config loader treats an
// empty value as "not set" and would read the real key from .env, so use a harmless dummy and force Gemini-only mode.
process.env.FAL_KEY = 'disabled-in-tests';
process.env.TRYON_PROVIDER = 'gemini';

// Each test file gets its own throwaway data folder, so tests never read or change the real `.data` snapshot, never
// see leftovers from earlier runs, and never affect each other. It is deleted when the file's tests finish.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vton-test-'));
process.env.DB_SNAPSHOT_PATH = path.join(testDataDir, 'db_snapshot.json');
process.env.PRIVATE_OBJECTS_DIR = path.join(testDataDir, 'private_objects');
const cleanupTestData = () => fs.rmSync(testDataDir, { recursive: true, force: true });
try {
  afterAll(cleanupTestData);
} catch {
  // Script-style tests (run with tsx, not vitest) have no suite to hook into, so clean up when the process exits.
  process.on('exit', cleanupTestData);
}
