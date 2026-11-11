import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { UserRole } from '../../domain/types.js';

export interface AuditRecordInput {
  actorId: string;
  actorRole: string;
  tenantId?: string;
  action: string;
  entity: string;
  entityId?: string;
  reason?: string;
  correlationId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}

/**
 * Masks the trailing segment of IPv4/IPv6 addresses for privacy-safe audit logs.
 */
export function maskIpAddress(ip?: string): string | undefined {
  if (!ip || typeof ip !== 'string') return undefined;
  const trimmed = ip.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    return `${parts.slice(0, Math.max(1, parts.length - 1)).join(':')}:xxxx`;
  }
  return trimmed;
}

/**
 * Appends an immutable audit entry across both legacy in-memory/SQL store and Prisma relational `audit_logs`.
 * Never throws during optional Prisma sync unless `recordAuditTx` is explicitly used inside a critical DB transaction.
 */
export async function recordAudit(input: AuditRecordInput): Promise<void> {
  const now = Date.now();
  const masked = maskIpAddress(input.ipAddress);
  const enrichedDetails = {
    ...(input.details || {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(masked ? { ipMasked: masked } : {}),
  };

  db.recordAuditLog({
    actorId: input.actorId,
    actorRole: input.actorRole as UserRole,
    tenantId: input.tenantId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    details: enrichedDetails,
  });

  const prisma = getGlobalPrisma();
  if (!prisma) return;

  try {
    await prisma.auditLog.create({
      data: {
        id: `aud_${now}_${crypto.randomBytes(4).toString('hex')}`,
        tenantId: input.tenantId ?? null,
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        ipMasked: masked ?? null,
        details: enrichedDetails,
        timestamp: BigInt(now),
      },
    });
  } catch (err: any) {
    logger.warn({ err: err?.message, action: input.action }, 'audit.prisma_write_failed');
  }
}

/**
 * Writes an audit record atomically inside an open Prisma `$transaction`.
 */
export async function recordAuditTx(tx: any, input: AuditRecordInput): Promise<void> {
  const now = Date.now();
  const masked = maskIpAddress(input.ipAddress);
  const enrichedDetails = {
    ...(input.details || {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(masked ? { ipMasked: masked } : {}),
  };

  await tx.auditLog.create({
    data: {
      id: `aud_${now}_${crypto.randomBytes(4).toString('hex')}`,
      tenantId: input.tenantId ?? null,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      reason: input.reason ?? null,
      correlationId: input.correlationId ?? null,
      ipMasked: masked ?? null,
      details: enrichedDetails,
      timestamp: BigInt(now),
    },
  });
}
