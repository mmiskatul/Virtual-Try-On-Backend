import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const { Pool } = pg;

export interface PrismaClientOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

let activePrisma: PrismaClient | null = null;
let activePool: pg.Pool | null = null;

export function requiresSslConnection(connectionString: string): boolean {
  const lower = connectionString.toLowerCase();
  if (lower.includes('sslmode=disable')) return false;
  if (lower.includes('sslmode=require') || lower.includes('sslmode=verify-ca') || lower.includes('sslmode=verify-full')) {
    return true;
  }
  return (
    lower.includes('supabase.co') ||
    lower.includes('supabase.com') ||
    lower.includes('pooler.supabase.com') ||
    lower.includes('neon.tech')
  );
}

export function createPgPool(connectionString: string): pg.Pool {
  const isSsl = requiresSslConnection(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
  });

  // Prevent unhandled EventEmitter errors when Neon/Supabase suspends idle connections
  pool.on('error', (err) => {
    console.warn('[PostgreSQL Pool] Idle client disconnected:', err?.message || err);
  });

  return pool;
}

export function createPrismaInstance(options: PrismaClientOptions = {}): { prisma: PrismaClient; pool: pg.Pool } {
  let pool = options.pool;

  if (!pool && options.connectionString) {
    pool = createPgPool(options.connectionString);
  }

  if (!pool) {
    throw new Error('Prisma requires a connectionString or an initialized pg.Pool');
  }

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return { prisma, pool };
}

export function initGlobalPrisma(connectionString: string): PrismaClient {
  if (activePrisma) {
    return activePrisma;
  }
  const { prisma, pool } = createPrismaInstance({ connectionString });
  activePrisma = prisma;
  activePool = pool;
  return activePrisma;
}

export function getGlobalPrisma(): PrismaClient | null {
  return activePrisma;
}

export function getGlobalPool(): pg.Pool | null {
  return activePool;
}

export async function disconnectPrisma(): Promise<void> {
  if (activePrisma) {
    await activePrisma.$disconnect();
    activePrisma = null;
  }
  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}
