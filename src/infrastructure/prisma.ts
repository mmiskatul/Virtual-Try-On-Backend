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

export function createPrismaInstance(options: PrismaClientOptions = {}): { prisma: PrismaClient; pool: pg.Pool } {
  let pool = options.pool;

  if (!pool && options.connectionString) {
    const isSsl = options.connectionString.includes('sslmode=require') || options.connectionString.includes('neon.tech');
    pool = new Pool({
      connectionString: options.connectionString,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
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
