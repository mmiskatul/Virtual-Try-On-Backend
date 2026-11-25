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

type FitArea = 'upper' | 'outerwear' | 'bottoms' | 'dresses';
const fitArea = (category: string): FitArea =>
  category === 'bottoms' ? 'bottoms' : category === 'dresses' ? 'dresses' : category === 'outerwear' ? 'outerwear' : 'upper';

/** One description for each of four levels: 1 a little off, 2 clearly off, 3 far off, 4 extreme. */
type Looks = [string, string, string, string];

/**
 * How a garment that is the wrong size really looks, for every kind of garment and every level.
 * Each one is a plain description of the finished picture, so any image model can follow it and the difference is easy to
 * see: a size too small looks tight and strained (and shorter than it should be), and a size too big looks loose, then
 * baggy, and finally shapeless and oversized. Level 4 is the extreme, for sizes very far apart.
 */
const WRONG_SIZE_LOOKS: Record<'smaller' | 'bigger', Record<FitArea, Looks>> = {
  smaller: {
    upper: [
      'it fits tighter than it should: the fabric is snug and pulls across the chest, shoulders and belly, and the hem and sleeves end a little shorter than designed',
      'it is clearly too tight: the fabric is stretched across the chest, shoulders and belly with visible strain wrinkles and pulling seams, the hem rides up and the sleeves are short on the arms',
      'it is far too small and looks bad on them: the fabric is stretched very tight over the body with strong strain lines, the hem rides high up the torso, the sleeves are short and cut into the arms, and the neckline looks pulled small',
      'it is extremely too small, like a garment made for a much smaller person: the fabric is stretched to its limit and straining at every seam, the hem stops well above the waist like a crop top, the sleeves stop above the elbows and squeeze the arms, and the neckline is pulled tight against the neck',
    ],
    outerwear: [
      'it fits tighter than it should: it is snug across the shoulders and chest, it closes with a little pulling, and the sleeves end a little shorter than designed',
      'it is clearly too tight: it pulls across the shoulders, chest and back with strain wrinkles, the buttons or zip are under strain, and the sleeves are short on the arms',
      'it is far too small and looks bad on them: it is stretched tight across the shoulders and back, it barely closes at the front, the sleeves ride up the forearms and the hem is short',
      'it is extremely too small: it cannot close at the front and hangs open, stretched across the shoulders and back with strained seams, the sleeves sit far up the forearms and the hem stops well above the waist',
    ],
    bottoms: [
      'it fits tighter than it should: the waist is snug, the fabric pulls across the hips and thighs, and the hems end a little short',
      'it is clearly too tight: the waistband digs in, the fabric is stretched across the hips and thighs with strain wrinkles, and the hems end well above the ankles',
      'it is far too small and looks bad on them: the fabric is stretched skin-tight over the hips and thighs with strong strain lines, the waistband cuts in, and the hems ride high above the ankles',
      'it is extremely too small, like a garment made for a much smaller person: the fabric is stretched to its limit and skin-tight, the waistband cuts in and sits far below the natural waist, the seams strain, and the legs stop well above the ankles like short tight capris',
    ],
    dresses: [
      'it fits tighter than it should: the fabric is snug across the bust, waist and hips, and the hem ends a little short',
      'it is clearly too tight: the fabric is stretched across the bust, waist and hips with strain wrinkles and pulling seams, and the hem rides up much shorter than designed',
      'it is far too small and looks bad on them: the fabric is stretched very tight over the whole body with strong strain lines, the hem rides high up the thighs, and the neckline and armholes look pulled small',
      'it is extremely too small, like a dress made for a much smaller person: the fabric is stretched to its limit over the whole body, every seam strains, the hem rides up to the top of the thighs, and the neckline and armholes are pulled tight',
    ],
  },
  bigger: {
    upper: [
      'it fits looser than it should: there is extra fabric around the chest and waist, the shoulder seams sit a little off the shoulders, and the hem and sleeves hang a little longer than designed',
      'it is clearly too big: it looks baggy with loose fabric and folds around the chest and waist, the shoulder seams drop down the arms, the sleeves reach the hands and the hem hangs low over the hips',
      'it is far too big and looks bad on them: it is very oversized and baggy, the fabric hangs and pools, the shoulders slide down the arms, the sleeves cover the hands, and the hem reaches the thighs',
      'it is extremely oversized, like wearing the clothes of a much bigger person: it is shapeless and swallows the body, the shoulder seams hang halfway down the arms, the sleeves hang well past the hands, the neckline gapes and slips off a shoulder, and the hem reaches the knees',
    ],
    outerwear: [
      'it fits looser than it should: it hangs with extra room across the chest and back, the shoulder seams sit a little off the shoulders, and the sleeves hang a little longer than designed',
      'it is clearly too big: it is boxy and baggy, the shoulder seams drop down the arms, the sleeves reach the hands and the hem hangs low',
      'it is far too big and looks bad on them: it is very oversized, the shoulders slide down the arms, the sleeves cover the hands and the hem reaches the thighs',
      'it is extremely oversized, like a coat several sizes too big: it is shapeless and swallows the body, the shoulders hang far down the arms, the sleeves hang well past the hands and the hem reaches the knees',
    ],
    bottoms: [
      'it fits looser than it should: the waist sits loose, the legs have extra room, and the hems touch the shoes',
      'it is clearly too big: the waist is loose and gathers, the legs are baggy, and the hems pool over the shoes',
      'it is far too big and looks bad on them: it is very baggy, the waist gapes and bunches, the legs are wide and shapeless, and the hems pile up on the shoes',
      'it is extremely oversized, like the trousers of a much bigger person: the waist gapes and bunches in thick folds, the legs are enormous and shapeless, and the hems pile up in heavy folds around the shoes and trail on the floor',
    ],
    dresses: [
      'it fits looser than it should: it hangs with extra room at the bust, waist and hips, and the hem sits a little long',
      'it is clearly too big: it hangs baggy and shapeless, the neckline and shoulders slip out of place, and the hem hangs too long',
      'it is far too big and looks bad on them: it is very oversized and shapeless, the neckline and shoulders slide down, the fabric pools, and the hem nearly reaches the ankles',
      'it is extremely oversized, like the dress of a much bigger person: it is shapeless and swallows the body, the neckline and shoulders slip far down, the fabric hangs and pools in heavy folds, and the hem drags on the ground',
    ],
  },
};

