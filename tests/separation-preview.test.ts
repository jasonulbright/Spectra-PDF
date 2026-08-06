import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INK_DENSITY,
  DEFAULT_TAC_LIMIT,
  MAX_PREVIEW_DPI,
  MIN_PREVIEW_DPI,
  alarmTripped,
  aliasIsAllowed,
  clampDensity,
  clampLimit,
  compositePixel,
  compositeRequest,
  coverageRows,
  inkRows,
  isToggleableInk,
  moveInSequence,
  orderInks,
  plateCacheKey,
  previewDpi,
  prunePlateCache,
  resolveAlias,
  totalInk,
  visiblePlates,
  type CacheEntry,
  type Plate,
} from '../src/renderer/lib/separation-preview';

const CYAN: Plate = { name: 'Cyan', kind: 'process', display_rgb: [0, 174, 239], file: 'c.tif' };
const BLACK: Plate = { name: 'Black', kind: 'process', display_rgb: [35, 31, 32], file: 'k.tif' };
const SPOT: Plate = { name: 'PANTONE 185 C', kind: 'spot', display_rgb: [228, 0, 43], file: 's.tif' };
const ALL: Plate = { name: 'All', kind: 'all', display_rgb: [0, 0, 0], file: 'a.tif' };
const NONE: Plate = { name: 'None', kind: 'none', display_rgb: [255, 255, 255], file: 'n.tif' };

describe('which inks the preview offers', () => {
  it('offers process and spot inks and nothing else', () => {
    expect(isToggleableInk(CYAN)).toBe(true);
    expect(isToggleableInk(SPOT)).toBe(true);
    // /All paints every plate and owns none; /None paints nothing.
    expect(isToggleableInk(ALL)).toBe(false);
    expect(isToggleableInk(NONE)).toBe(false);
  });

  it('drops the switched-off inks and never the untoggleable ones', () => {
    const plates = [CYAN, BLACK, SPOT, ALL, NONE];
    expect(visiblePlates(plates, new Set()).map((p) => p.name)).toEqual([
      'Cyan', 'Black', 'PANTONE 185 C',
    ]);
    expect(visiblePlates(plates, new Set(['Cyan'])).map((p) => p.name)).toEqual([
      'Black', 'PANTONE 185 C',
    ]);
    expect(visiblePlates(plates, new Set(['Cyan', 'Black', 'PANTONE 185 C']))).toEqual([]);
  });

  it('carries each visible ink’s colour and density to the engine', () => {
    const request = compositeRequest(
      [CYAN, SPOT],
      new Set(),
      new Map([['Cyan', 0.4]]),
    );
    expect(request).toEqual([
      { name: 'Cyan', display_rgb: [0, 174, 239], density: 0.4 },
      { name: 'PANTONE 185 C', display_rgb: [228, 0, 43], density: DEFAULT_INK_DENSITY },
    ]);
  });

  it('clamps a density out of range rather than passing it through', () => {
    expect(clampDensity(0)).toBe(0.1);
    expect(clampDensity(99)).toBe(2);
    expect(clampDensity(Number.NaN)).toBe(DEFAULT_INK_DENSITY);
  });

  it('clamps and rounds the total-ink limit', () => {
    expect(clampLimit(0)).toBe(100);
    expect(clampLimit(1000)).toBe(400);
    expect(clampLimit(287.4)).toBe(287);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_TAC_LIMIT);
  });
});

