import './setup_env.js';
import { config, resolveDatabaseUrl } from '../src/infrastructure/config.js';

/**
 * Safety net: automated tests must never connect to a real database.
 * This suite touches no database. It only checks how the database URL is resolved.
 */
const REAL_URL = 'postgresql://user:secret@ep-example-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('🛡️  Database safety guard for tests\n');

// 1. The live config in this very test process must not hold a database URL, even if .env defines one.
assert(process.env.NODE_ENV === 'test', 'tests run with NODE_ENV=test');
assert(config.databaseUrl === '', 'config.databaseUrl is empty during tests (real DATABASE_URL is ignored)');

// 2. Outside test mode the normal URL is used.
assert(
  resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: REAL_URL } as NodeJS.ProcessEnv) === REAL_URL,
  'production still uses DATABASE_URL',
);
assert(resolveDatabaseUrl({ DATABASE_URL: REAL_URL } as NodeJS.ProcessEnv) === REAL_URL, 'unset NODE_ENV still uses DATABASE_URL');

// 3. Test mode ignores DATABASE_URL.
assert(
  resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: REAL_URL } as NodeJS.ProcessEnv) === '',
  'test mode ignores DATABASE_URL',
);

// 4. Test mode accepts only an explicit, clearly-test database.
assert(
  resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: REAL_URL, TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/anything' } as NodeJS.ProcessEnv) ===
    'postgresql://u:p@localhost:5432/anything',
  'TEST_DATABASE_URL on localhost is accepted',
);
assert(
  resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/vton_test' } as NodeJS.ProcessEnv) ===
    'postgresql://u:p@ep-x.neon.tech/vton_test',
  'TEST_DATABASE_URL with a "test" database name is accepted',
);
assert(
  throws(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: REAL_URL } as NodeJS.ProcessEnv)),
  'TEST_DATABASE_URL pointing at a real database is refused',
);
assert(
  throws(() =>
    resolveDatabaseUrl({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/vton_test',
      TEST_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/vton_test',
    } as NodeJS.ProcessEnv),
  ),
  'TEST_DATABASE_URL identical to DATABASE_URL is refused',
);
assert(
  throws(() => resolveDatabaseUrl({ NODE_ENV: 'test', TEST_DATABASE_URL: 'not a url' } as NodeJS.ProcessEnv)),
  'an invalid TEST_DATABASE_URL is refused',
);

console.log(`\n📊 Database guard summary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
