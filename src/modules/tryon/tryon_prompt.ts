import { fitInstruction, type ShopperFit } from './shopper_fit.js';

/**
 * Builds the one prompt that goes to the image model together with the two photos
 * (the first image is the person, the second image is the garment).
 *
 * The prompt adapts to the garment: it works out what the garment is (a shirt, jeans, a dress, a saree, a jacket ...)
 * from the product's own details, says which part of the body changes, which clothes stay, and adds a short hint for
 * how that kind of garment should sit and fall. Anything the shop typed (name, description ...) is cleaned and used
 * only as a label.
 *
 * It is kept short and direct on purpose. Live tests against the image model showed that long, chatty prompts make it
 * answer with text and no picture far more often than a concise instruction does.
 */

/** What we know about the garment. Everything is optional: with nothing, the prompt still works from the category alone. */
export interface GarmentInfo {
  name?: string;
  /** The shop's own sub-category or product type, for example "Polo shirt". */
  type?: string;
  colour?: string;
  fabric?: string;
  pattern?: string;
  /** A short description written by the shop. */
  details?: string;
  /** Shop-written key facts such as fit, sleeve or neckline. */
  specs?: Record<string, string>;
  audience?: 'women' | 'men' | 'both';
  /** The product's tags. Used only as a second clue to what the garment is. */
  tags?: string[];
}

