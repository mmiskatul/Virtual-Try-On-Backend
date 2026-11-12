import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().min(16),

  DATABASE_URL: z.string().optional().default(''),
  DIRECT_URL: z.string().optional().default(''),

  // Optional Supabase integration
  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_ANON_KEY: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  SUPABASE_JWT_SECRET: z.string().optional().default(''),

  // Optional Google OAuth Client ID (audience verification for Google sign-in across portals)
  GOOGLE_CLIENT_ID: z.string().optional().default(''),

  // Async infra
  RABBITMQ_URL: z.string().optional().default(''),
  REDIS_URL: z.string().optional().default(''),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  PUBLIC_BACKEND_URL: z.string().optional().default('http://localhost:4000'),

  // Storage & AI Providers
  STORAGE_DRIVER: z.enum(['auto', 'supabase', 'local']).default('auto'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  FAL_KEY: z.string().optional().default(''),

  // Resend Email Delivery
  RESEND_API_KEY: z.string().optional().default(''),
  RESEND_FROM: z.string().optional().default('V-TRY Studio <onboarding@resend.dev>'),

  CORS_ORIGINS: z.string().optional().default(''),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

let cachedEnv: ValidatedEnv | null = null;

export function getValidatedEnv(): ValidatedEnv {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}

