import './setup_env.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';
import { seedTestUsers } from './helpers.js';
import {
  PROMPT_VERSION,
  STYLE_OPTIONS,
  STYLE_OPTION_IDS,
  buildTryOnPrompt,
  fabricDrape,
  resolveStyleOptions,
  sanitizeGarmentInfo,
  styleOptionsFor,
} from '../src/modules/tryon/tryon_prompt.js';
import { FalTryOnEngine, DEFAULT_FAL_MODEL, type FalGateway } from '../src/modules/tryon/fal.engine.js';

// None of these tests call an AI service. They check prompt text, the free preview route, and fake engines.

const pngBytes = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]), Buffer.alloc(30, fill)]);

describe('Phase 27 - how the fabric hangs', () => {
  it('describes common fabrics so denim, silk and knit each look right', () => {
    expect(fabricDrape({ fabric: 'Denim, 12oz' })).toBe('The fabric is stiff and structured, with firm folds and a visible weave.');
    expect(fabricDrape({ fabric: 'Pure silk satin' })).toMatch(/smooth and shiny, draping in soft flowing folds/);
    expect(fabricDrape({ fabric: 'Cotton jersey knit' })).toMatch(/soft and stretchy/);
    expect(fabricDrape({ fabric: 'Chiffon' })).toMatch(/light and thin, floating/);
    expect(fabricDrape({ fabric: 'Genuine leather' })).toMatch(/firm and glossy/);
    expect(fabricDrape({ fabric: 'Linen blend' })).toMatch(/crisp and light/);
    expect(fabricDrape({ fabric: 'Merino wool' })).toMatch(/thick and warm/);
  });

  it('uses the catalogue weight, stretch and see-through settings', () => {
    const heavy = fabricDrape({ fabric: 'Cotton twill', fabricTraits: { thickness: 'HEAVY', stretch: 'NONE' } });
    expect(heavy).toContain('it is heavy, so it makes fewer, larger folds');
    expect(heavy).toContain('it does not stretch, so it keeps its own shape');
    expect(fabricDrape({ fabricTraits: { weightGsm: 320 } })).toContain('heavy');
    expect(fabricDrape({ fabricTraits: { weightGsm: 90 } })).toContain('light, so it makes many soft folds');
    expect(fabricDrape({ fabricTraits: { stretch: 'HIGH' } })).toContain('very stretchy');
    expect(fabricDrape({ fabric: 'Cotton voile', fabricTraits: { transparency: 'SHEER' } })).toContain('sheer and see-through, exactly as in the second image');
    expect(fabricDrape({ fabricTraits: { transparency: 'SEMI_SHEER' } })).toContain('slightly see-through');
  });

  it('says nothing when it knows nothing, and falls back to the garment name', () => {
    expect(fabricDrape(undefined)).toBe('');
    expect(fabricDrape({})).toBe('');
    expect(fabricDrape({ name: 'Classic Denim Jacket' })).toMatch(/stiff and structured/);
  });

  it('puts the fabric sentence into both prompt styles', () => {
    const garment = { name: 'Silk Blouse', fabric: 'Silk satin', fabricTraits: { thickness: 'LIGHT' as const } };
    for (const style of ['caption', 'instruction'] as const) {
      const p = buildTryOnPrompt({ category: 'tops', garment, style });
      expect(p).toContain('The fabric is smooth and shiny, draping in soft flowing folds');
      expect(p).toContain('it is light, so it makes many soft folds');
    }
  });

  it('cleans bad fabric trait values before they reach the prompt', () => {
    const out = sanitizeGarmentInfo({ fabricTraits: { stretch: 'EXTREME' as never, thickness: 'HEAVY', weightGsm: -5 } });
    expect(out).toEqual({ fabricTraits: { thickness: 'HEAVY' } });
  });
});

