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

  // AI Service & Vision Providers
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  falKey: process.env.FAL_KEY || '',
  vtonProvider: 'gemini', // Runtime selector updated via Super Admin AI Engine UI

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
  databaseUrl: process.env.DATABASE_URL || '',

  // Cloudinary Image Storage
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'virtual-try-on',

  // Resend Email Delivery (Account Verification & Password Reset)
  resendApiKey: process.env.NODE_ENV === 'test' ? '' : (process.env.RESEND_API_KEY || '').trim(),
  resendFrom: (process.env.RESEND_FROM || 'V-TRY Studio <onboarding@resend.dev>').trim(),

  // Default Frontend Portal Origins (for email links)
  marketplaceUrl: (process.env.MARKETPLACE_URL || 'http://localhost:3000').trim(),
  brandDashboardUrl: (process.env.BRAND_DASHBOARD_URL || 'http://localhost:3001').trim(),
  superAdminUrl: (process.env.SUPER_ADMIN_URL || 'http://localhost:3002').trim(),
};