describe('preview aliases', () => {
  const plates = [CYAN, BLACK, SPOT];

  it('draws an aliased colorant with the target’s colour, off its own plate', () => {
    const request = compositeRequest(
      plates,
      new Set(),
      new Map(),
      new Map([['PANTONE 185 C', 'Black']]),
    );
    const aliased = request.find((r) => r.name === 'PANTONE 185 C');
    // The plate FILE is still the spot's own — that is what the device wrote.
    expect(aliased?.name).toBe('PANTONE 185 C');
    expect(aliased?.display_rgb).toEqual(BLACK.display_rgb);
  });

  it('hides an aliased colorant when its target hides', () => {
    const request = compositeRequest(
      plates,
      new Set(['Black']),
      new Map(),
      new Map([['PANTONE 185 C', 'Black']]),
    );
    expect(request.map((r) => r.name)).toEqual(['Cyan']);
  });

  it('takes the target’s density, not its own', () => {
    const request = compositeRequest(
      plates,
      new Set(),
      new Map([['Black', 0.5], ['PANTONE 185 C', 1.5]]),
      new Map([['PANTONE 185 C', 'Black']]),
    );
    expect(request.find((r) => r.name === 'PANTONE 185 C')?.density).toBe(0.5);
  });

  it('falls back to the plate’s own identity when the target is not on this page', () => {
    const request = compositeRequest(
      plates,
      new Set(),
      new Map(),
      new Map([['PANTONE 185 C', 'Warm Red']]),
    );
    expect(request.find((r) => r.name === 'PANTONE 185 C')?.display_rgb)
      .toEqual(SPOT.display_rgb);
  });

  it('refuses an alias onto itself or onto an already-aliased ink', () => {
    const aliases = new Map([['PANTONE 185 C', 'Black']]);
    expect(aliasIsAllowed(aliases, 'Cyan', 'Cyan')).toBe(false);
    expect(aliasIsAllowed(aliases, 'Cyan', 'PANTONE 185 C')).toBe(false);
    expect(aliasIsAllowed(aliases, 'Cyan', 'Black')).toBe(true);
  });

  it('resolves one hop and no further', () => {
    const aliases = new Map([['a', 'b'], ['b', 'c']]);
    expect(resolveAlias(aliases, 'a')).toBe('b');
    expect(resolveAlias(aliases, 'z')).toBe('z');
  });

  it('lists one row per drawn ink, naming what was merged onto it', () => {
    const rows = inkRows([...plates, ALL], new Map([['PANTONE 185 C', 'Black']]));
    expect(rows.map((r) => r.plate.name)).toEqual(['Cyan', 'Black']);
    expect(rows.find((r) => r.plate.name === 'Black')?.aliasedFrom)
      .toEqual(['PANTONE 185 C']);
    expect(rows.find((r) => r.plate.name === 'Cyan')?.aliasedFrom).toEqual([]);
  });
});

describe('the print sequence', () => {
  it('orders by the sequence and leaves the rest behind it', () => {
    const items = [{ name: 'Cyan' }, { name: 'Black' }, { name: 'Spot' }];
    expect(orderInks(items, ['Black', 'Cyan']).map((i) => i.name))
      .toEqual(['Black', 'Cyan', 'Spot']);
    expect(orderInks(items, []).map((i) => i.name)).toEqual(['Cyan', 'Black', 'Spot']);
  });

  it('moves one ink and clamps at the ends', () => {
    const sequence = ['Cyan', 'Magenta', 'Yellow'];
    expect(moveInSequence(sequence, 'Yellow', -1)).toEqual(['Cyan', 'Yellow', 'Magenta']);
    expect(moveInSequence(sequence, 'Cyan', -1)).toEqual(sequence);
    expect(moveInSequence(sequence, 'Yellow', 1)).toEqual(sequence);
    expect(moveInSequence(sequence, 'Nowhere', 1)).toEqual(sequence);
  });
});

