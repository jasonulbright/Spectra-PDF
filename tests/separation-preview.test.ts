import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INK_DENSITY,
  DEFAULT_TAC_LIMIT,
  MAX_PREVIEW_DPI,
  MIN_PREVIEW_DPI,
  alarmTripped,
  aliasIsAllowed,
  blackInkIsForced,
  clampDensity,
  clampLimit,
  compositePixel,
  compositeRequest,
  coverageRows,
  effectiveBlackInk,
  inkRows,
  inventoryIsComplete,
  isToggleableInk,
  moveInSequence,
  orderInks,
  plateCacheKey,
  plateProfileComponent,
  previewDpi,
  prunePlateCache,
  readInventory,
  readSimulation,
  readSimulationProfiles,
  resolveAlias,
  resolveSimulationSource,
  simulationIsLive,
  simulationRequest,
  stagingApplies,
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
      { name: 'Cyan', display_rgb: [0, 174, 239], density: 0.4, shown_as: 'Cyan' },
      { name: 'PANTONE 185 C', display_rgb: [228, 0, 43],
        density: DEFAULT_INK_DENSITY, shown_as: 'PANTONE 185 C' },
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

describe('what the ink inventory could not read', () => {
  const INK = {
    name: 'PANTONE 185 C', kind: 'spot' as const, alternate: 'DeviceCMYK',
    display_rgb: [228, 0, 43], pages: [1], used_in: ['content'],
  };

  it('carries the engine\'s unknown list beside the inks', () => {
    const res = readInventory({ inks: [INK], unknown: ['Page 1 uses a colour space…'] });
    expect(res.inks).toEqual([INK]);
    expect(res.unknown).toEqual(['Page 1 uses a colour space…']);
    expect(inventoryIsComplete(res)).toBe(false);
  });

  it('reports a document the engine read whole as complete', () => {
    const res = readInventory({ inks: [INK], unknown: [] });
    expect(inventoryIsComplete(res)).toBe(true);
  });

  // The plates that ARE known stay honest: a stated gap beats a blank panel,
  // so the ink list survives the unknown branch rather than being withheld.
  it('keeps the inks it did reach when part of the document would not read', () => {
    expect(readInventory({ inks: [INK], unknown: ['x'] }).inks).toHaveLength(1);
  });

  it('reads a payload carrying neither field as empty, not as clean', () => {
    // `inks` empty and `unknown` empty is the shape of "nothing found",
    // which is also the shape of a response that never arrived — the guard
    // here is that neither field is invented.
    const nothing = { inks: [], unknown: [], color_families: [''] };
    expect(readInventory({})).toEqual(nothing);
    expect(readInventory(null)).toEqual(nothing);
    expect(readInventory({ inks: 'nope', unknown: 'nope' })).toEqual(nothing);
  });

  it('renders every unknown reason as a string', () => {
    expect(readInventory({ unknown: [1, null] }).unknown).toEqual(['1', 'null']);
  });
});

describe('the soft proof’s profile ladder', () => {
  it('opens on the document’s own intent, then a picked file, then the bundled press', () => {
    expect(resolveSimulationSource({ document: true, picked: true, bundled: true }))
      .toBe('document');
    expect(resolveSimulationSource({ document: false, picked: true, bundled: true }))
      .toBe('file');
    expect(resolveSimulationSource({ document: false, picked: false, bundled: true }))
      .toBe('bundled');
    expect(resolveSimulationSource({ document: false, picked: false, bundled: false }))
      .toBe('none');
  });

  it('never opens on the bundled press by itself', () => {
    // Offered, never assumed: a proof against a press neither the user chose
    // nor the document declared is a claim about nobody's press.
    expect(resolveSimulationSource({ document: false, picked: false, bundled: false }))
      .toBe('none');
  });
});

describe('the two switches', () => {
  it('forces black ink on while paper white is on, and remembers the choice', () => {
    expect(blackInkIsForced(true)).toBe(true);
    expect(blackInkIsForced(false)).toBe(false);
    // The user's own OFF survives being overridden, so turning paper white
    // off restores it rather than leaving the forced value behind.
    expect(effectiveBlackInk(true, false)).toBe(true);
    expect(effectiveBlackInk(false, false)).toBe(false);
    expect(effectiveBlackInk(false, true)).toBe(true);
  });

  it('is inert with no profile', () => {
    expect(simulationIsLive('none')).toBe(false);
    expect(simulationIsLive('bundled')).toBe(true);
    const request = simulationRequest('none', '', true, true);
    expect(request.paper_white).toBe(false);
    expect(request.black_ink).toBe(false);
  });

  it('sends the picked path only for a picked profile', () => {
    expect(simulationRequest('file', 'C:/press.icc', false, false).profile)
      .toBe('C:/press.icc');
    expect(simulationRequest('bundled', 'C:/press.icc', false, false).profile).toBe('');
  });
});

