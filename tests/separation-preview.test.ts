import { describe, it, expect, beforeAll } from 'vitest';
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
  pruneRasterCache,
  putRaster,
  rasterCacheKey,
  selectRaster,
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
  INSPECT_TRAVEL_LIMIT,
  inspectInkIsAFloor,
  inspectIsAvailable,
  inspectPointToPdf,
  isInspectClick,
  pointerTravel,
  readInspection,
  resolutionState,
  convertedToProcessMessage,
  readSkippedShadings,
  type CacheEntry,
  type InspectedObject,
  type Plate,
  type RasterRecord,
  type SkippedShading,
} from '../src/renderer/lib/separation-preview';
import { displayPointToPdf, pdfPointToDisplay } from '../src/renderer/lib/pdfx-build';
import { rotateNormalizedPoint } from '../src/renderer/lib/redaction';
import i18next from '../src/renderer/i18n';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';

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

describe('the raster cache', () => {
  it('holds one raster per page, so a settings change replaces rather than stacks', () => {
    // The plate cache keys overprint (and dpi, and the proof profile); the
    // raster does not. Writing the second raster under a second key and then
    // reading the page by a partial match served the pre-change image for the
    // rest of the session — the overprint toggle changed nothing on screen.
    const cache = new Map<string, RasterRecord<string>>();
    putRaster(cache, 'doc', 'p1', 'overprint-on');
    putRaster(cache, 'doc', 'p1', 'overprint-off');
    expect(cache.size).toBe(1);
    expect(selectRaster(cache, 'doc', 'p1')).toBe('overprint-off');
  });

  it('separates pages and documents', () => {
    const cache = new Map<string, RasterRecord<string>>();
    putRaster(cache, 'doc', 'p1', 'a');
    putRaster(cache, 'doc', 'p2', 'b');
    putRaster(cache, 'other', 'p1', 'c');
    expect(selectRaster(cache, 'doc', 'p1')).toBe('a');
    expect(selectRaster(cache, 'doc', 'p2')).toBe('b');
    expect(selectRaster(cache, 'other', 'p1')).toBe('c');
    expect(selectRaster(cache, 'doc', 'p3')).toBeNull();
  });

  it('drops every raster whose page is gone and names them', () => {
    const cache = new Map<string, RasterRecord<number>>();
    putRaster(cache, 'doc', 'f#g1#p0', 1);
    putRaster(cache, 'doc', 'f#g2#p0', 2);
    const removed = pruneRasterCache(cache, new Set(['f#g2#p0']));
    expect(removed).toEqual([rasterCacheKey('doc', 'f#g1#p0')]);
    expect(selectRaster(cache, 'doc', 'f#g1#p0')).toBeNull();
    expect(selectRaster(cache, 'doc', 'f#g2#p0')).toBe(2);
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
    const nothing = {
      inks: [], unknown: [], color_families: [''], processing_step_inks: [],
    };
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

  it('names WHICH press a proof runs through', () => {
    // `profile` carries a path under `file` and an ICC description string
    // under `bundled` — the installed set is offered by name, so the request
    // has to say which of them was chosen. Empty under `bundled` is the
    // default press, which is still a NAMED press engine-side.
    expect(simulationRequest('file', 'C:/press.icc', false, false).profile)
      .toBe('C:/press.icc');
    expect(simulationRequest('bundled', 'Coated FOGRA39', false, false).profile)
      .toBe('Coated FOGRA39');
    expect(simulationRequest('bundled', '', false, false).profile).toBe('');
    // The document's own intent is read off the document; naming a press
    // there would proof against one it never declared.
    expect(simulationRequest('document', 'Coated FOGRA39', false, false).profile).toBe('');
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
      bundled: {
        present: true,
        name: 'Coated FOGRA39',
        default: 'Coated FOGRA39',
        names: ['Coated FOGRA39', 'US Web Coated (SWOP)'],
      },
    });
    expect(offered.document.present).toBe(true);
    expect(offered.document.embedded).toBe(false);
    expect(offered.document.identifier).toBe('CGATS TR001');
    expect(offered.bundled.name).toBe('Coated FOGRA39');
    // The whole installed set travels, so the picker can offer each press by
    // name instead of one anonymous "bundled" entry.
    expect(offered.bundled.default).toBe('Coated FOGRA39');
    expect(offered.bundled.names).toEqual(['Coated FOGRA39', 'US Web Coated (SWOP)']);
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
    expect(offered.bundled.names).toEqual([]);
    expect(offered.bundled.default).toBe('');
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

// ── the point inspector ────────────────────────────────────────────────────

const INSPECTOR_PAYLOAD = {
  page: 1,
  point: [60, 320],
  candidates: 2,
  ambiguous: false,
  objects: [
    {
      index: 2,
      kind: 'fill',
      nested: false,
      form: '',
      unknown: false,
      colour: {
        family: 'DeviceRGB', resource: '', colorants: [], alternate: '',
        base: '', hival: null, n: null, pattern_type: null,
        components: [1, 0, 0], rgb: [1, 0, 0], unknown: false,
      },
      resolution: null,
    },
    {
      index: 0,
      kind: 'image',
      nested: true,
      form: '/Fm1',
      unknown: false,
      colour: {
        family: 'DeviceCMYK', resource: '', colorants: [], alternate: '',
        base: '', hival: null, n: null, pattern_type: null,
        components: [0.2, 0.4, 0.9, 0], rgb: null, unknown: false,
      },
      resolution: { width: 8, height: 8, dpi: 6, dpi_x: 6, dpi_y: 6, bpc: 8 },
    },
  ],
  ink: {
    plates: [
      { name: 'Cyan', kind: 'process', pct: 20 },
      { name: 'PANTONE 185 C', kind: 'spot', pct: 0 },
    ],
    total: 20,
  },
  unknown: [],
};

describe('telling a point query from a gesture that moved the page', () => {
  it('takes a single click that barely moved', () => {
    expect(isInspectClick(1, pointerTravel({ x: 100, y: 100 }, { x: 101, y: 101 })))
      .toBe(true);
  });

  it('rejects the click a completed drag still fires', () => {
    // The webview delivers a click after a pan, so the event alone cannot
    // tell a query from a gesture and the travel is what does.
    const travel = pointerTravel({ x: 100, y: 100 }, { x: 240, y: 130 });
    expect(travel).toBeGreaterThan(INSPECT_TRAVEL_LIMIT);
    expect(isInspectClick(1, travel)).toBe(false);
  });

  it('rejects a double click', () => {
    expect(isInspectClick(2, 0)).toBe(false);
  });

  it('treats a click with no recorded press as a gesture', () => {
    expect(isInspectClick(1, pointerTravel(null, { x: 0, y: 0 }))).toBe(false);
  });

  it('waits for a composite before a click means anything', () => {
    expect(inspectIsAvailable(false, true)).toBe(true);
    expect(inspectIsAvailable(true, true)).toBe(false);
    expect(inspectIsAvailable(false, false)).toBe(false);
  });
});

describe('a clicked point in PDF user space', () => {
  const BOX = { x: 0, y: 0, width: 400, height: 400 };
  const CROPPED = { x: 100, y: 500, width: 300, height: 200 };

  it('un-projects an upright page', () => {
    expect(inspectPointToPdf(0.25, 0.25, 0, BOX, 0)).toEqual([100, 300]);
  });

  it('carries the crop origin, so a cropped page is not offset', () => {
    expect(inspectPointToPdf(0, 0, 0, CROPPED, 0)).toEqual([100, 700]);
    expect(inspectPointToPdf(1, 1, 0, CROPPED, 0)).toEqual([400, 500]);
  });

  it('round-trips through the projection at every rotation', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const [x, y] = inspectPointToPdf(0.3, 0.7, 0, CROPPED, rotation);
      const [u, v] = pdfPointToDisplay(x, y, CROPPED, rotation);
      expect(u).toBeCloseTo(0.3, 10);
      expect(v).toBeCloseTo(0.7, 10);
    }
  });

  it('takes the view rotation off before the page’s own', () => {
    // A view-only turn moves the projection and not the page, so the same
    // physical spot resolves to one user-space point either way. Without it
    // the readout is right on an upright page and wrong on every turned one.
    expect(inspectPointToPdf(0.25, 0.25, 90, BOX, 0))
      .toEqual(inspectPointToPdf(0.25, 0.75, 0, BOX, 0));
  });

  it('agrees with the shared quarter-turn helper', () => {
    const spun = rotateNormalizedPoint(0.2, 0.6, 270);
    expect(inspectPointToPdf(0.2, 0.6, 90, BOX, 0))
      .toEqual(displayPointToPdf(spun.x, spun.y, BOX, 0));
  });
});

describe('reading the engine’s point answer', () => {
  it('reads a payload with no record as “could not tell”', () => {
    // Never as "nothing is here": the two look identical in an empty readout
    // and only one of them is a measurement.
    expect(readInspection(undefined)).toBeNull();
    expect(readInspection({})).toBeNull();
    expect(readInspection({ objects: [] })).toBeNull();
  });

  it('reads an empty object list as a measurement, with its ink', () => {
    const read = readInspection({
      objects: [], candidates: 1, ambiguous: false, point: [30, 30],
      ink: { plates: [{ name: 'Cyan', kind: 'process', pct: 0 }], total: 0 },
      unknown: [],
    });
    expect(read).not.toBeNull();
    expect(read?.objects).toEqual([]);
    // The box claimed a hit the page does not paint — the case a box-only
    // implementation gets wrong.
    expect(read?.candidates).toBe(1);
    expect(read?.ink.total).toBe(0);
  });

  it('keeps the stack topmost first with what is under it', () => {
    const read = readInspection(INSPECTOR_PAYLOAD);
    expect(read?.objects.map((o) => o.kind)).toEqual(['fill', 'image']);
    expect(read?.objects[0].colour.components).toEqual([1, 0, 0]);
    expect(read?.objects[1].resolution?.dpi).toBe(6);
    expect(read?.objects[1].form).toBe('/Fm1');
  });

  it('keeps the document’s own identifiers verbatim', () => {
    const read = readInspection({
      ...INSPECTOR_PAYLOAD,
      objects: [{
        index: 0, kind: 'fill', nested: false, form: '', unknown: false,
        colour: {
          family: 'Separation', resource: 'Cs1',
          colorants: ['PANTONE 185 C'], alternate: 'DeviceCMYK', base: '',
          hival: null, n: null, pattern_type: null, components: [1],
          rgb: [1, 0.25, 0.1], unknown: false,
        },
        resolution: null,
      }],
    });
    expect(read?.objects[0].colour.colorants).toEqual(['PANTONE 185 C']);
    expect(read?.objects[0].colour.resource).toBe('Cs1');
  });

  it('falls back to a known kind rather than rendering an unknown one', () => {
    const read = readInspection({
      ...INSPECTOR_PAYLOAD,
      objects: [{ ...INSPECTOR_PAYLOAD.objects[0], kind: 'something-else' }],
    });
    expect(read?.objects[0].kind).toBe('fill');
  });

  it('reads the ambiguity flag a shared isolation unit sets', () => {
    expect(readInspection({ ...INSPECTOR_PAYLOAD, ambiguous: true })?.ambiguous)
      .toBe(true);
  });
});

describe('what the resolution row can say', () => {
  const object = (over: Partial<InspectedObject>): InspectedObject => ({
    index: 0, kind: 'fill', nested: false, form: '', unknown: false,
    colour: {
      family: '', resource: '', colorants: [], alternate: '', base: '',
      hival: null, n: null, patternType: null, components: [], rgb: null,
      unknown: false,
    },
    resolution: null,
    ...over,
  });

  it('says a vector is not a raster rather than reporting zero', () => {
    expect(resolutionState(object({ kind: 'stroke' }))).toBe('notRaster');
    expect(resolutionState(object({ kind: 'text' }))).toBe('notRaster');
    expect(resolutionState(object({ kind: 'shading' }))).toBe('notRaster');
  });

  it('carries the unmeasured third state for a degenerate placement', () => {
    expect(resolutionState(object({ kind: 'image' }))).toBe('unmeasured');
  });

  it('reports a measurement when there is one', () => {
    expect(resolutionState(object({
      kind: 'image',
      resolution: { width: 8, height: 8, dpi: 6, dpiX: 6, dpiY: 6, bpc: 8 },
    }))).toBe('measured');
  });
});

describe('the ink row’s caveat', () => {
  it('fires on exactly an incomplete inventory, and only with an answer', () => {
    const read = readInspection(INSPECTOR_PAYLOAD);
    expect(inspectInkIsAFloor(read, true)).toBe(false);
    expect(inspectInkIsAFloor(read, false)).toBe(true);
    expect(inspectInkIsAFloor(null, false)).toBe(false);
  });
});

// The conversion reports what it actually did. A spot the engine left live in
// a gradient still prints that plate, so a message claiming the colorant is
// gone is a claim the file contradicts on the press.
describe('what a spot-to-process conversion reports', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
    // English copy's source is the typed record; `locales/en/chrome.json` is
    // GENERATED from it and the catalog gate holds the two equal. Seeding
    // these three rows tests the COMPOSITION rather than whether the
    // generator has been re-run — a stale catalog is the catalog gate's
    // finding, and reading it here would report that failure twice under a
    // name that does not describe it.
    i18next.addResourceBundle('en', 'chrome', {
      'panel.inkManager.converted': PANEL_STRINGS['panel.inkManager.converted'],
      'panel.inkManager.convertedSkipped_one':
        PANEL_STRINGS['panel.inkManager.convertedSkipped_one'],
      'panel.inkManager.convertedSkipped_other':
        PANEL_STRINGS['panel.inkManager.convertedSkipped_other'],
    }, true, true);
  });

  const SPOT_NAME = 'PANTONE 185 C';
  const PLAIN = 'PANTONE 185 C is now process colour.';

  const skipped = (over: Partial<SkippedShading> = {}): SkippedShading => ({
    shading: 1,
    colorants: [SPOT_NAME],
    reason: 'the shading maps a point in the plane, not one parametric value',
    ...over,
  });

  it('reads every skip record the engine named', () => {
    const read = readSkippedShadings({
      converted: 2,
      skipped: [
        { shading: 3, colorants: [SPOT_NAME], reason: 'a' },
        { shading: 7, colorants: [SPOT_NAME, 'Varnish'], reason: 'b' },
      ],
    });
    expect(read).toEqual([
      { shading: 3, colorants: [SPOT_NAME], reason: 'a' },
      { shading: 7, colorants: [SPOT_NAME, 'Varnish'], reason: 'b' },
    ]);
  });

  it('reads a whole conversion — and a missing answer — as nothing skipped', () => {
    expect(readSkippedShadings({ shadings: 4, skipped: [] })).toEqual([]);
    expect(readSkippedShadings({ shadings: 4 })).toEqual([]);
    expect(readSkippedShadings(null)).toEqual([]);
  });

  it('says exactly the plain sentence when nothing was skipped', () => {
    expect(convertedToProcessMessage(SPOT_NAME, [])).toBe(PLAIN);
    // The empty slot leaves the record's own sentence untouched — the added
    // placeholder costs the whole-conversion message no character.
    expect(convertedToProcessMessage(SPOT_NAME, [])).toBe(
      PANEL_STRINGS['panel.inkManager.converted']
        .replace('{{skipped}}', '')
        .replace('{{name}}', SPOT_NAME),
    );
  });

  it('counts one skipped gradient in the singular', () => {
    expect(convertedToProcessMessage(SPOT_NAME, [skipped()])).toBe(
      `${PLAIN} — 1 gradient still prints it: the conversion cannot describe its colour.`,
    );
  });

  it('counts many skipped gradients in the plural', () => {
    const many = [skipped({ shading: 1 }), skipped({ shading: 2 }), skipped({ shading: 5 })];
    expect(convertedToProcessMessage(SPOT_NAME, many)).toBe(
      `${PLAIN} — 3 gradients still print it: the conversion cannot describe their colour.`,
    );
  });

  // The mutation guard: an implementation that ignored the skip list would
  // return PLAIN here, which is the sentence the file disproves.
  it('never states the plain sentence while a gradient still prints the ink', () => {
    for (const count of [1, 2, 9]) {
      const message = convertedToProcessMessage(
        SPOT_NAME,
        Array.from({ length: count }, (_, i) => skipped({ shading: i + 1 })),
      );
      expect(message).not.toBe(PLAIN);
      expect(message.startsWith(PLAIN)).toBe(true);
      expect(message).toContain(String(count));
    }
  });

  // The reason is the engine's own English report text and reaches no surface:
  // six causes exist and no catalog row spells any of them, so the counted
  // clause states only what is true of all six.
  it('states no cause the engine could contradict', () => {
    const causes = [
      'the shading maps a point in the plane, not one parametric value',
      'the shading states a background colour in the colorant’s own space',
      'the colorant’s tint transform cannot be read',
    ];
    const messages = causes.map((reason) =>
      convertedToProcessMessage(SPOT_NAME, [skipped({ reason })]),
    );
    expect(new Set(messages).size).toBe(1);
    for (const message of messages) {
      for (const cause of causes) expect(message).not.toContain(cause);
    }
  });
});
