import fs from 'node:fs';
import path from 'node:path';

// Load .env automatically if present
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...rest] = trimmed.split('=');
        const v = rest.join('=').trim();
        const key = k.trim();
        if (!process.env[key]) {
          process.env[key] = v;
        }
      }
    }
  } catch {
    // Ignore .env read errors
  }
}

/**
 * Test safety: automated tests must never touch a real database. In test mode DATABASE_URL (from the
 * environment or .env) is ignored and tests run in memory. A database is used only when TEST_DATABASE_URL is
 * set explicitly, and only if it is local or its name contains "test".
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV !== 'test') return env.DATABASE_URL || '';

  const testUrl = (env.TEST_DATABASE_URL || '').trim();
  if (!testUrl) return '';

  let host = '';
  let dbName = '';
  try {
    const parsed = new URL(testUrl);
    host = parsed.hostname.toLowerCase();
    dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  } catch {
    throw new Error('Refusing to run tests: TEST_DATABASE_URL is not a valid connection URL.');
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!isLocal && !dbName.includes('test')) {
    throw new Error(
      'Refusing to run tests against a non-test database. TEST_DATABASE_URL must point at localhost ' +
        'or at a database whose name contains "test".',
    );
  }
  if (env.DATABASE_URL && env.DATABASE_URL.trim() === testUrl) {
    throw new Error('Refusing to run tests: TEST_DATABASE_URL must not be the same as DATABASE_URL.');
  }
  return testUrl;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || '',

  // Reverse proxy: when true, the real client IP comes from X-Forwarded-For (needed for rate limiting and
  // for detecting HTTPS behind a load balancer). Defaults to true in production (managed hosts always sit
  // behind a proxy). Set TRUST_PROXY=false if the API is exposed directly to the internet.
  trustProxy:
    process.env.TRUST_PROXY !== undefined
      ? process.env.TRUST_PROXY.toLowerCase() === 'true'
      : process.env.NODE_ENV === 'production',

  // Interactive API docs expose the full API map: off in production unless ENABLE_DOCS=true.
  enableDocs:
    process.env.ENABLE_DOCS !== undefined
      ? process.env.ENABLE_DOCS.toLowerCase() === 'true'
      : process.env.NODE_ENV !== 'production',

  // Virtual try-on runs inside this backend by calling Google Gemini directly.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // A vision model writes the fitting prompt. If this is an image model, it is also used to create the picture.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  // The image model that creates the try-on picture (used when GEMINI_MODEL is not an image model).
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',

  // CORS: comma-separated list of allowed frontend origins (e.g. https://shop.example.com,http://localhost:3000).
  // The official domains above are always included; CORS_ORIGINS only adds extras.
  corsOrigins: Array.from(
    new Set([
      // Official V-TRY Studio production frontends (always trusted).
      'https://vtrystudio.com',
      'https://www.vtrystudio.com',
      'https://shop.brand.vtrystudio.com',
      'https://admin.vtrystudio.com',
      // Local development frontends (never in production).
      ...(process.env.NODE_ENV === 'production'
        ? []
        : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002']),
      // Extra origins from env (comma-separated).
      ...(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        // A wildcard cannot be combined with sign-in cookies (browsers reject it), so it is ignored: list real origins instead.
        .filter((o) => Boolean(o) && o !== '*'),
    ]),
  ),

  // Database (Supabase PostgreSQL / PostgreSQL)
  databaseUrl: resolveDatabaseUrl(),

  // Cloudinary Image Storage
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'virtual-try-on',

  // Resend Email Delivery (Account Verification & Password Reset)
  resendApiKey: process.env.NODE_ENV === 'test' ? '' : (process.env.RESEND_API_KEY || '').trim(),
  resendFrom: (process.env.RESEND_FROM || 'V-TRY Studio <onboarding@resend.dev>').trim(),

  // Default Frontend Portal Origins (for email links)
  // Frontend URLs are not configured in .env: production uses the official domains, local dev uses localhost.
  // (Optional env overrides remain supported for staging.)
  marketplaceUrl: (
    process.env.MARKETPLACE_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://vtrystudio.com' : 'http://localhost:3000')
  ).trim(),
  brandDashboardUrl: (
    process.env.BRAND_DASHBOARD_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://shop.brand.vtrystudio.com' : 'http://localhost:3001')
  ).trim(),
  superAdminUrl: (
    process.env.SUPER_ADMIN_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://admin.vtrystudio.com' : 'http://localhost:3002')
  ).trim(),
};