/**
 * How far apart two sizes are, as a level from 1 (a little) to 4 (extreme).
 * One size apart is level 1, two is level 2, three is level 3, four or more is level 4. Two waist inches count as one size.
 */
export function sizeGapLevel(cmp: { step: number; unit: 'size' | 'inch' }): 1 | 2 | 3 | 4 {
  const sizes = cmp.unit === 'inch' ? Math.ceil(Math.abs(cmp.step) / 2) : Math.abs(cmp.step);
  return Math.max(1, Math.min(4, sizes)) as 1 | 2 | 3 | 4;
}

/** Garments we name in the plural ("the jeans are ..."), so the text uses are/match instead of is/matches. */
export const isPluralGarment = (name: string): boolean => /^(jeans|trousers|pants|shorts|leggings|bottoms|casual trousers)$/i.test(name.trim());

/**
 * A short, plain description of how the garment fits this person. Empty when we know nothing.
 * `subject` names the garment in the text (for example "t-shirt" or "jeans"). With `short`, only the one-line verdict is
 * given ("... so it is extremely too small") without the detailed description, for when the prompt has to be shorter.
 */
export function fitInstruction(fit: ShopperFit | undefined, category: string, subject = 'garment', short = false): string {
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
      parts.push(`${body} The ${subject} ${isPluralGarment(subject) ? 'are' : 'is'} the same size (${garment}), so ${isPluralGarment(subject) ? 'they fit' : 'it fits'} true to size: comfortable, neither tight nor loose.`);
    } else {
      const amount = plural(Math.abs(cmp.step), cmp.unit);
      const way = cmp.step > 0 ? 'bigger' : 'smaller';
      const level = sizeGapLevel(cmp);
      const fullLook = WRONG_SIZE_LOOKS[way][fitArea(category)][level - 1];
      const rawLook = short ? fullLook.split(':')[0] : fullLook;
      // The further apart the sizes, the more obvious the picture must make it.
      const emphasis =
        level === 4 ? 'Make the size mismatch unmistakable at first glance' : level === 3 ? 'Make the size mismatch obvious at first glance' : 'Show this size difference clearly and realistically';
      // "the jeans are too big: they are baggy", not "the jeans ... it is baggy"
      const look = isPluralGarment(subject)
        ? rawLook.replace(/\bit fits\b/g, 'they fit').replace(/\bit is\b/g, 'they are').replace(/\bit looks\b/g, 'they look').replace(/\bit hangs\b/g, 'they hang').replace(/\bthan it should\b/g, 'than they should')
        : rawLook;
      parts.push(
        `${body} The ${subject} ${isPluralGarment(subject) ? 'are' : 'is'} size ${garment}, ${amount} ${way} than their size, so ${look}. ` +
          `${emphasis}, and keep the person's own body unchanged.`
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
