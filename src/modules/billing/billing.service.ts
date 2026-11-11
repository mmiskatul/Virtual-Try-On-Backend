import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { SubscriptionPlan } from '../../domain/types.js';
import { recordAudit } from '../audit/audit.service.js';

export interface PlanEntitlementDto {
  featureKey: string;
  state: 'ENABLED' | 'DISABLED' | 'LIMIT';
  limitValue?: number | null;
}

export interface PlanDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  trialDays: number;
  publicVisible: boolean;
  entitlements: PlanEntitlementDto[];
}

export interface CreditAccountDto {
  tenantId: string;
  availableCredits: number;
  reservedCredits: number;
  promoCredits: number;
  updatedAt: string;
}

export interface CreditLedgerDto {
  id: string;
  tenantId: string;
  type: 'ALLOCATE' | 'PROMO_GRANT' | 'MANUAL_ADD' | 'MANUAL_DEDUCT' | 'RESERVE' | 'CONSUME' | 'RELEASE';
  delta: number;
  balanceAfter: number;
  reason: string;
  actor: string;
  referenceId: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface InvoiceDto {
  id: string;
  tenantId: string;
  invoiceNo: string;
  period: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  currency: string;
  status: 'PAID' | 'OPEN' | 'VOID';
  dueDate: string;
  issuedAt: string;
}

const DEFAULT_PLANS: PlanDto[] = [
  {
    id: 'plan_starter',
    slug: 'STARTER',
    name: 'Starter Atelier',
    description: 'Essential virtual try-on & storefront tools for boutique fashion brands.',
    monthlyPrice: 49,
    annualPrice: 470,
    currency: 'USD',
    trialDays: 14,
    publicVisible: true,
    entitlements: [
      { featureKey: 'max_products', state: 'LIMIT', limitValue: 50 },
      { featureKey: 'monthly_tryons', state: 'LIMIT', limitValue: 500 },
      { featureKey: 'high_fidelity_vton', state: 'DISABLED', limitValue: 0 },
      { featureKey: 'api_webhooks', state: 'DISABLED', limitValue: 0 },
    ],
  },
  {
    id: 'plan_pro',
    slug: 'PRO',
    name: 'Pro Studio',
    description: 'High-fidelity VTON models, marketplace featuring, and team collaboration.',
    monthlyPrice: 149,
    annualPrice: 1430,
    currency: 'USD',
    trialDays: 14,
    publicVisible: true,
    entitlements: [
      { featureKey: 'max_products', state: 'LIMIT', limitValue: 250 },
      { featureKey: 'monthly_tryons', state: 'LIMIT', limitValue: 2500 },
      { featureKey: 'high_fidelity_vton', state: 'ENABLED', limitValue: 1 },
      { featureKey: 'api_webhooks', state: 'ENABLED', limitValue: 1 },
    ],
  },
  {
    id: 'plan_enterprise',
    slug: 'ENTERPRISE',
    name: 'Enterprise Maison',
    description: 'Dedicated high-throughput GPU routing, multi-brand staff RBAC, and SLAs.',
    monthlyPrice: 499,
    annualPrice: 4790,
    currency: 'USD',
    trialDays: 30,
    publicVisible: true,
    entitlements: [
      { featureKey: 'max_products', state: 'LIMIT', limitValue: 10000 },
      { featureKey: 'monthly_tryons', state: 'LIMIT', limitValue: 15000 },
      { featureKey: 'high_fidelity_vton', state: 'ENABLED', limitValue: 1 },
      { featureKey: 'api_webhooks', state: 'ENABLED', limitValue: 1 },
    ],
  },
];

const memoryPlans = new Map<string, PlanDto>(DEFAULT_PLANS.map((p) => [p.id, p]));
const memoryCredits = new Map<string, CreditAccountDto>();
const memoryLedger: CreditLedgerDto[] = [];
const memoryInvoices: InvoiceDto[] = [];
const processedIdemKeys = new Set<string>();

export class BillingCreditService {
  private ensureMemoryCreditAccount(tenantId: string): CreditAccountDto {
    let acc = memoryCredits.get(tenantId);
    if (!acc) {
      const sub = db.getSubscription(tenantId);
      const remaining = sub ? Math.max(0, sub.tryOnMonthlyQuota - sub.tryOnUsed) : 500;
      acc = {
        tenantId,
        availableCredits: remaining,
        reservedCredits: 0,
        promoCredits: 0,
        updatedAt: new Date().toISOString(),
      };
      memoryCredits.set(tenantId, acc);
    }
    return acc;
  }

