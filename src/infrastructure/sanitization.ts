const RAW_SECRET_KEYS = new Set([
  'password',
  'newPassword',
  'confirmPassword',
  'currentPassword',
  'smtpPass',
  'pass',
  'geminiApiKey',
  'falKey',
  'cloudinaryApiSecret',
  'databaseUrl',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeString(input: string): string {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '') // Strip basic HTML tags
    .trim();
}

export function sanitizeObject<T>(obj: T, parentKey?: string): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (parentKey && RAW_SECRET_KEYS.has(parentKey)) {
      return obj as any;
    }
    return sanitizeString(obj) as any;
  }
  if (Array.isArray(obj)) return obj.map((item) => sanitizeObject(item)) as any;
  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      sanitized[key] = sanitizeObject(value, key);
    }
    return sanitized;
  }
  return obj;
}