describe('Phase 27 - the person keeps their own hair, headwear and accessories', () => {
  it('is said in every kind of prompt', () => {
    for (const category of ['tops', 'bottoms', 'dresses', 'outerwear']) {
      const caption = buildTryOnPrompt({ category, style: 'caption' });
      expect(caption).toMatch(/and the person's hair, any hat or headscarf, glasses, jewellery and watch, stay the same\./);
      const instruction = buildTryOnPrompt({ category, style: 'instruction' });
      expect(instruction).toMatch(/and the person's hair, any hat or headscarf, glasses, jewellery and watch\./);
      // even the short retry prompts say it
      expect(buildTryOnPrompt({ category, style: 'caption', compact: true })).toMatch(/same face, hair, headwear, accessories, pose and background/);
      expect(buildTryOnPrompt({ category, style: 'instruction', compact: true })).toMatch(/face, hair, headwear, accessories, pose and the background unchanged/);
    }
  });
});

describe('Phase 27 - styling choices', () => {
  it('turns each choice into one short phrase', () => {
    expect(resolveStyleOptions(['tucked_in', 'sleeves_rolled'], 'tops')).toEqual(['tucked in at the waist', 'with the sleeves rolled up to the elbows']);
    expect(resolveStyleOptions(['cuffed_hem', 'belted'], 'bottoms')).toEqual(['with the hems folded up in a neat cuff', 'with a belt at the waist']);
    expect(resolveStyleOptions(['jacket_open'], 'outerwear')).toEqual(['open at the front']);
  });

  it('drops unknown ids, choices that do not suit the garment, repeats, and non-text', () => {
    expect(resolveStyleOptions(['nonsense', 'tucked_in', 'tucked_in', 42, null, { a: 1 }], 'tops')).toEqual(['tucked in at the waist']);
    expect(resolveStyleOptions(['tucked_in', 'jacket_open', 'cuffed_hem'], 'dresses')).toEqual([]); // none suit a dress
    expect(resolveStyleOptions('tucked_in', 'tops')).toEqual([]); // not a list
    expect(resolveStyleOptions(undefined, 'tops')).toEqual([]);
  });

  it('of two choices that contradict each other, only the first is used', () => {
    expect(resolveStyleOptions(['tucked_in', 'untucked'], 'tops')).toEqual(['tucked in at the waist']);
    expect(resolveStyleOptions(['untucked', 'tucked_in'], 'tops')).toEqual(['untucked, with the hem hanging free']);
    expect(resolveStyleOptions(['jacket_closed', 'jacket_open'], 'outerwear')).toEqual(['closed at the front']);
    expect(resolveStyleOptions(['buttoned_up', 'top_button_open'], 'tops')).toEqual(['fully buttoned up']);
    expect(resolveStyleOptions(['hood_up', 'hood_down'], 'tops')).toEqual(['with the hood up']);
  });

  it('knows which choices suit which garment', () => {
    expect(styleOptionsFor('tops')).toContain('tucked_in');
    expect(styleOptionsFor('tops')).not.toContain('jacket_open');
    expect(styleOptionsFor('outerwear')).toEqual(expect.arrayContaining(['jacket_open', 'jacket_closed', 'sleeves_rolled']));
    expect(styleOptionsFor('bottoms')).toEqual(expect.arrayContaining(['cuffed_hem', 'belted']));
    expect(styleOptionsFor('dresses')).toEqual(['belted']);
    expect(STYLE_OPTION_IDS.length).toBe(Object.keys(STYLE_OPTIONS).length);
  });

  it('puts the choices into both prompt styles as a plain sentence', () => {
    for (const style of ['caption', 'instruction'] as const) {
      const p = buildTryOnPrompt({ category: 'tops', garment: { name: 'Oxford Shirt' }, style, styleOptions: ['tucked_in', 'sleeves_rolled'] });
      expect(p).toContain('It is worn tucked in at the waist and with the sleeves rolled up to the elbows.');
    }
    const none = buildTryOnPrompt({ category: 'tops', garment: { name: 'Oxford Shirt' }, style: 'caption', styleOptions: ['nonsense'] });
    expect(none).not.toContain('It is worn');
  });

  it('the choice follows what the garment really is, not just the shop category', () => {
    // a jacket filed under "tops" is still outerwear, so "open at the front" applies
    const p = buildTryOnPrompt({ category: 'tops', garment: { name: 'Wool Blazer' }, style: 'caption', styleOptions: ['jacket_open'] });
    expect(p).toContain('It is worn open at the front.');
  });
});

describe('Phase 27 - a prompt that gets too long drops the least important parts first', () => {
  const crowded = {
    category: 'tops',
    garment: { name: 'Silk Blouse', fabric: 'Silk satin', fabricTraits: { thickness: 'LIGHT' as const, stretch: 'HIGH' as const, transparency: 'SHEER' as const } },
    shopper: { gender: 'female' as const, size: 'XXL', garmentSize: 'XS' },
    styleOptions: ['tucked_in', 'sleeves_rolled', 'collar_up'],
    styling: 'Make it look like an evening out '.repeat(8),
    visionNotes: 'A long description of the person and the garment. '.repeat(10),
  };

  it('keeps the shopper choices, the size fit and the essentials, and drops notes and the fabric first', () => {
    const p = buildTryOnPrompt({ ...crowded, style: 'instruction' });
    expect(p.length).toBeLessThanOrEqual(1050);
    expect(p).toContain('It is worn tucked in at the waist'); // the shopper's choice survives
    expect(p).toContain('extremely too small'); // the size fit survives
    expect(p).toContain("the person's hair, any hat or headscarf"); // the person's extras survive
    expect(p).toContain('Do not return the first or the second image unchanged');
    expect(p).not.toContain('Notes:'); // the least important part goes first
  });

  it('a normal prompt is not trimmed at all', () => {
    const p = buildTryOnPrompt({ category: 'tops', garment: { name: 'Cream Tee', colour: 'Cream', fabric: 'Cotton jersey' }, style: 'caption', shopper: { size: 'L', garmentSize: 'L' } });
    expect(p).toContain('The fabric is soft and stretchy');
    expect(p).toContain('Natural folds');
    expect(p.length).toBeLessThan(1400);
  });
});

describe('Phase 27 - the engines pass the styling and report the prompt version', () => {
  it('fal gets the styling and the fabric in its one prompt, and the result carries the prompt version', async () => {
    const subscribes: any[] = [];
    const gateway: FalGateway = {
      async upload() { return 'https://v3.fal.media/files/u.png'; },
      async subscribe(model, input) { subscribes.push({ model, input }); return { data: { images: [{ url: `data:image/png;base64,${pngBytes(9).toString('base64')}` }] } }; },
    };
    const engine = new FalTryOnEngine({ gateway, sleep: async () => {}, apiKey: () => 'k', model: () => DEFAULT_FAL_MODEL });
    const result = await engine.generate({
      person: { bytes: pngBytes(1), mimeType: 'image/png' },
      garment: { bytes: pngBytes(2), mimeType: 'image/png' },
      category: 'tops',
      styleOptions: ['sleeves_rolled', 'tucked_in'],
      garmentInfo: { name: 'Denim Shirt', fabric: 'Denim', fabricTraits: { thickness: 'HEAVY' } },
    });
    expect(subscribes).toHaveLength(1); // one call, nothing extra
    expect(subscribes[0].input.image_urls).toHaveLength(2);
    const sent: string = subscribes[0].input.prompt;
    expect(sent).toContain('It is worn with the sleeves rolled up to the elbows and tucked in at the waist.');
    expect(sent).toContain('The fabric is stiff and structured');
    expect(sent).toContain('it is heavy, so it makes fewer, larger folds');
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });
});

describe('Phase 27 - the prompt preview is free', () => {
  const app = createApp('all');
  let headers: { Authorization: string };
  const json = (res: { body: string }) => JSON.parse(res.body);
  const preview = (payload: unknown, auth = headers) => app.inject({ method: 'POST', url: '/api/v1/brand/try-on/prompt-preview', headers: auth, payload: payload as object });

  beforeAll(async () => {
    seedTestUsers();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.27.0.1', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
    expect(login.statusCode).toBe(200);
    headers = { Authorization: `Bearer ${json(login).token}` };
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the exact prompt for a product, size and styling, and makes NO call to any service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await preview({ productId: 'prod_aura_dress_01', gender: 'female', size: 'M', garmentSize: 'XL', styleOptions: ['belted', 'tucked_in', 'nonsense'] });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(fetchSpy).not.toHaveBeenCalled(); // no AI, no network
    expect(body.note).toMatch(/No picture was made and nothing was charged/);
    expect(body.promptVersion).toBe(PROMPT_VERSION);
    expect(['caption', 'instruction']).toContain(body.promptStyle);
    expect(body.model).toBeTruthy();
    expect(body.prompt.full.length).toBeGreaterThan(body.prompt.compact.length);
    expect(body.length).toEqual({ full: body.prompt.full.length, compact: body.prompt.compact.length });
    expect(body.prompt.full).toContain('2 sizes bigger than their size'); // M -> XL: the text names the gap
    // only choices that suit this garment are used; the rest are listed as available
    expect(body.usedStyleOptions).not.toContain('tucked in at the waist');
    expect(body.availableStyleOptions.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(['belted']));
  });

  it('rejects a missing product, an unknown product and a caller who is not signed in', async () => {
    expect((await preview({})).statusCode).toBe(400);
    expect((await preview({ productId: 'prod_does_not_exist' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/brand/try-on/prompt-preview', payload: { productId: 'prod_aura_dress_01' } })).statusCode).toBe(401);
  });
});