describe('the ink arithmetic', () => {
  it('renders one ink at full coverage as that ink’s own colour', () => {
    expect(compositePixel([{ ...CYAN, density: 1 }], [1])).toEqual([0, 174, 239]);
  });

  it('leaves the paper white where nothing prints', () => {
    expect(compositePixel([{ ...CYAN, density: 1 }, { ...SPOT, density: 1 }], [0, 0]))
      .toEqual([255, 255, 255]);
  });

  it('darkens as inks stack', () => {
    const one = compositePixel([{ ...CYAN, density: 1 }], [1]);
    const two = compositePixel(
      [{ ...CYAN, density: 1 }, { ...BLACK, density: 1 }],
      [1, 1],
    );
    expect(two[1]).toBeLessThan(one[1]);
  });

  it('makes a switched-off ink identical to one that never printed', () => {
    const hidden = compositePixel(
      [{ ...CYAN, density: 1 }, { ...SPOT, density: 1 }],
      [1, 0],
    );
    expect(hidden).toEqual(compositePixel([{ ...CYAN, density: 1 }], [1]));
  });

  it('scales an ink by its density', () => {
    const light = compositePixel([{ ...CYAN, density: 0.2 }], [1]);
    const heavy = compositePixel([{ ...CYAN, density: 1 }], [1]);
    expect(light[0]).toBeGreaterThan(heavy[0]);
  });

  it('sums coverage into a total-ink percentage', () => {
    expect(totalInk([1, 1, 1, 1])).toBe(400);
    expect(totalInk([0.9, 0.85, 0.85, 0.8])).toBeCloseTo(340, 5);
    expect(totalInk([])).toBe(0);
  });
});

describe('the raster resolution', () => {
  it('rasters a letter page at the preview’s long-edge budget', () => {
    expect(previewDpi(612, 792)).toBe(150);
  });

  it('clamps rather than producing an unusable raster', () => {
    expect(previewDpi(4, 4)).toBe(MAX_PREVIEW_DPI);
    expect(previewDpi(20000, 20000)).toBe(MIN_PREVIEW_DPI);
    expect(previewDpi(0, 0)).toBe(MIN_PREVIEW_DPI);
  });
});

describe('the plate cache', () => {
  it('keys a plate set by file, page, resolution and overprint', () => {
    const base = plateCacheKey('doc', 'p1', 150, true);
    expect(plateCacheKey('doc', 'p1', 150, true)).toBe(base);
    expect(plateCacheKey('doc', 'p1', 150, false)).not.toBe(base);
    expect(plateCacheKey('doc', 'p1', 300, true)).not.toBe(base);
    expect(plateCacheKey('doc', 'p2', 150, true)).not.toBe(base);
    expect(plateCacheKey('other', 'p1', 150, true)).not.toBe(base);
  });

  it('drops every entry whose page is gone and names them', () => {
    const cache = new Map<string, CacheEntry<number>>([
      ['a', { pageId: 'f#g1#p0', value: 1 }],
      ['b', { pageId: 'f#g1#p1', value: 2 }],
      ['c', { pageId: 'f#g2#p0', value: 3 }],
    ]);
    const removed = prunePlateCache(cache, new Set(['f#g2#p0']));
    expect(removed.sort()).toEqual(['a', 'b']);
    expect([...cache.keys()]).toEqual(['c']);
  });

  it('keeps everything when the document is unchanged', () => {
    const cache = new Map<string, CacheEntry<number>>([
      ['a', { pageId: 'p0', value: 1 }],
    ]);
    expect(prunePlateCache(cache, new Set(['p0']))).toEqual([]);
    expect(cache.size).toBe(1);
  });
});

describe('the coverage readout', () => {
  it('lists the process inks in plate order as percentages', () => {
    expect(coverageRows({ Cyan: 0.29625, Magenta: 0.34375, Yellow: 0.44125, Black: 0.15687 }))
      .toEqual([
        { name: 'Cyan', pct: 29.625 },
        { name: 'Magenta', pct: 34.375 },
        { name: 'Yellow', pct: 44.125 },
        { name: 'Black', pct: 15.687000000000001 },
      ]);
  });

  it('omits an ink the device did not report', () => {
    expect(coverageRows({ Cyan: 0.5 }).map((r) => r.name)).toEqual(['Cyan']);
    expect(coverageRows({})).toEqual([]);
  });
});

describe('the limit alarm', () => {
  it('trips only when a pixel is over the limit', () => {
    expect(alarmTripped({ over_pixels: 0 })).toBe(false);
    expect(alarmTripped({ over_pixels: 1 })).toBe(true);
  });
});
