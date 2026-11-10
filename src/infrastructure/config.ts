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
  jwtSecret: process.env.JWT_SECRET || 'vton_unified_jwt_secret_production_ready_2026',

  // AI Service & Vision Providers
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  falKey: process.env.FAL_KEY || '',
  vtonProvider: 'gemini', // Runtime selector updated via Super Admin AI Engine UI

  // Database (Supabase PostgreSQL / PostgreSQL)
  databaseUrl: process.env.DATABASE_URL || '',

  // Cloudinary Image Storage
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'virtual-try-on',

  // SMTP Email Configuration
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.SMTP_FROM || 'V-TRY Studio <noreply@v-try.fashion>',

  // Default Frontend Portal Origins (for email links)
  marketplaceUrl: 'http://localhost:3000',
  brandDashboardUrl: 'http://localhost:3001',
  superAdminUrl: 'http://localhost:3002',
};
