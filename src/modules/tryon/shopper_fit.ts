import { z } from 'zod';

/**
 * Who is trying the garment on: their gender and the size they usually wear.
 * These are checked values (never free text), so they are safe to use when asking Gemini for the picture.
 */
export type ShopperGender = 'female' | 'male';

export const GenderSchema = z.enum(['female', 'male']);

/** Clothes sizes (XS to 4XL) or a waist size in inches (for example 32). */
export const SIZE_PATTERN = /^(XXS|XS|S|M|L|XL|XXL|3XL|4XL|[2-5][0-9])$/;
export const SizeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SIZE_PATTERN, 'Choose a size such as S, M, L, XL or a waist size such as 32.');

export interface ShopperFit {
  gender?: ShopperGender;
  /** The size the shopper usually wears. */
  size?: string;
  /** The size of the garment they chose to try on. */
  garmentSize?: string;
}

/** Pull only valid values out of anything a client sent. Bad values are dropped, never passed on. */
export function parseShopperFit(input: { gender?: unknown; size?: unknown; garmentSize?: unknown } | undefined | null): ShopperFit {
  const out: ShopperFit = {};
  const g = GenderSchema.safeParse(input?.gender);
  if (g.success) out.gender = g.data;
  const s = SizeSchema.safeParse(input?.size);
  if (s.success) out.size = s.data;
  const gs = SizeSchema.safeParse(input?.garmentSize);
  if (gs.success) out.garmentSize = gs.data;
  return out;
}

const isWaist = (size: string) => /^\d+$/.test(size);

const LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
const plural = (n: number, word: 'size' | 'inch') => `${n} ${n === 1 ? word : word === 'inch' ? 'inches' : 'sizes'}`;

/** How the garment's size compares with the shopper's size. null when the two cannot be compared. */
export function compareSizes(mine: string, garment: string): { step: number; unit: 'size' | 'inch' } | null {
  const a = LETTER_ORDER.indexOf(mine);
  const b = LETTER_ORDER.indexOf(garment);
  if (a >= 0 && b >= 0) return { step: b - a, unit: 'size' };
  if (isWaist(mine) && isWaist(garment)) return { step: Number(garment) - Number(mine), unit: 'inch' };
  return null;
}

/** A short, plain instruction for the image model. Empty when we know nothing. */
export function fitInstruction(fit: ShopperFit | undefined, category: string): string {
  if (!fit || (!fit.gender && !fit.size && !fit.garmentSize)) return '';
  const parts: string[] = [];
  if (fit.gender) parts.push(`The person is a ${fit.gender === 'female' ? 'woman' : 'man'}.`);

  const mine = fit.size;
  const garment = fit.garmentSize;
  if (mine && garment) {
    const cmp = compareSizes(mine, garment);
    const body = isWaist(mine) ? `Their waist size is ${mine} inches.` : `They usually wear size ${mine}.`;
    if (!cmp) {
      parts.push(`${body} The ${category} garment shown is size ${garment}. Show how it fits them.`);
    } else if (cmp.step === 0) {
      parts.push(`${body} The garment is the same size (${garment}), so it fits true to size.`);
    } else {
      const amount = plural(Math.abs(cmp.step), cmp.unit);
      parts.push(
        cmp.step > 0
          ? `${body} The garment is size ${garment}, ${amount} bigger than their size, so show it looser and longer on them.`
          : `${body} The garment is size ${garment}, ${amount} smaller than their size, so show it tighter and shorter on them.`
      );
    }
  } else if (garment) {
    parts.push(`The ${category} garment shown is size ${garment}. Show how a size ${garment} fits a person like this.`);
  } else if (mine) {
    if (isWaist(mine)) {
      parts.push(`Their waist size is ${mine} inches, so the ${category} garment should fit a ${mine} inch waist.`);
    } else {
      parts.push(
        `They usually wear size ${mine}. Show the ${category} garment fitting the way a size ${mine} fits them: ` +
          'a bigger size looks looser and longer, a smaller size sits closer to the body.'
      );
    }
  }
  return parts.join(' ');
}