describe('the plate cache under a profile', () => {
  const CMYK_ONLY = ['DeviceCMYK', 'Separation', 'DeviceN'];
  const WITH_RGB = ['DeviceCMYK', 'DeviceRGB'];

  it('knows which pages a profile can move', () => {
    expect(stagingApplies(CMYK_ONLY)).toBe(false);
    expect(stagingApplies(WITH_RGB)).toBe(true);
    expect(stagingApplies(['ICCBased'])).toBe(true);
  });

  it('gains a profile component only where the staging applies', () => {
    const request = simulationRequest('bundled', '', false, false);
    expect(plateProfileComponent(request, CMYK_ONLY)).toBe('');
    expect(plateProfileComponent(request, WITH_RGB)).not.toBe('');
    expect(plateProfileComponent(simulationRequest('none', '', false, false), WITH_RGB))
      .toBe('');
  });

  it('re-rasters on a profile change and never on a switch flip', () => {
    const key = (source: 'none' | 'bundled', paper: boolean): string =>
      plateCacheKey('doc', 'p1', 150, true,
        plateProfileComponent(simulationRequest(source, '', paper, false), WITH_RGB));
    expect(key('bundled', false)).not.toBe(key('none', false));
    expect(key('bundled', true)).toBe(key('bundled', false));
  });

  it('re-rasters a document whose families could not be read', () => {
    // A payload that named no families is "could not tell", and the staging
    // test answers yes: proofing plates that may have come from another press
    // is the silent degradation, and a re-raster is only slower.
    const families = readInventory({ inks: [], unknown: [] }).color_families;
    expect(stagingApplies(families)).toBe(true);
  });
});

describe('what the engine says it proofed through', () => {
  const RECORD = {
    source: 'bundled',
    name: 'Artifex CMYK SWOP Profile',
    intent: 'absolute',
    black_point_compensation: false,
    refusal: '',
    assumed: ['sRGB'],
  };

  it('reads the record the composite returned', () => {
    expect(readSimulation({ simulation: RECORD })).toEqual(RECORD);
  });

  it('reads a missing record as could-not-tell, never as off', () => {
    expect(readSimulation({})).toBeNull();
    expect(readSimulation({ simulation: null })).toBeNull();
    expect(readSimulation(null)).toBeNull();
    // "Off" is a record that says so, and it is a different answer.
    expect(readSimulation({ simulation: { source: 'none' } })?.source).toBe('none');
  });

  it('reads an unrecognized source and intent as no proof at all', () => {
    const read = readSimulation({ simulation: { source: 'press', intent: 'saturation' } });
    expect(read?.source).toBe('none');
    expect(read?.intent).toBe('');
    expect(read?.refusal).toBe('');
  });

  it('carries the refusal verbatim so the panel can localize it', () => {
    const read = readSimulation({
      simulation: { ...RECORD, source: 'none', intent: '', refusal: 'that profile describes a RGB device, not a printing press' },
    });
    expect(read?.source).toBe('none');
    expect(read?.refusal).toBe('that profile describes a RGB device, not a printing press');
  });

  it('reads the profiles a document offers', () => {
    const offered = readSimulationProfiles({
      document: { present: true, embedded: false, identifier: 'CGATS TR001', name: '' },
      bundled: { present: true, name: 'Artifex CMYK SWOP Profile' },
    });
    expect(offered.document.present).toBe(true);
    expect(offered.document.embedded).toBe(false);
    expect(offered.document.identifier).toBe('CGATS TR001');
    expect(offered.bundled.name).toBe('Artifex CMYK SWOP Profile');
    // An intent present but not embeddable must not become the default, and
    // the bundled press being AVAILABLE is not the bundled press being
    // chosen — the panel opens unproofed rather than on a press nobody named.
    expect(resolveSimulationSource({
      document: offered.document.embedded, picked: false, bundled: false,
    })).toBe('none');
  });

  it('reads an absent payload as offering nothing', () => {
    const offered = readSimulationProfiles(undefined);
    expect(offered.document.present).toBe(false);
    expect(offered.bundled.present).toBe(false);
  });
});

describe('the fourth caveat the proof adds', () => {
  it('fires on exactly an incomplete inventory', () => {
    expect(inventoryIsComplete(readInventory({ inks: [], unknown: [] }))).toBe(true);
    expect(inventoryIsComplete(readInventory({ inks: [], unknown: ['a branch'] }))).toBe(false);
  });
});

describe('what the engine is asked to composite under a profile', () => {
  it('names the ink each plate is drawn as, so a channel can be found', () => {
    const request = compositeRequest(
      [CYAN, SPOT], new Set(), new Map(), new Map([['PANTONE 185 C', 'Cyan']]),
    );
    expect(request.map((r) => [r.name, r.shown_as])).toEqual([
      ['Cyan', 'Cyan'],
      ['PANTONE 185 C', 'Cyan'],
    ]);
  });

  it('falls back to the plate’s own identity when the target is not on this page', () => {
    const request = compositeRequest(
      [SPOT], new Set(), new Map(), new Map([['PANTONE 185 C', 'Warm Red']]),
    );
    expect(request[0].shown_as).toBe('PANTONE 185 C');
  });
});
