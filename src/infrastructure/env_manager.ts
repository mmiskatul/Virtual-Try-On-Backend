import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_ENV_KEYS = new Set([
  'HOST',
  'PORT',
  'JWT_SECRET',
  'AI_SERVICE_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'FAL_KEY',
  'DATABASE_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_FOLDER',
  'RESEND_API_KEY',
  'RESEND_FROM',
]);

/**
 * Strip CR/LF control characters to prevent .env newline injection attacks.
 */
export function sanitizeEnvValue(value: unknown): string {
  if (typeof value !== 'string') {
    return String(value ?? '').replace(/[\r\n\0]/g, '').trim();
  }
  return value.replace(/[\r\n\0]/g, '').trim();
}

export function isMaskedPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (trimmed.includes('••••') || trimmed.includes('...')) && trimmed.length < 32;
}

export function maskSecret(value?: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function maskConnectionString(uri?: string): string {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = '••••••••';
    }
    return parsed.toString();
  } catch {
    return maskSecret(uri);
  }
}

export function updateEnvFile(updates: Record<string, string>): boolean {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return false;
    }

    let envContent = fs.readFileSync(envPath, 'utf-8');
    for (const [key, rawVal] of Object.entries(updates)) {
      if (!ALLOWED_ENV_KEYS.has(key)) continue;
      const safeVal = sanitizeEnvValue(rawVal);
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${safeVal}`);
      } else {
        envContent += `\n${key}=${safeVal}`;
      }
    }

    fs.writeFileSync(envPath, envContent, 'utf-8');
    return true;
  } catch (err: any) {
    console.warn('[EnvManager] Failed to update .env file:', err?.message || err);
    return false;
  }
}
