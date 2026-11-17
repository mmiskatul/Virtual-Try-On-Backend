import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../infrastructure/database.js';
import type { DiscountRecord, Tenant } from '../../domain/types.js';

export const MAX_DISCOUNTS_PER_BRAND = 200;

export const normalizeCode = (code: unknown): string => String(code ?? '').trim().toUpperCase();

const dateInput = z
  .union([z.string().trim().min(1), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return v === undefined ? undefined : null;
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid date.' });
      return z.NEVER;
    }
    return ms;
  });

const BaseDiscountSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,24}$/, 'Use 3 to 24 letters, numbers, dashes or underscores.'),
  description: z.string().trim().max(120).optional(),
  type: z.enum(['PERCENT', 'FIXED']),
  value: z.number().positive().max(1_000_000),
  minOrder: z.number().min(0).max(10_000_000).default(0),
  maxUses: z.number().int().min(1).max(10_000_000).nullable().optional(),
  startsAt: dateInput,
  endsAt: dateInput,
  active: z.boolean().default(true),
});

function checkRules(d: { type: string; value: number; startsAt?: number | null; endsAt?: number | null }, ctx: z.RefinementCtx) {
  if (d.type === 'PERCENT' && d.value > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'A percentage cannot be more than 100.' });
  }
  if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'The end date must be after the start date.' });
  }
}

export const DiscountCreateSchema = BaseDiscountSchema.strict().superRefine(checkRules);
export const DiscountUpdateSchema = BaseDiscountSchema.omit({ code: true }).partial().strict();

export function listDiscounts(tenant?: Tenant | null): DiscountRecord[] {
  return [...(tenant?.storefrontSettings?.discounts || [])].sort((a, b) => b.createdAt - a.createdAt);
}

function saveDiscounts(tenant: Tenant, discounts: DiscountRecord[]) {
  return db.updateTenant(tenant.id, { storefrontSettings: { ...(tenant.storefrontSettings || {}), discounts } });
}

export function createDiscount(tenant: Tenant, input: z.infer<typeof DiscountCreateSchema>):
  | { ok: true; discount: DiscountRecord }
  | { ok: false; status: number; error: string; message: string } {
  const existing = tenant.storefrontSettings?.discounts || [];
  const code = normalizeCode(input.code);
  if (existing.length >= MAX_DISCOUNTS_PER_BRAND) {
    return { ok: false, status: 400, error: 'LimitReached', message: `You can keep up to ${MAX_DISCOUNTS_PER_BRAND} discount codes.` };
  }
  if (existing.some((d) => d.code === code)) {
    return { ok: false, status: 409, error: 'CodeInUse', message: `The code ${code} already exists.` };
  }
  const discount: DiscountRecord = {
    id: `dsc_${crypto.randomBytes(6).toString('hex')}`,
    code,
    description: input.description || undefined,
    type: input.type,
    value: input.value,
    minOrder: input.minOrder ?? 0,
    maxUses: input.maxUses ?? null,
    usedCount: 0,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    active: input.active ?? true,
    createdAt: Date.now(),
  };
  saveDiscounts(tenant, [...existing, discount]);
  return { ok: true, discount };
}

export function updateDiscount(tenant: Tenant, id: string, patch: z.infer<typeof DiscountUpdateSchema>):
  | { ok: true; discount: DiscountRecord }
  | { ok: false; status: number; error: string; message: string } {
  const existing = tenant.storefrontSettings?.discounts || [];
  const current = existing.find((d) => d.id === id);
  if (!current) return { ok: false, status: 404, error: 'NotFound', message: 'Discount not found.' };
  const next: DiscountRecord = {
    ...current,
    ...(patch.description !== undefined ? { description: patch.description || undefined } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...(patch.minOrder !== undefined ? { minOrder: patch.minOrder } : {}),
    ...(patch.maxUses !== undefined ? { maxUses: patch.maxUses } : {}),
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt ?? null } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt ?? null } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  if (next.type === 'PERCENT' && next.value > 100) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'A percentage cannot be more than 100.' };
  }
  if (next.startsAt && next.endsAt && next.endsAt <= next.startsAt) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'The end date must be after the start date.' };
  }
  saveDiscounts(tenant, existing.map((d) => (d.id === id ? next : d)));
  return { ok: true, discount: next };
}

export function deleteDiscount(tenant: Tenant, id: string): boolean {
  const existing = tenant.storefrontSettings?.discounts || [];
  if (!existing.some((d) => d.id === id)) return false;
  saveDiscounts(tenant, existing.filter((d) => d.id !== id));
  return true;
}

export type DiscountCheck =
  | { ok: true; discount: DiscountRecord; amount: number }
  | { ok: false; error: string; message: string };

/** Decides whether a code can be used on an order of `subtotal`, and how much it takes off. */
export function evaluateDiscount(tenant: Tenant, rawCode: unknown, subtotal: number, now = Date.now()): DiscountCheck {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'InvalidCoupon', message: 'Enter a discount code.' };
  const discount = (tenant.storefrontSettings?.discounts || []).find((d) => d.code === code);
  // The same message for unknown and switched-off codes, so codes cannot be probed.
  if (!discount || !discount.active) return { ok: false, error: 'InvalidCoupon', message: 'This discount code is not valid.' };
  if (discount.startsAt && now < discount.startsAt) return { ok: false, error: 'InvalidCoupon', message: 'This discount code is not active yet.' };
  if (discount.endsAt && now > discount.endsAt) return { ok: false, error: 'InvalidCoupon', message: 'This discount code has expired.' };
  if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) {
    return { ok: false, error: 'InvalidCoupon', message: 'This discount code has been used up.' };
  }
  if (subtotal < discount.minOrder) {
    return { ok: false, error: 'InvalidCoupon', message: `Spend at least ৳${discount.minOrder} to use this code.` };
  }
  const raw = discount.type === 'PERCENT' ? (subtotal * discount.value) / 100 : discount.value;
  const amount = Number(Math.min(subtotal, Math.max(0, raw)).toFixed(2));
  return { ok: true, discount, amount };
}

/** Counts one use. Called inside the order transaction, after the code was validated. */
export function recordDiscountUse(tenantId: string, discountId: string): void {
  const tenant = db.getTenantById(tenantId);
  const list = tenant?.storefrontSettings?.discounts;
  if (!tenant || !list) return;
  saveDiscounts(tenant, list.map((d) => (d.id === discountId ? { ...d, usedCount: d.usedCount + 1 } : d)));
}
