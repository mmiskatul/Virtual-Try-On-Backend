import { fitInstruction, isPluralGarment, type ShopperFit } from './shopper_fit.js';

/**
 * Builds the one prompt that goes to the image model together with the two photos
 * (the first image is the person, the second image is the garment). Everything happens in that single request:
 * nothing here needs a second call to the AI.
 *
 * Every prompt is made of the same short parts, always in the same order, so it reads clearly and never contradicts itself:
 *   1. the scene: the person from the first image, wearing the garment from the second image, in the right place on the body
 *   2. the garment: what it is, that it matches the second image, the features of its kind, and how its fabric hangs
 *   3. the styling the shopper chose (tucked in, sleeves rolled, jacket open ...) and how the size fits this person
 *   4. the finish: natural folds, light and shadows that match the photo, no model or hanger, and what stays unchanged
 *      (the clothes that are not replaced, and the person's hair, headwear, glasses, jewellery and watch)
 * Only the details change from product to product. Anything a shop typed (name, description ...) is cleaned and used
 * only as a label.
 *
 * It is kept short and direct on purpose: long, chatty prompts make image models answer with text and no picture. If a
 * prompt still gets too long, the least important optional parts are dropped first, never the shopper's own choices.
 */

/**
 * Bump this whenever the wording changes. It is saved with every job, so the success rate of each wording can be
 * compared from real use, without spending anything on extra test pictures.
 */
export const PROMPT_VERSION = 'p3';

export type FabricStretch = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export type FabricThickness = 'LIGHT' | 'MEDIUM' | 'HEAVY';
export type FabricTransparency = 'OPAQUE' | 'SEMI_SHEER' | 'SHEER';

/** How the fabric behaves, from the catalogue's fabric records. Used to describe how the garment hangs. */
export interface FabricTraits {
  stretch?: FabricStretch;
  thickness?: FabricThickness;
  transparency?: FabricTransparency;
  weightGsm?: number;
}