/** Make shop-written text safe to place in a prompt: one line, no control characters or markup, limited length. */
export function cleanText(value: unknown, max = 120): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>{}`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Keep only clean, short values of a GarmentInfo (used for anything that came from outside the engine). */
export function sanitizeGarmentInfo(info: GarmentInfo | undefined | null): GarmentInfo | undefined {
  if (!info) return undefined;
  const out: GarmentInfo = {};
  const set = (k: 'name' | 'type' | 'colour' | 'fabric' | 'pattern' | 'details', max: number) => {
    const v = cleanText(info[k], max);
    if (v) out[k] = v;
  };
  set('name', 100);
  set('type', 60);
  set('colour', 40);
  set('fabric', 120);
  set('pattern', 60);
  set('details', 240);
  if (info.audience === 'women' || info.audience === 'men' || info.audience === 'both') out.audience = info.audience;
  if (Array.isArray(info.tags)) {
    const tags = info.tags.slice(0, 10).map((t) => cleanText(t, 30)).filter(Boolean);
    if (tags.length) out.tags = tags;
  }
  if (info.specs && typeof info.specs === 'object') {
    const specs: Record<string, string> = {};
    for (const [k, v] of Object.entries(info.specs).slice(0, 8)) {
      const key = cleanText(k, 30);
      const val = cleanText(v, 60);
      if (key && val && !key.startsWith('_')) specs[key] = val;
    }
    if (Object.keys(specs).length) out.specs = specs;
  }
  return Object.keys(out).length ? out : undefined;
}

interface Kind {
  /** What we call it in the prompt. */
  label: string;
  /** Where it sits on the body, when that differs from the shop's try-on category. */
  region?: 'tops' | 'bottoms' | 'dresses' | 'outerwear';
  /** A short hint on how this kind of garment should sit and fall. */
  hint: string;
}

const COLLAR_HINT = 'Keep the collar, buttons, cuffs and pockets; tucked or untucked as in the garment photo.';

/** Most specific first: the first pattern that matches the product's name or type (then its tags) wins. */
const KINDS: Array<{ re: RegExp; kind: Kind }> = [
  { re: /jump\s?suit|playsuit|romper|dungaree|overall/i, kind: { label: 'jumpsuit', region: 'dresses', hint: 'Keep the waist, leg shape and length as in the garment photo.' } },
  { re: /sa+ri\b|sari\b|saree/i, kind: { label: 'saree', region: 'dresses', hint: 'Drape it like a saree: pleats at the waist, the loose end over one shoulder, with its blouse; keep the border and print.' } },
  { re: /lehenga|ghagra|gharara/i, kind: { label: 'lehenga', region: 'dresses', hint: 'Keep the flare, embroidery and length, and the dupatta if shown.' } },
  { re: /salwar|shalwar|kameez/i, kind: { label: 'salwar kameez', region: 'dresses', hint: 'Keep the tunic length, side slits, neckline and trouser shape.' } },
  { re: /abaya|borka|burqa|jilbab|thobe|thawb|kaftan|caftan/i, kind: { label: 'long robe', region: 'dresses', hint: 'Keep its full length, sleeves and drape.' } },
  { re: /dress[\s-]*(shirt|pants?|trousers?)/i, kind: { label: 'shirt / blouse', region: 'tops', hint: COLLAR_HINT } },
  { re: /gown|frock|dress\b/i, kind: { label: 'dress', region: 'dresses', hint: 'It replaces the whole outfit; keep the neckline, waist, sleeves and length (mini, knee, midi or maxi).' } },
  { re: /panjabi|punjabi|kurta|fatua|tunic|kurti/i, kind: { label: 'kurta / panjabi', region: 'tops', hint: 'Keep the length (often to the knee or longer), collar or neckline, placket and slits; keep the trousers the person already wears.' } },
  { re: /hoodie|sweatshirt|sweater|pullover|jumper|cardigan|fleece|knitwear/i, kind: { label: 'sweater / hoodie', region: 'tops', hint: 'Keep the relaxed volume, ribbed cuffs and hem, and the hood or collar.' } },
  { re: /t[\s-]?shirt|tee\b|tshirt|singlet|tank|vest top|crop top|camisole|cami\b/i, kind: { label: 't-shirt / top', region: 'tops', hint: 'Keep the neckline, sleeve and hem length; any print or logo stays in the same place and size.' } },
  { re: /polo/i, kind: { label: 'polo shirt', region: 'tops', hint: 'Keep the collar, button placket and ribbed sleeve ends.' } },
  { re: /shirt|blouse|\btop\b(?![\s-]*(rated|seller|selling|pick|picks|brand|quality|trending|choice|deal|deals|offer))/i, kind: { label: 'shirt / blouse', region: 'tops', hint: COLLAR_HINT } },
  { re: /jacket|blazer|coat|parka|windbreaker|trench|bomber|puffer|gilet|waistcoat|shrug|cape|poncho/i, kind: { label: 'jacket / coat', region: 'outerwear', hint: 'Wear it over the clothes already worn, open or closed as in the garment photo; keep the collar, lapels, zip or buttons.' } },
  { re: /jean|denim/i, kind: { label: 'jeans', region: 'bottoms', hint: 'Keep the waist height, leg shape and hem length; pockets, stitching and fades stay in place.' } },
  { re: /\bshorts\b|bermuda/i, kind: { label: 'shorts', region: 'bottoms', hint: "Keep the hem length; the legs show the person's own skin tone." } },
  { re: /skirt|skort/i, kind: { label: 'skirt', region: 'bottoms', hint: 'Keep the waist position, shape and length (mini, knee, midi, maxi).' } },
  { re: /legging|jegging|tights/i, kind: { label: 'leggings', region: 'bottoms', hint: 'A close, stretchy fit; keep the waistband and length.' } },
  { re: /jogger|sweatpant|track\s?pant|trackpant|palazzo|culotte|pyjama|pajama|lungi/i, kind: { label: 'casual trousers', region: 'bottoms', hint: 'Keep the waistband, leg width and hem or cuff.' } },
  { re: /trouser|pants?\b|chino|slacks|cargo|bottom/i, kind: { label: 'trousers', region: 'bottoms', hint: 'Keep the waist position, leg shape and hem length; pockets and creases stay in place.' } },
];

const REGIONS: Record<string, { change: string; keep: string; place: string }> = {
  tops: { change: 'the clothing on the upper body', keep: 'the clothes on the lower body, the shoes and accessories', place: 'in place of the clothing on the upper body' },
  bottoms: { change: 'the clothing on the lower body (trousers, skirt or shorts)', keep: 'the top, the shoes and accessories', place: 'in place of the clothing on the lower body' },
  dresses: { change: 'the whole outfit from the shoulders down to the hem', keep: 'the shoes and accessories', place: 'in place of the whole outfit from the shoulders down to the hem' },
  outerwear: { change: 'the outer layer: add the garment over the clothes the person already wears', keep: 'the clothes underneath, the shoes and accessories', place: 'worn over the clothes the person already has on' },
};

const REGION_ALIASES: Record<string, keyof typeof REGIONS> = { all: 'dresses' };

/** Work out what the garment is, from the shop's own words. Returns null when nothing matches. */
export function inferKind(info: GarmentInfo | undefined, tags: string[] = info?.tags || []): Kind | null {
  // The product's name and type decide first. Tags are only a second chance, because words like "top rated" are not clothing.
  for (const text of [[info?.name, info?.type].filter(Boolean).join(' '), tags.join(' ')]) {
    if (!text) continue;
    for (const { re, kind } of KINDS) if (re.test(text)) return kind;
  }
  return null;
}

/** One line that tells a model what the garment is. Empty when we know nothing. Used by the Gemini description step. */
export function describeGarment(info: GarmentInfo | undefined, category: string, kind: Kind | null): string {
  const parts: string[] = [];
  const name = info?.name ? `"${info.name}"` : '';
  const what = kind?.label || info?.type || category;
  parts.push(name ? `${name}, a ${what}` : `a ${what}`);
  if (info?.colour) parts.push(`colour: ${info.colour}`);
  if (info?.fabric) parts.push(`fabric: ${info.fabric}`);
  if (info?.pattern && !/^(solid|plain|none)$/i.test(info.pattern)) parts.push(`pattern: ${info.pattern}`);
  for (const [k, v] of Object.entries(info?.specs || {})) parts.push(`${k.toLowerCase()}: ${v}`);
  if (info?.details) parts.push(`notes: ${info.details}`);
  return parts.join('; ');
}

export interface PromptInput {
  category: string;
  garment?: GarmentInfo;
  shopper?: ShopperFit;
  /** Extra styling the shop or shopper asked for. */
  styling?: string;
  /** A description of the garment on the person, written by a vision model in the first step (Gemini only). */
  visionNotes?: string;
  /** The shortest form of the prompt. The engines use it for a second try when the first try returned no picture. */
  compact?: boolean;
  /**
   * How the prompt is worded. `instruction` ("Edit the first image: ...") suits Gemini. `caption` describes the finished
   * picture ("A photo of the person from the first image, now wearing ...") and is what FLUX edit models are built for:
   * in a live test an instruction prompt gave the wrong garment (no sleeves, no print) while the caption copied it exactly.
   */
  style?: 'instruction' | 'caption';
}

/** FLUX-family edit models want a caption of the finished picture; everything else gets instructions. */
export const promptStyleForModel = (model: string): 'instruction' | 'caption' => (/flux|klein/i.test(model) ? 'caption' : 'instruction');

/** A short label for the garment: what it is, with its colour, fabric and pattern when the shop gave them. */
function garmentLabel(garment: GarmentInfo | undefined, what: string): string {
  const specs = Object.entries(garment?.specs || {}).slice(0, 3).map(([k, v]) => `${k.toLowerCase()}: ${v.toLowerCase()}`);
  const bits = [
    garment?.colour,
    garment?.fabric?.split(',')[0],
    garment?.pattern && !/^(solid|plain|none)$/i.test(garment.pattern) ? garment.pattern : '',
    ...specs,
  ]
    .filter(Boolean)
    .join(', ');
  return `${what}${bits ? ` (${bits})` : ''}`;
}

/** The single prompt that goes with the two photos. */
export function buildTryOnPrompt(input: PromptInput): string {
  const category = (input.category || 'tops').toLowerCase();
  const garment = sanitizeGarmentInfo(input.garment);
  const kind = inferKind(garment);
  const regionKey = kind?.region || REGION_ALIASES[category] || (category in REGIONS ? category : 'tops');
  const region = REGIONS[regionKey] || REGIONS.tops;
  const what = kind?.label || garment?.type || category;
  const fit = fitInstruction(input.shopper, category);
  const styling = cleanText(input.styling, 300);
  const notes = cleanText(input.visionNotes, 400);
  const join = (lines: string[]) => lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  if (input.style === 'caption') {
    const colour = garment?.colour ? ` (${garment.colour})` : '';
    const stays = region.keep.charAt(0).toUpperCase() + region.keep.slice(1);
    if (input.compact) {
      return join([
        `A photorealistic photo of the person from the first image, with the same face, pose and background, wearing the ${what}${colour} shown in the second image ${region.place}.`,
        fit,
      ]);
    }
    return join([
      `A photorealistic photo of the person from the first image, with the same face, hair, pose and background, now wearing the ${garmentLabel(garment, what)} shown in the second image ${region.place}.`,
      `The ${what} keeps its exact colour, fabric, pattern, print, logo, sleeve length and cut. ${kind?.hint || ''}`,
      fit,
      `It has natural folds and the same lighting as the first image, and only the garment is shown, not any model or hanger from the second image.`,
      `${stays} stay the same.`,
      notes ? `Notes: ${notes}` : '',
      styling ? `Extra request: ${styling}` : '',
    ]);
  }

  if (input.compact) {
    const colour = garment?.colour ? ` (${garment.colour})` : '';
    return join([
      `Edit the first image: put the ${what}${colour} from the second image on the person, replacing ${region.change}.`,
      `Keep the person's face, pose and the background unchanged. Copy the garment's exact colour, pattern, sleeve length and cut.`,
      fit,
      `Return one new photo. Do not return the first or the second image unchanged.`,
    ]);
  }

  return join([
    `Edit the first image: put the ${garmentLabel(garment, what)} from the second image on the person, replacing ${region.change}.`,
    `Keep the person's face, pose and the background unchanged, and keep ${region.keep}.`,
    `Copy the garment's exact colour, fabric, pattern, print, logo, sleeve length and cut. ${kind?.hint || ''}`,
    `Use only the garment, not any model or hanger shown in the second image.`,
    fit,
    `Natural folds and lighting that match the first image.`,
    notes ? `Notes: ${notes}` : '',
    styling ? `Extra request: ${styling}` : '',
    `Return one new photo with the same framing. Do not return the first or the second image unchanged.`,
  ]);
}

/** True when the model handed back one of the input photos instead of a new picture. */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}
