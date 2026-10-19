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
  brandApiPort: Number(process.env.BRAND_API_PORT || 4001),
  marketplaceApiPort: Number(process.env.MARKETPLACE_API_PORT || 4002),
  superAdminApiPort: Number(process.env.SUPER_ADMIN_API_PORT || 4003),
  
  jwtSecret: process.env.JWT_SECRET || 'vton_unified_jwt_secret_production_ready_2026',
  passwordSalt: process.env.PASSWORD_SALT || 'vton_production_salt_secure_2026',
  internalServiceKey: process.env.INTERNAL_SERVICE_KEY || 'vton_internal_service_key_enterprise',

  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  databaseUrl: process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '',

  cloudinaryUrl: process.env.CLOUDINARY_URL || '',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'virtual-try-on'
};