  public async seedDefaultPlans(): Promise<PlanDto[]> {
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        for (const p of DEFAULT_PLANS) {
          await prisma.plan.upsert({
            where: { id: p.id },
            update: {},
            create: {
              id: p.id,
              slug: p.slug,
              name: p.name,
              description: p.description,
              monthlyPrice: p.monthlyPrice,
              annualPrice: p.annualPrice,
              currency: p.currency,
              trialDays: p.trialDays,
              publicVisible: p.publicVisible,
            },
          });
          for (const ent of p.entitlements) {
            await prisma.planEntitlement.upsert({
              where: { planId_featureKey: { planId: p.id, featureKey: ent.featureKey } },
              update: {},
              create: {
                planId: p.id,
                featureKey: ent.featureKey,
                state: ent.state,
                limitValue: ent.limitValue ?? null,
              },
            });
          }
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.seed_plans_prisma_warning');
      }
    }
    return Array.from(memoryPlans.values());
  }

  public async listPlans(includeHidden = false): Promise<PlanDto[]> {
    await this.seedDefaultPlans();
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const rows = await prisma.plan.findMany({
          where: includeHidden ? {} : { publicVisible: true },
          include: { entitlements: true },
          orderBy: { monthlyPrice: 'asc' },
        });
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            id: r.id,
            slug: r.slug,
            name: r.name,
            description: r.description || '',
            monthlyPrice: Number(r.monthlyPrice),
            annualPrice: Number(r.annualPrice),
            currency: r.currency,
            trialDays: r.trialDays,
            publicVisible: r.publicVisible,
            entitlements: (r.entitlements || []).map((e: any) => ({
              featureKey: e.featureKey,
              state: e.state,
              limitValue: e.limitValue,
            })),
          }));
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.list_plans_prisma_warning');
      }
    }
    return Array.from(memoryPlans.values()).filter((p) => includeHidden || p.publicVisible);
  }

  public async upsertPlan(input: PlanDto, actorId: string, actorRole: string, correlationId?: string): Promise<PlanDto> {
    memoryPlans.set(input.id, input);
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.plan.upsert({
          where: { id: input.id },
          update: {
            name: input.name,
            description: input.description,
            monthlyPrice: input.monthlyPrice,
            annualPrice: input.annualPrice,
            currency: input.currency,
            trialDays: input.trialDays,
            publicVisible: input.publicVisible,
          },
          create: {
            id: input.id,
            slug: input.slug,
            name: input.name,
            description: input.description,
            monthlyPrice: input.monthlyPrice,
            annualPrice: input.annualPrice,
            currency: input.currency,
            trialDays: input.trialDays,
            publicVisible: input.publicVisible,
          },
        });
        for (const ent of input.entitlements) {
          await prisma.planEntitlement.upsert({
            where: { planId_featureKey: { planId: input.id, featureKey: ent.featureKey } },
            update: { state: ent.state, limitValue: ent.limitValue ?? null },
            create: { planId: input.id, featureKey: ent.featureKey, state: ent.state, limitValue: ent.limitValue ?? null },
          });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.upsert_plan_prisma_warning');
      }
    }

    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_PLAN_UPSERTED',
      entity: 'Plan',
      entityId: input.id,
      correlationId,
      details: { slug: input.slug, monthlyPrice: input.monthlyPrice },
    });

    return input;
  }

  public async getCreditBalance(tenantId: string): Promise<CreditAccountDto> {
    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const row = await prisma.aiCreditAccount.findUnique({ where: { tenantId } });
        if (row) {
          const dto: CreditAccountDto = {
            tenantId: row.tenantId,
            availableCredits: row.availableCredits,
            reservedCredits: row.reservedCredits,
            promoCredits: row.promoCredits,
            updatedAt: row.updatedAt.toISOString(),
          };
          memoryCredits.set(tenantId, dto);
          return dto;
        }
      } catch {
        // fallback to memory
      }
    }
    return this.ensureMemoryCreditAccount(tenantId);
  }

  /**
   * Atomically reserves credits for an AI generation job using PostgreSQL `SELECT ... FOR UPDATE` row locking
   * when Prisma is connected, plus strict idempotency key deduplication so concurrent requests cannot overdraft.
   */
  public async reserveCredits(input: {
    tenantId: string;
    units?: number;
    generationId: string;
    actor: string;
    idempotencyKey?: string;
  }): Promise<{ ok: true; balanceAfter: number } | { ok: false; error: 'INSUFFICIENT_CREDITS' }> {
    const units = input.units ?? 1;
    const idemKey = input.idempotencyKey || `reserve:${input.generationId}`;
    if (processedIdemKeys.has(idemKey)) {
      const bal = await this.getCreditBalance(input.tenantId);
      return { ok: true, balanceAfter: bal.availableCredits + bal.promoCredits };
    }

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const result = await prisma.$transaction(async (tx: any) => {
          const acc = this.ensureMemoryCreditAccount(input.tenantId);
          await tx.$executeRaw`
            INSERT INTO ai_credit_accounts (id, tenant_id, available_credits, reserved_credits, promo_credits, updated_at)
            VALUES (${crypto.randomUUID()}::uuid, ${input.tenantId}, ${acc.availableCredits}, 0, ${acc.promoCredits}, NOW())
            ON CONFLICT (tenant_id) DO NOTHING
          `;

          const rows = await tx.$queryRaw<Array<{ available_credits: number; reserved_credits: number; promo_credits: number }>>`
            SELECT available_credits, reserved_credits, promo_credits
            FROM ai_credit_accounts
            WHERE tenant_id = ${input.tenantId}
            FOR UPDATE
          `;

          const locked = rows[0];
          const totalSpendable = locked.available_credits + locked.promo_credits;
          if (totalSpendable < units) {
            return { ok: false as const, error: 'INSUFFICIENT_CREDITS' as const };
          }

          const fromPromo = Math.min(locked.promo_credits, units);
          const fromAvail = units - fromPromo;
          const nextAvail = locked.available_credits - fromAvail;
          const nextPromo = locked.promo_credits - fromPromo;
          const nextReserved = locked.reserved_credits + units;

          await tx.aiCreditAccount.update({
            where: { tenantId: input.tenantId },
            data: { availableCredits: nextAvail, promoCredits: nextPromo, reservedCredits: nextReserved },
          });

          const balAfter = nextAvail + nextPromo;
          await tx.aiCreditLedger.create({
            data: {
              tenantId: input.tenantId,
              type: 'RESERVE',
              delta: -units,
              balanceAfter: balAfter,
              reason: `Reserve ${units} unit(s) for generation ${input.generationId}`,
              actor: input.actor,
              referenceId: input.generationId,
              idempotencyKey: idemKey,
            },
          });

          memoryCredits.set(input.tenantId, {
            tenantId: input.tenantId,
            availableCredits: nextAvail,
            promoCredits: nextPromo,
            reservedCredits: nextReserved,
            updatedAt: new Date().toISOString(),
          });
          return { ok: true as const, balanceAfter: balAfter };
        });

        if (result.ok) processedIdemKeys.add(idemKey);
        return result;
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.reserve_credits_prisma_fallback');
      }
    }

    // Synchronous in-memory atomic section when running offline tests
    const acc = this.ensureMemoryCreditAccount(input.tenantId);
    const totalSpendable = acc.availableCredits + acc.promoCredits;
    if (totalSpendable < units) {
      return { ok: false, error: 'INSUFFICIENT_CREDITS' };
    }
    const fromPromo = Math.min(acc.promoCredits, units);
    const fromAvail = units - fromPromo;
    acc.promoCredits -= fromPromo;
    acc.availableCredits -= fromAvail;
    acc.reservedCredits += units;
    acc.updatedAt = new Date().toISOString();
    processedIdemKeys.add(idemKey);

    const balanceAfter = acc.availableCredits + acc.promoCredits;
    memoryLedger.unshift({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      type: 'RESERVE',
      delta: -units,
      balanceAfter,
      reason: `Reserve ${units} unit(s) for generation ${input.generationId}`,
      actor: input.actor,
      referenceId: input.generationId,
      idempotencyKey: idemKey,
      createdAt: new Date().toISOString(),
    });

    return { ok: true, balanceAfter };
  }

  public async settleCredits(input: {
    tenantId: string;
    generationId: string;
    outcome: 'CONSUME' | 'RELEASE';
    units?: number;
    providerId?: string;
    modelKey?: string;
    estProviderUsd?: number;
  }): Promise<void> {
    const units = input.units ?? 1;
    const idemKey = `${input.outcome.toLowerCase()}:${input.generationId}`;
    if (processedIdemKeys.has(idemKey)) return;
    processedIdemKeys.add(idemKey);

    const acc = this.ensureMemoryCreditAccount(input.tenantId);
    if (input.outcome === 'CONSUME') {
      acc.reservedCredits = Math.max(0, acc.reservedCredits - units);
    } else {
      acc.reservedCredits = Math.max(0, acc.reservedCredits - units);
      acc.availableCredits += units;
    }
    acc.updatedAt = new Date().toISOString();
    const balanceAfter = acc.availableCredits + acc.promoCredits;

    memoryLedger.unshift({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      type: input.outcome,
      delta: input.outcome === 'CONSUME' ? 0 : units,
      balanceAfter,
      reason: `${input.outcome} for generation ${input.generationId}`,
      actor: 'system:worker',
      referenceId: input.generationId,
      idempotencyKey: idemKey,
      createdAt: new Date().toISOString(),
    });

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.$transaction(async (tx: any) => {
          const rows = await tx.$queryRaw<Array<{ available_credits: number; reserved_credits: number; promo_credits: number }>>`
            SELECT available_credits, reserved_credits, promo_credits
            FROM ai_credit_accounts
            WHERE tenant_id = ${input.tenantId}
            FOR UPDATE
          `;
          if (rows[0]) {
            const cur = rows[0];
            const nextReserved = Math.max(0, cur.reserved_credits - units);
            const nextAvail = input.outcome === 'RELEASE' ? cur.available_credits + units : cur.available_credits;
            await tx.aiCreditAccount.update({
              where: { tenantId: input.tenantId },
              data: { reservedCredits: nextReserved, availableCredits: nextAvail },
            });
            await tx.aiCreditLedger.create({
              data: {
                tenantId: input.tenantId,
                type: input.outcome,
                delta: input.outcome === 'CONSUME' ? 0 : units,
                balanceAfter: nextAvail + cur.promo_credits,
                reason: `${input.outcome} for generation ${input.generationId}`,
                actor: 'system:worker',
                referenceId: input.generationId,
                idempotencyKey: idemKey,
              },
            });
          }

          if (input.outcome === 'CONSUME') {
            await tx.aiCostRecord.create({
              data: {
                tenantId: input.tenantId,
                generationJobId: input.generationId,
                providerId: input.providerId || 'local',
                modelKey: input.modelKey || 'default-tryon',
                estProviderUsd: input.estProviderUsd ?? 0.04,
                billedCredits: units,
              },
            });
          }
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.settle_credits_prisma_warning');
      }
    }
  }

  public async adjustCredits(input: {
    tenantId: string;
    delta: number;
    promo?: boolean;
    reason: string;
    actorId: string;
    actorRole: string;
    correlationId?: string;
  }): Promise<CreditAccountDto> {
    const acc = this.ensureMemoryCreditAccount(input.tenantId);
    if (input.promo && input.delta > 0) {
      acc.promoCredits += input.delta;
    } else {
      acc.availableCredits = Math.max(0, acc.availableCredits + input.delta);
    }
    acc.updatedAt = new Date().toISOString();
    const balanceAfter = acc.availableCredits + acc.promoCredits;

    const entryType = input.promo ? 'PROMO_GRANT' : input.delta >= 0 ? 'MANUAL_ADD' : 'MANUAL_DEDUCT';
    const refId = `adj_${Date.now()}`;
    memoryLedger.unshift({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      type: entryType,
      delta: input.delta,
      balanceAfter,
      reason: input.reason,
      actor: input.actorId,
      referenceId: refId,
      createdAt: new Date().toISOString(),
    });

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.aiCreditAccount.upsert({
          where: { tenantId: input.tenantId },
          update: {
            availableCredits: acc.availableCredits,
            promoCredits: acc.promoCredits,
          },
          create: {
            tenantId: input.tenantId,
            availableCredits: acc.availableCredits,
            promoCredits: acc.promoCredits,
            reservedCredits: acc.reservedCredits,
          },
        });
        await prisma.aiCreditLedger.create({
          data: {
            tenantId: input.tenantId,
            type: entryType,
            delta: input.delta,
            balanceAfter,
            reason: input.reason,
            actor: input.actorId,
            referenceId: refId,
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.adjust_credits_prisma_warning');
      }
    }

    await recordAudit({
      actorId: input.actorId,
      actorRole: input.actorRole,
      tenantId: input.tenantId,
      action: `CREDITS_${entryType}`,
      entity: 'AiCreditAccount',
      entityId: input.tenantId,
      reason: input.reason,
      correlationId: input.correlationId,
      details: { delta: input.delta, balanceAfter },
    });

    return acc;
  }

  public async changeTenantPlan(input: {
    tenantId: string;
    planSlug: SubscriptionPlan;
    billingInterval?: 'MONTHLY' | 'ANNUAL';
    actorId: string;
    actorRole: string;
    correlationId?: string;
  }) {
    const plans = await this.listPlans(true);
    const plan = plans.find((p) => p.slug === input.planSlug) || DEFAULT_PLANS[0];
    const prodLimit = plan.entitlements.find((e) => e.featureKey === 'max_products')?.limitValue ?? 50;
    const quota = plan.entitlements.find((e) => e.featureKey === 'monthly_tryons')?.limitValue ?? 500;

    const updatedSub = db.updateSubscription(input.tenantId, {
      plan: input.planSlug,
      productLimit: prodLimit,
      tryOnMonthlyQuota: quota,
      status: 'ACTIVE',
    });

    // Top up available credits to new tier allowance minus used if upgrading
    const acc = this.ensureMemoryCreditAccount(input.tenantId);
    const targetCredits = Math.max(0, quota - (updatedSub?.tryOnUsed ?? 0));
    if (targetCredits > acc.availableCredits) {
      await this.adjustCredits({
        tenantId: input.tenantId,
        delta: targetCredits - acc.availableCredits,
        reason: `Plan change to ${plan.name}`,
        actorId: input.actorId,
        actorRole: input.actorRole,
        correlationId: input.correlationId,
      });
    }

    const subtotal = input.billingInterval === 'ANNUAL' ? plan.annualPrice : plan.monthlyPrice;
    const taxAmount = Number((subtotal * 0.08).toFixed(2));
    const total = Number((subtotal + taxAmount).toFixed(2));
    const invoice: InvoiceDto = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      invoiceNo: `INV-${new Date().getFullYear()}-${String(memoryInvoices.length + 1001)}`,
      period: new Date().toISOString().slice(0, 7),
      subtotal,
      taxAmount,
      total,
      currency: plan.currency,
      status: 'PAID',
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };
    memoryInvoices.unshift(invoice);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.invoiceRecord.create({
          data: {
            id: invoice.id,
            tenantId: invoice.tenantId,
            invoiceNo: invoice.invoiceNo,
            period: invoice.period,
            subtotal: invoice.subtotal,
            taxAmount: invoice.taxAmount,
            total: invoice.total,
            currency: invoice.currency,
            status: invoice.status,
            dueDate: new Date(invoice.dueDate),
          },
        });
        if (updatedSub) {
          await prisma.subscription.updateMany({
            where: { tenantId: input.tenantId },
            data: { planId: plan.id, billingInterval: input.billingInterval || 'MONTHLY' },
          });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'billing.plan_change_prisma_warning');
      }
    }

    await recordAudit({
      actorId: input.actorId,
      actorRole: input.actorRole,
      tenantId: input.tenantId,
      action: 'SUBSCRIPTION_PLAN_CHANGED',
      entity: 'Subscription',
      entityId: input.tenantId,
      correlationId: input.correlationId,
      details: { planSlug: input.planSlug, invoiceNo: invoice.invoiceNo, total },
    });

    return {
      subscription: updatedSub,
      plan,
      credits: await this.getCreditBalance(input.tenantId),
      invoice,
    };
  }

  public getLedger(tenantId?: string): CreditLedgerDto[] {
    return tenantId ? memoryLedger.filter((l) => l.tenantId === tenantId) : memoryLedger;
  }

  public getInvoices(tenantId?: string): InvoiceDto[] {
    return tenantId ? memoryInvoices.filter((i) => i.tenantId === tenantId) : memoryInvoices;
  }
}

export const billingCreditService = new BillingCreditService();

