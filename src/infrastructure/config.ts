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

  // AI Service & Vision Providers
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  falKey: process.env.FAL_KEY || '',
  vtonProvider: 'gemini', // Runtime selector updated via Super Admin AI Engine UI

  // CORS: comma-separated list of allowed frontend origins (e.g. https://shop.example.com,http://localhost:3000).
  // Empty = allow any origin (development only).
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  // Database (Supabase PostgreSQL / PostgreSQL)
  databaseUrl: process.env.DATABASE_URL || '',

  // Cloudinary Image Storage
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'virtual-try-on',

  // Resend Email Delivery (Account Verification & Password Reset)
  resendApiKey: process.env.NODE_ENV === 'test' ? '' : (process.env.RESEND_API_KEY || '').trim(),
  resendFrom: (process.env.RESEND_FROM || 'V-TRY Studio<onboarding@resend.dev>').trim(),

  // Default Frontend Portal Origins (for email links)
  marketplaceUrl: 'http://localhost:3000',
  brandDashboardUrl: 'http://localhost:3001',
  superAdminUrl: 'http://localhost:3002',
};
