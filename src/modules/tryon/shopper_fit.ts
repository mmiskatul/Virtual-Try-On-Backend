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
  size?: string;
}

/** Pull only valid values out of anything a client sent. Bad values are dropped, never passed on. */
export function parseShopperFit(input: { gender?: unknown; size?: unknown } | undefined | null): ShopperFit {
  const out: ShopperFit = {};
  const g = GenderSchema.safeParse(input?.gender);
  if (g.success) out.gender = g.data;
  const s = SizeSchema.safeParse(input?.size);
  if (s.success) out.size = s.data;
  return out;
}

const isWaist = (size: string) => /^\d+$/.test(size);

/** A short, plain instruction for the image model. Empty when we know nothing. */
export function fitInstruction(fit: ShopperFit | undefined, category: string): string {
  if (!fit || (!fit.gender && !fit.size)) return '';
  const parts: string[] = [];
  if (fit.gender) parts.push(`The person is a ${fit.gender === 'female' ? 'woman' : 'man'}.`);
  if (fit.size) {
    if (isWaist(fit.size)) {
      parts.push(`Their waist size is ${fit.size} inches, so the ${category} garment should fit a ${fit.size} inch waist.`);
    } else {
      parts.push(
        `They usually wear size ${fit.size}. Show the ${category} garment fitting the way a size ${fit.size} fits them: ` +
          'a bigger size looks looser and longer, a smaller size sits closer to the body.'
      );
    }
  }
  return parts.join(' ');
}