/** What we know about the garment. Everything is optional: with nothing, the prompt still works from the category alone. */
export interface GarmentInfo {
  name?: string;
  /** The shop's own sub-category or product type, for example "Polo shirt". */
  type?: string;
  colour?: string;
  fabric?: string;
  fabricTraits?: FabricTraits;
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
  const ft = info.fabricTraits;
  if (ft && typeof ft === 'object') {
    const traits: FabricTraits = {};
    if (['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(ft.stretch as string)) traits.stretch = ft.stretch;
    if (['LIGHT', 'MEDIUM', 'HEAVY'].includes(ft.thickness as string)) traits.thickness = ft.thickness;
    if (['OPAQUE', 'SEMI_SHEER', 'SHEER'].includes(ft.transparency as string)) traits.transparency = ft.transparency;
    if (typeof ft.weightGsm === 'number' && ft.weightGsm > 0 && ft.weightGsm < 2000) traits.weightGsm = Math.round(ft.weightGsm);
    if (Object.keys(traits).length) out.fabricTraits = traits;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the garment is
// ---------------------------------------------------------------------------------------------------------------------

interface Kind {
  /** What we call it in the prompt: a plain noun, for example "t-shirt" or "jeans". */
  label: string;
  /** Where it sits on the body, when that differs from the shop's try-on category. */
  region?: 'tops' | 'bottoms' | 'dresses' | 'outerwear';
  /** The features worth matching for this kind of garment, as a noun phrase ("collar, buttons and cuffs"). */
  features: string;
}

/** Most specific first: the first pattern that matches the product's name or type (then its tags) wins. */
const KINDS: Array<{ re: RegExp; kind: Kind }> = [
  { re: /jump\s?suit|playsuit|romper|dungaree|overall/i, kind: { label: 'jumpsuit', region: 'dresses', features: 'waist, leg shape and length' } },
  { re: /sa+ri\b|sari\b|saree/i, kind: { label: 'saree', region: 'dresses', features: 'draping (pleats at the waist and the loose end over one shoulder), border, print and blouse' } },
  { re: /lehenga|ghagra|gharara/i, kind: { label: 'lehenga', region: 'dresses', features: 'flare, embroidery and length, and the dupatta if there is one' } },
  { re: /salwar|shalwar|kameez/i, kind: { label: 'salwar kameez', region: 'dresses', features: 'tunic length, side slits, neckline and trouser shape' } },
  { re: /abaya|borka|burqa|jilbab|thobe|thawb|kaftan|caftan/i, kind: { label: 'long robe', region: 'dresses', features: 'full length, sleeves and drape' } },
  { re: /dress[\s-]*(shirt|pants?|trousers?)/i, kind: { label: 'shirt', region: 'tops', features: 'collar, buttons, cuffs and pockets, and whether it is worn tucked or untucked' } },
  { re: /gown|frock|dress\b/i, kind: { label: 'dress', region: 'dresses', features: 'neckline, waist, sleeves and length (mini, knee, midi or maxi)' } },
  { re: /panjabi|punjabi|kurta|fatua|tunic|kurti/i, kind: { label: 'kurta', region: 'tops', features: 'length (often to the knee or longer), collar or neckline, placket and side slits' } },
  { re: /hoodie|sweatshirt|sweater|pullover|jumper|cardigan|fleece|knitwear/i, kind: { label: 'sweater', region: 'tops', features: 'relaxed volume, ribbed cuffs and hem, and the hood or collar' } },
  { re: /t[\s-]?shirt|tee\b|tshirt|singlet|tank|vest top|crop top|camisole|cami\b/i, kind: { label: 't-shirt', region: 'tops', features: 'neckline, sleeve length and hem length, with any print or logo in the same place and size' } },
  { re: /polo/i, kind: { label: 'polo shirt', region: 'tops', features: 'collar, button placket and ribbed sleeve ends' } },
  { re: /shirt|blouse|\btop\b(?![\s-]*(rated|seller|selling|pick|picks|brand|quality|trending|choice|deal|deals|offer))/i, kind: { label: 'shirt', region: 'tops', features: 'collar, buttons, cuffs and pockets, and whether it is worn tucked or untucked' } },
  { re: /jacket|blazer|coat|parka|windbreaker|trench|bomber|puffer|gilet|waistcoat|shrug|cape|poncho/i, kind: { label: 'jacket', region: 'outerwear', features: 'collar, lapels, zip or buttons and pockets, and whether it is worn open or closed' } },
  { re: /jean|denim/i, kind: { label: 'jeans', region: 'bottoms', features: 'waist height, leg shape, hem length, pockets, stitching and fades' } },
  { re: /\bshorts\b|bermuda/i, kind: { label: 'shorts', region: 'bottoms', features: "hem length (the legs below show the person's own skin)" } },
  { re: /skirt|skort/i, kind: { label: 'skirt', region: 'bottoms', features: 'waist position, shape and length (mini, knee, midi or maxi)' } },
  { re: /legging|jegging|tights/i, kind: { label: 'leggings', region: 'bottoms', features: 'close stretchy fit, waistband and length' } },
  { re: /jogger|sweatpant|track\s?pant|trackpant|palazzo|culotte|pyjama|pajama|lungi/i, kind: { label: 'casual trousers', region: 'bottoms', features: 'waistband, leg width and hem or cuff' } },
  { re: /trouser|pants?\b|chino|slacks|cargo|bottom/i, kind: { label: 'trousers', region: 'bottoms', features: 'waist position, leg shape, hem length, pockets and creases' } },
];

/** What the person keeps besides the clothes that are replaced. Said in every prompt so nothing personal gets removed. */
const PERSON_EXTRAS = 'hair, any hat or headscarf, glasses, jewellery and watch';

/**
 * Where each kind of garment goes on the body. `place` finishes a caption ("... in place of the clothing on the upper body"),
 * `instead` finishes an instruction ("... on the person, replacing the clothing on the upper body"), `keep` is the clothing
 * that stays as it is, and `generic` names what to match when we do not know what kind of garment it is.
 */
const REGIONS: Record<string, { instead: string; keep: string; place: string; generic: string }> = {
  tops: { instead: 'replacing the clothing on the upper body', keep: 'the clothes on the lower body and the shoes', place: 'in place of the clothing on the upper body', generic: 'neckline, sleeves and cut' },
  bottoms: { instead: 'replacing the clothing on the lower body', keep: 'the top and the shoes', place: 'in place of the clothing on the lower body', generic: 'waist, length and cut' },
  dresses: { instead: 'replacing the whole outfit from the shoulders down to the hem', keep: 'the shoes', place: 'in place of the whole outfit from the shoulders down to the hem', generic: 'neckline, sleeves, length and cut' },
  outerwear: { instead: 'worn over the clothes the person already has on', keep: 'the clothes underneath and the shoes', place: 'worn over the clothes the person already has on', generic: 'collar, front and cut' },
};

const REGION_ALIASES: Record<string, keyof typeof REGIONS> = { all: 'dresses' };

/** What to call the garment when we only know the shop's category. */
const CATEGORY_NOUN: Record<string, string> = { tops: 'top', bottoms: 'bottoms', dresses: 'dress', outerwear: 'jacket', all: 'outfit' };

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

// ---------------------------------------------------------------------------------------------------------------------
// How the fabric hangs
// ---------------------------------------------------------------------------------------------------------------------

/** How each common fabric hangs and catches the light. The first pattern that matches the fabric or the name wins. */
const FABRIC_LOOKS: Array<{ re: RegExp; look: string }> = [
  { re: /leather|suede/i, look: 'is firm and glossy, with sharp creases and soft reflections' },
  { re: /denim|jean/i, look: 'is stiff and structured, with firm folds and a visible weave' },
  { re: /chiffon|georgette|organza|tulle|voile|mesh/i, look: 'is light and thin, floating in soft flowing folds' },
  { re: /silk|satin|charmeuse/i, look: 'is smooth and shiny, draping in soft flowing folds with gentle highlights' },
  { re: /velvet|velour/i, look: 'is plush, with a soft sheen that changes with the light' },
  { re: /corduroy/i, look: 'keeps its ribbed texture visible, with firm rounded folds' },
  { re: /lace|crochet/i, look: 'keeps its open, finely detailed pattern' },
  { re: /linen/i, look: 'is crisp and light, with natural creases' },
  { re: /tweed|wool|woollen|cashmere|flannel/i, look: 'is thick and warm, with a soft matte texture and rounded folds' },
  { re: /fleece|terry|sherpa|sweat/i, look: 'is thick and soft, with rounded volume' },
  { re: /knit|jersey|rib|spandex|elastane|lycra/i, look: 'is soft and stretchy, following the body with gentle folds' },
  { re: /polyester|nylon|rayon|viscose|crepe/i, look: 'is smooth, with light even folds' },
  { re: /cotton|poplin|twill|canvas|oxford|khadi|muslin/i, look: 'is smooth, with light natural creases' },
];

/**
 * One sentence about how this fabric hangs, so a heavy denim, a flowing silk and a stretchy knit each look right.
 * It uses the fabric's name and make-up, and the catalogue's weight, stretch and see-through settings when they exist.
 * Empty when we know nothing about the fabric.
 */
export function fabricDrape(garment: GarmentInfo | undefined): string {
  const text = [garment?.fabric, garment?.name].filter(Boolean).join(' ');
  const base = FABRIC_LOOKS.find((f) => f.re.test(text))?.look;
  const t = garment?.fabricTraits;
  const clauses: string[] = [];
  const heavy = t?.thickness === 'HEAVY' || (t?.weightGsm ?? 0) >= 300;
  const light = t?.thickness === 'LIGHT' || (t?.weightGsm !== undefined && t.weightGsm <= 120);
  if (heavy) clauses.push('it is heavy, so it makes fewer, larger folds');
  else if (light) clauses.push('it is light, so it makes many soft folds');
  if (t?.stretch === 'HIGH') clauses.push('it is very stretchy, so it follows the body closely');
  else if (t?.stretch === 'NONE') clauses.push('it does not stretch, so it keeps its own shape');
  if (t?.transparency === 'SHEER') clauses.push('it is sheer and see-through, exactly as in the second image');
  else if (t?.transparency === 'SEMI_SHEER') clauses.push('it is slightly see-through, as in the second image');
  if (!base && !clauses.length) return '';
  return `The fabric ${base || 'hangs naturally'}${clauses.length ? `; ${clauses.join('; ')}` : ''}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Styling the shopper can choose
// ---------------------------------------------------------------------------------------------------------------------

type RegionKey = 'tops' | 'bottoms' | 'dresses' | 'outerwear';

interface StyleOption {
  /** Finishes the sentence "It is worn ...". */
  text: string;
  /** The kinds of garment this makes sense for. */
  areas: RegionKey[];
  /** Options in the same group contradict each other, so only the first one chosen is used. */
  group?: string;
}

/** Choices a shopper or brand can add to a try-on. Each one becomes one short, clear phrase. */
export const STYLE_OPTIONS = {
  tucked_in: { text: 'tucked in at the waist', areas: ['tops'], group: 'hem' },
  untucked: { text: 'untucked, with the hem hanging free', areas: ['tops'], group: 'hem' },
  sleeves_rolled: { text: 'with the sleeves rolled up to the elbows', areas: ['tops', 'outerwear'] },
  top_button_open: { text: 'with the top button undone', areas: ['tops'], group: 'buttons' },
  buttoned_up: { text: 'fully buttoned up', areas: ['tops', 'outerwear'], group: 'buttons' },
  collar_up: { text: 'with the collar turned up', areas: ['tops', 'outerwear'] },
  jacket_open: { text: 'open at the front', areas: ['outerwear'], group: 'front' },
  jacket_closed: { text: 'closed at the front', areas: ['outerwear'], group: 'front' },
  hood_up: { text: 'with the hood up', areas: ['tops', 'outerwear'], group: 'hood' },
  hood_down: { text: 'with the hood down', areas: ['tops', 'outerwear'], group: 'hood' },
  belted: { text: 'with a belt at the waist', areas: ['tops', 'dresses', 'outerwear', 'bottoms'] },
  cuffed_hem: { text: 'with the hems folded up in a neat cuff', areas: ['bottoms'] },
} as const satisfies Record<string, StyleOption>;

export type StyleOptionId = keyof typeof STYLE_OPTIONS;
export const STYLE_OPTION_IDS = Object.keys(STYLE_OPTIONS) as StyleOptionId[];

/** The options that make sense for a kind of garment (so a screen can offer only those). */
export function styleOptionsFor(region: RegionKey): StyleOptionId[] {
  return STYLE_OPTION_IDS.filter((id) => (STYLE_OPTIONS[id].areas as readonly RegionKey[]).includes(region));
}

/**
 * Turn what a client sent into the phrases to use: unknown ids and options that do not suit this garment are dropped,
 * the same option is used once, and of two options that contradict each other only the first is kept.
 */
export function resolveStyleOptions(ids: unknown, region: RegionKey): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const groups = new Set<string>();
  const out: string[] = [];
  for (const raw of ids.slice(0, 12)) {
    if (typeof raw !== 'string' || !(raw in STYLE_OPTIONS) || seen.has(raw)) continue;
    const option = STYLE_OPTIONS[raw as StyleOptionId] as StyleOption;
    if (!option.areas.includes(region)) continue;
    if (option.group && groups.has(option.group)) continue;
    seen.add(raw);
    if (option.group) groups.add(option.group);
    out.push(option.text);
  }
  return out;
}

const joinWithAnd = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// ---------------------------------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------------------------------

export interface PromptInput {
  category: string;
  garment?: GarmentInfo;
  shopper?: ShopperFit;
  /** Extra styling text the shop or shopper asked for. */
  styling?: string;
  /** Styling choices (ids from STYLE_OPTIONS), for example ["tucked_in", "sleeves_rolled"]. */
  styleOptions?: string[];
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

const lower = (value: string | undefined) => (value || '').toLowerCase();
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "cream cotton striped t-shirt": the garment as a plain noun phrase, with the shop's colour, fabric and pattern. */
function garmentPhrase(garment: GarmentInfo | undefined, what: string): string {
  const pattern = garment?.pattern && !/^(solid|plain|none)$/i.test(garment.pattern) ? garment.pattern : '';
  const look = [garment?.colour, garment?.fabric?.split(',')[0], pattern].map(lower).filter(Boolean).join(' ');
  return `${look ? `${look} ` : ''}${what}`;
}

/** Key facts the shop wrote (for example "sleeve: short"), as a short bracket. */
function specsBracket(garment: GarmentInfo | undefined): string {
  const specs = Object.entries(garment?.specs || {}).slice(0, 3).map(([k, v]) => `${k.toLowerCase()}: ${lower(v)}`);
  return specs.length ? ` (${specs.join(', ')})` : '';
}

/** One sentence of the prompt. `keep` says how long it survives: 100 is never dropped, lower numbers are dropped first. */
interface Part {
  text: string;
  keep: number;
  /** A shorter version of the same sentence, used before anything the shopper chose has to be dropped. */
  short?: string;
}

const MAX_CAPTION_CHARS = 1400;
const MAX_INSTRUCTION_CHARS = 1050;

/**
 * Join the parts. If the prompt is too long, make it shorter in this order, until it fits:
 *   1. drop the minor parts (notes, fabric, features ...), least important first
 *   2. shorten the long parts (the size fit becomes a one-line verdict)
 *   3. only then drop parts of medium importance
 * The essentials (what to wear, what to keep, do not return the photos) and the shopper's own choices are the last to go.
 */
function assemble(parts: Part[], budget: number): string {
  const live = parts.filter((p) => p.text).map((p) => ({ ...p }));
  const text = () => live.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
  const dropLowest = (below: number): boolean => {
    let at = -1;
    let lowest = below;
    live.forEach((p, i) => {
      if (p.keep < lowest) {
        lowest = p.keep;
        at = i;
      }
    });
    if (at < 0) return false;
    live.splice(at, 1);
    return true;
  };
  while (text().length > budget) {
    if (dropLowest(80)) continue;
    const longer = live.find((p) => p.short && p.text !== p.short);
    if (longer) {
      longer.text = longer.short as string;
      continue;
    }
    if (dropLowest(100)) continue;
    break; // only the essentials are left
  }
  return text();
}

/** Which part of the body this garment covers: tops, bottoms, dresses or outerwear. */
export function garmentRegion(garment: GarmentInfo | undefined, category: string): RegionKey {
  const cat = (category || 'tops').toLowerCase();
  const kind = inferKind(sanitizeGarmentInfo(garment));
  return (kind?.region || REGION_ALIASES[cat] || (cat in REGIONS ? cat : 'tops')) as RegionKey;
}

/** The single prompt that goes with the two photos. */
export function buildTryOnPrompt(input: PromptInput): string {
  const category = (input.category || 'tops').toLowerCase();
  const garment = sanitizeGarmentInfo(input.garment);
  const kind = inferKind(garment);
  const regionKey = (kind?.region || REGION_ALIASES[category] || (category in REGIONS ? category : 'tops')) as RegionKey;
  const region = REGIONS[regionKey] || REGIONS.tops;
  const what = kind?.label || lower(garment?.type) || CATEGORY_NOUN[category] || category;
  const phrase = garmentPhrase(garment, what);
  const fit = fitInstruction(input.shopper, category, what);
  const fitShort = fitInstruction(input.shopper, category, what, true);
  const styling = cleanText(input.styling, 300);
  const notes = cleanText(input.visionNotes, 400);
  const chosen = resolveStyleOptions(input.styleOptions, regionKey);
  const worn = chosen.length ? `It is worn ${joinWithAnd(chosen)}.` : '';
  const drape = fabricDrape(garment);

  // One clear sentence about matching the garment: the basics, then what matters for this kind of garment (no repeats).
  const matches = isPluralGarment(what) ? 'match' : 'matches';
  const basics = kind?.features
    ? `The ${what} ${matches} the second image exactly in colour, fabric, pattern, print and logo.`
    : `The ${what} ${matches} the second image exactly in colour, fabric, pattern, print and logo, with the same ${region.generic}.`;
  const features = kind?.features ? `Match its ${kind.features}.` : '';

  if (input.style === 'caption') {
    if (input.compact) {
      return assemble(
        [
          { text: `A photorealistic photo of the person from the first image, with the same face, hair, headwear, accessories, pose and background, wearing the ${phrase} from the second image ${region.place}.`, keep: 100 },
          { text: worn, keep: 90 },
          { text: fit, keep: 95 },
        ],
        MAX_CAPTION_CHARS
      );
    }
    return assemble(
      [
        // 1. the scene
        { text: `A photorealistic photo of the person from the first image, with the same face, hair, pose and background, wearing the ${phrase}${specsBracket(garment)} from the second image ${region.place}.`, keep: 100 },
        // 2. the garment
        { text: basics, keep: 100 },
        { text: features, keep: 70 },
        { text: drape, keep: 60 },
        // 3. the styling and the fit
        { text: worn, keep: 90 },
        { text: fit, short: fitShort, keep: 95 },
        // 4. the finish
        { text: `Natural folds, with the light and shadows on the garment matching the first image (same direction, softness and colour); only the garment is shown, not any model or hanger from the second image.`, keep: 80 },
        { text: `${capitalize(region.keep)}, and the person's ${PERSON_EXTRAS}, stay the same.`, keep: 100 },
        { text: notes ? `Notes: ${notes}` : '', keep: 20 },
        { text: styling ? `Extra request: ${styling}` : '', keep: 85 },
      ],
      MAX_CAPTION_CHARS
    );
  }

  if (input.compact) {
    return assemble(
      [
        { text: `Edit the first image: put the ${phrase} from the second image on the person, ${region.instead}.`, keep: 100 },
        { text: `Keep the person's face, hair, headwear, accessories, pose and the background unchanged. Copy the garment's exact colour, pattern, ${region.generic}.`, keep: 100 },
        { text: worn, keep: 90 },
        { text: fit, keep: 95 },
        { text: `Return one new photo. Do not return the first or the second image unchanged.`, keep: 100 },
      ],
      MAX_INSTRUCTION_CHARS
    );
  }

  return assemble(
    [
      // 1. the scene
      { text: `Edit the first image: put the ${phrase}${specsBracket(garment)} from the second image on the person, ${region.instead}.`, keep: 100 },
      { text: `Keep the person's face, pose and the background unchanged, and keep ${region.keep} and the person's ${PERSON_EXTRAS}.`, keep: 100 },
      // 2. the garment
      { text: basics, keep: 100 },
      { text: features, keep: 70 },
      { text: drape, keep: 60 },
      { text: `Use only the garment, not any model or hanger shown in the second image.`, keep: 75 },
      // 3. the styling and the fit
      { text: worn, keep: 90 },
      { text: fit, short: fitShort, keep: 95 },
      // 4. the finish
      { text: `Natural folds, with the light and shadows on the garment matching the first image.`, keep: 80 },
      { text: notes ? `Notes: ${notes}` : '', keep: 20 },
      { text: styling ? `Extra request: ${styling}` : '', keep: 85 },
      { text: `Return one new photo with the same framing. Do not return the first or the second image unchanged.`, keep: 100 },
    ],
    MAX_INSTRUCTION_CHARS
  );
}

/** True when the model handed back one of the input photos instead of a new picture. */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}
