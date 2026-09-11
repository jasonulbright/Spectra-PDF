// The strict Properties readers, pinned against the shape the engine's own
// getters return.
//
// Every control below is a FULL reply — the keys `get_advanced_properties` and
// `get_initial_view` actually build, including the three the production types
// do not carry. Every refusal case is that same control with ONE field
// mutated, so a red says what the mutation says and nothing else.
//
// The distinction the whole file is about: a value the engine writes to mean
// "this document does not have one" must PASS, and a value the engine cannot
// write must FAIL. A parser that treats the two alike is the defect BA-43
// records.
import { describe, expect, it } from 'vitest';
import {
  PropertiesReplyError,
  parseAdvancedReply,
  parseInitialViewReply,
  type ReplyErrorReason,
} from '../src/renderer/lib/properties-reply-parsers';
import { TRAPPED_VALUES } from '../src/renderer/lib/doc-advanced';
import {
  PAGE_LAYOUT_VALUES,
  PAGE_MODE_VALUES,
  VIEWER_ONLY_OPTIONS,
  ZOOM_VALUES,
} from '../src/renderer/lib/initial-view';

/** `get_advanced_properties` on a plain two-size Letter document. Carries
 * `file`, `header_version` and `catalog_version` because the engine sends
 * them, even though `AdvancedProperties` does not hold them. */
function advancedReply(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: 'C:\\docs\\report.pdf',
    version: '1.7',
    header_version: '1.7',
    catalog_version: null,
    linearized: false,
    tagged: true,
    pages: 3,
    page_sizes: [
      { width: 612, height: 792, count: 2 },
      { width: 612, height: 1008, count: 1 },
    ],
    bytes: 48210,
    trapped: 'unknown',
    base_url: '',
    has_open_action: true,
    search_index: null,
    ...patch,
  };
}

/** `get_initial_view` on a document that opens at page 2 at 150%. */
function initialViewReply(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: 'C:\\docs\\report.pdf',
    page_layout: 'two-column-right',
    page_mode: 'thumbnails',
    open_page: 2,
    zoom: 'percent',
    zoom_percent: 150,
    hide_toolbar: false,
    hide_menubar: false,
    hide_window_ui: false,
    fit_window: true,
    center_window: false,
    display_doc_title: true,
    direction: 'R2L',
    open_action_replaceable: true,
    pages: 3,
    ...patch,
  };
}

/** Assert a refusal and its machine identity. */
function refuses(run: () => unknown, path: string, reason: ReplyErrorReason): void {
  let caught: unknown;
  try {
    run();
  } catch (e: unknown) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PropertiesReplyError);
  const error = caught as PropertiesReplyError;
  expect({ path: error.path, reason: error.reason }).toEqual({ path, reason });
  // The identifier is a path and a reason, never a sentence.
  expect(error.message).toBe(`${path}:${reason}`);
}

describe('parseAdvancedReply: the engine\u2019s own reply', () => {
  it('reads a full reply and drops the fields the type does not carry', () => {
    expect(parseAdvancedReply(advancedReply())).toEqual({
      version: '1.7',
      linearized: false,
      tagged: true,
      pages: 3,
      page_sizes: [
        { width: 612, height: 792, count: 2 },
        { width: 612, height: 1008, count: 1 },
      ],
      bytes: 48210,
      trapped: 'unknown',
      base_url: '',
      has_open_action: true,
      search_index: null,
    });
  });

  it('ignores fields a later engine adds', () => {
    const parsed = parseAdvancedReply(advancedReply({ permissions: { print: true } }));
    expect(Object.keys(parsed).sort()).toEqual([
      'base_url', 'bytes', 'has_open_action', 'linearized', 'page_sizes',
      'pages', 'search_index', 'tagged', 'trapped', 'version',
    ]);
  });

  it('accepts every version the engine\u2019s reader can produce', () => {
    for (const version of ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0']) {
      expect(parseAdvancedReply(advancedReply({ version })).version).toBe(version);
    }
  });

  it('accepts every trapped value', () => {
    for (const trapped of TRAPPED_VALUES) {
      expect(parseAdvancedReply(advancedReply({ trapped })).trapped).toBe(trapped);
    }
  });
});

describe('parseAdvancedReply: known absence passes', () => {
  it('accepts a null search index as none recorded', () => {
    expect(parseAdvancedReply(advancedReply({ search_index: null })).search_index).toBeNull();
  });

  it('accepts a recorded search index', () => {
    expect(parseAdvancedReply(advancedReply({ search_index: 'report.pdx' })).search_index)
      .toBe('report.pdx');
  });

  it('accepts an empty base URL as no base URI', () => {
    expect(parseAdvancedReply(advancedReply({ base_url: '' })).base_url).toBe('');
  });

  it('refuses missing page-size evidence for existing pages', () => {
    refuses(() => parseAdvancedReply(advancedReply({ page_sizes: [] })), 'advanced.page_sizes', 'inconsistent');
  });

  it('accepts a degenerate page box, which the engine reports faithfully', () => {
    const reply = advancedReply({ pages: 1, page_sizes: [{ width: 0, height: 792, count: 1 }] });
    expect(parseAdvancedReply(reply).page_sizes).toEqual([{ width: 0, height: 792, count: 1 }]);
  });

  it('refuses a partial page-size inventory', () => {
    const reply = advancedReply({ pages: 9, page_sizes: [{ width: 612, height: 792, count: 1 }] });
    refuses(() => parseAdvancedReply(reply), 'advanced.page_sizes', 'inconsistent');
  });

  it('accepts a zero-page count and zero bytes', () => {
    const reply = advancedReply({ pages: 0, bytes: 0, page_sizes: [] });
    expect(parseAdvancedReply(reply)).toMatchObject({ pages: 0, bytes: 0 });
  });
});

describe('parseAdvancedReply: the root', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ version: '1.7' }]],
    ['a string', '{"version":"1.7"}'],
    ['a number', 7],
    ['a boolean', true],
  ])('refuses %s as a reply', (_label, value) => {
    refuses(() => parseAdvancedReply(value), 'advanced', 'not-an-object');
  });

  it('refuses an empty object, naming the first field it wants', () => {
    refuses(() => parseAdvancedReply({}), 'advanced.version', 'missing');
  });
});

describe('parseAdvancedReply: missing fields are refused, not defaulted', () => {
  it.each([
    'version', 'linearized', 'tagged', 'pages', 'page_sizes', 'bytes',
    'trapped', 'base_url', 'has_open_action', 'search_index',
  ])('refuses a reply with no %s', (key) => {
    const reply = advancedReply();
    delete reply[key];
    refuses(() => parseAdvancedReply(reply), `advanced.${key}`, 'missing');
  });
});

describe('parseAdvancedReply: wrong types are refused, not coerced', () => {
  it.each([
    ['linearized', 'true'],
    ['linearized', 1],
    ['linearized', null],
    ['tagged', 'false'],
    ['tagged', 0],
    ['tagged', null],
    ['has_open_action', 'yes'],
    ['has_open_action', null],
    ['version', 1.7],
    ['version', null],
    ['trapped', null],
    ['trapped', true],
    ['base_url', null],
    ['base_url', 0],
    ['search_index', 4],
    ['search_index', false],
    ['pages', '3'],
    ['pages', null],
    ['bytes', '48210'],
    ['page_sizes', null],
    ['page_sizes', {}],
    ['page_sizes', '[]'],
  ])('refuses %s = %p', (key, value) => {
    refuses(() => parseAdvancedReply(advancedReply({ [key]: value })), `advanced.${key}`, 'wrong-type');
  });

  it('refuses a boolean spelled as a string even when it reads true', () => {
    // The tolerant parser answers `false` for 'true', because it compares
    // against `=== true`. Either answer is a lie about the document.
    refuses(
      () => parseAdvancedReply(advancedReply({ tagged: 'true' })),
      'advanced.tagged',
      'wrong-type',
    );
  });
});

describe('parseAdvancedReply: values the engine cannot write', () => {
  it.each([
    ['2.1', 'a version no engine reader accepts'],
    ['1.8', 'a version outside ISO 32000-1'],
    ['1.70', 'an unnormalized version'],
    [' 1.7', 'a padded version'],
    ['PDF 1.7', 'a decorated version'],
    ['', 'an empty version'],
  ])('refuses version %p (%s)', (version) => {
    refuses(() => parseAdvancedReply(advancedReply({ version })), 'advanced.version', 'unknown-value');
  });

  it.each(['maybe', 'True', 'TRUE', 'yes', ''])('refuses trapped %p', (trapped) => {
    refuses(() => parseAdvancedReply(advancedReply({ trapped })), 'advanced.trapped', 'unknown-value');
  });

  it('refuses an empty search index: the engine writes null, never a blank', () => {
    refuses(
      () => parseAdvancedReply(advancedReply({ search_index: '' })),
      'advanced.search_index',
      'empty',
    );
  });

  it.each([
    ['pages', -1, 'out-of-range'],
    ['pages', 2.5, 'not-integer'],
    ['pages', Number.NaN, 'not-finite'],
    ['pages', Number.POSITIVE_INFINITY, 'not-finite'],
    ['bytes', -4, 'out-of-range'],
    ['bytes', 1.5, 'not-integer'],
    ['bytes', Number.NaN, 'not-finite'],
  ])('refuses %s = %p as %s', (key, value, reason) => {
    refuses(
      () => parseAdvancedReply(advancedReply({ [key]: value })),
      `advanced.${key}`,
      reason as ReplyErrorReason,
    );
  });
});

describe('parseAdvancedReply: page-size rows are refused, never skipped', () => {
  it.each([
    ['null', null, 'advanced.page_sizes[0]', 'not-an-object'],
    ['an array', [612, 792, 1], 'advanced.page_sizes[0]', 'not-an-object'],
    ['a string', '612x792', 'advanced.page_sizes[0]', 'not-an-object'],
    ['no width', { height: 792, count: 1 }, 'advanced.page_sizes[0].width', 'missing'],
    ['no height', { width: 612, count: 1 }, 'advanced.page_sizes[0].height', 'missing'],
    ['no count', { width: 612, height: 792 }, 'advanced.page_sizes[0].count', 'missing'],
    ['a string width', { width: '612', height: 792, count: 1 }, 'advanced.page_sizes[0].width', 'wrong-type'],
    ['a null height', { width: 612, height: null, count: 1 }, 'advanced.page_sizes[0].height', 'wrong-type'],
    ['a NaN width', { width: Number.NaN, height: 792, count: 1 }, 'advanced.page_sizes[0].width', 'not-finite'],
    ['an infinite height', { width: 612, height: Number.POSITIVE_INFINITY, count: 1 }, 'advanced.page_sizes[0].height', 'not-finite'],
    ['a negative width', { width: -612, height: 792, count: 1 }, 'advanced.page_sizes[0].width', 'out-of-range'],
    ['a zero count', { width: 612, height: 792, count: 0 }, 'advanced.page_sizes[0].count', 'out-of-range'],
    ['a fractional count', { width: 612, height: 792, count: 1.5 }, 'advanced.page_sizes[0].count', 'not-integer'],
  ])('refuses a row that is %s', (_label, row, path, reason) => {
    refuses(
      () => parseAdvancedReply(advancedReply({ page_sizes: [row] })),
      path as string,
      reason as ReplyErrorReason,
    );
  });

  it('names the offending row by index', () => {
    const reply = advancedReply({
      page_sizes: [
        { width: 612, height: 792, count: 2 },
        { width: 612, height: 1008, count: 1 },
        { width: 595.28, height: 841.89, count: null },
      ],
    });
    refuses(() => parseAdvancedReply(reply), 'advanced.page_sizes[2].count', 'wrong-type');
  });

  it('refuses two rows for one size: the engine groups by size', () => {
    const reply = advancedReply({
      page_sizes: [
        { width: 612, height: 792, count: 2 },
        { width: 612, height: 792, count: 1 },
      ],
    });
    refuses(() => parseAdvancedReply(reply), 'advanced.page_sizes[1]', 'duplicate');
  });

  it('keeps a rotated pair distinct from its portrait original', () => {
    const reply = advancedReply({
      page_sizes: [
        { width: 612, height: 792, count: 2 },
        { width: 792, height: 612, count: 1 },
      ],
    });
    expect(parseAdvancedReply(reply).page_sizes).toHaveLength(2);
  });
});

describe('parseInitialViewReply: the engine\u2019s own reply', () => {
  it('reads a full reply and drops the fields the type does not carry', () => {
    expect(parseInitialViewReply(initialViewReply())).toEqual({
      page_layout: 'two-column-right',
      page_mode: 'thumbnails',
      open_page: 2,
      zoom: 'percent',
      zoom_percent: 150,
      hide_toolbar: false,
      hide_menubar: false,
      hide_window_ui: false,
      fit_window: true,
      center_window: false,
      display_doc_title: true,
      direction: 'R2L',
      open_action_replaceable: true,
      pages: 3,
    });
  });

  it('accepts every page layout the engine maps', () => {
    for (const page_layout of PAGE_LAYOUT_VALUES) {
      expect(parseInitialViewReply(initialViewReply({ page_layout })).page_layout)
        .toBe(page_layout);
    }
  });

  it('accepts every page mode the engine maps', () => {
    for (const page_mode of PAGE_MODE_VALUES) {
      expect(parseInitialViewReply(initialViewReply({ page_mode })).page_mode).toBe(page_mode);
    }
  });

  it('accepts every zoom form, each with the percentage it implies', () => {
    for (const zoom of ZOOM_VALUES) {
      const zoom_percent = zoom === 'percent' ? 150 : null;
      expect(parseInitialViewReply(initialViewReply({ zoom, zoom_percent })).zoom).toBe(zoom);
    }
  });

  it('accepts both reading directions', () => {
    for (const direction of ['L2R', 'R2L']) {
      expect(parseInitialViewReply(initialViewReply({ direction })).direction).toBe(direction);
    }
  });

  it('ignores fields a later engine adds', () => {
    const parsed = parseInitialViewReply(initialViewReply({ print_scaling: 'None' }));
    expect(Object.keys(parsed)).not.toContain('print_scaling');
  });
});

describe('parseInitialViewReply: known absence passes', () => {
  it('accepts no opening page with the default zoom', () => {
    const parsed = parseInitialViewReply(
      initialViewReply({ open_page: null, zoom: 'default', zoom_percent: null }),
    );
    expect(parsed).toMatchObject({ open_page: null, zoom: 'default', zoom_percent: null });
  });

  it('refuses a fit zoom without a resolvable opening page', () => {
    refuses(() => parseInitialViewReply(
      initialViewReply({ open_page: null, zoom: 'fit-width', zoom_percent: null })),
      'initialView.open_page', 'inconsistent');
  });

  it('accepts a document that states no layout, mode or direction', () => {
    const parsed = parseInitialViewReply(
      initialViewReply({ page_layout: 'default', page_mode: 'default', direction: 'L2R' }),
    );
    expect(parsed).toMatchObject({ page_layout: 'default', page_mode: 'default', direction: 'L2R' });
  });

  it('accepts a script open action as not replaceable', () => {
    expect(parseInitialViewReply(initialViewReply({ open_action_replaceable: false }))
      .open_action_replaceable).toBe(false);
  });

  it('accepts a magnification outside the panel\u2019s own range', () => {
    // `_read_zoom` applies no bounds; the SETTER enforces 1..6400. A document
    // whose /XYZ scale is 0.001 reads back as 0.1, and refusing it here would
    // refuse a faithful reply. See the module note on the asymmetry.
    for (const zoom_percent of [0.1, 0.5, 6400, 100000]) {
      expect(parseInitialViewReply(initialViewReply({ zoom_percent })).zoom_percent)
        .toBe(zoom_percent);
    }
  });

  it('accepts an opening page equal to the page count', () => {
    expect(parseInitialViewReply(initialViewReply({ open_page: 3, pages: 3 })).open_page).toBe(3);
  });
});

describe('parseInitialViewReply: the root and missing fields', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'default'],
    ['a number', 0],
  ])('refuses %s as a reply', (_label, value) => {
    refuses(() => parseInitialViewReply(value), 'initialView', 'not-an-object');
  });

  it.each([
    'page_layout', 'page_mode', 'open_page', 'zoom', 'zoom_percent',
    ...VIEWER_ONLY_OPTIONS,
    'direction', 'open_action_replaceable', 'pages',
  ])('refuses a reply with no %s', (key) => {
    const reply = initialViewReply();
    delete reply[key];
    refuses(() => parseInitialViewReply(reply), `initialView.${key}`, 'missing');
  });
});

describe('parseInitialViewReply: wrong types and unknown values', () => {
  it.each([
    ...VIEWER_ONLY_OPTIONS.map((option) => [option, 'true'] as const),
    ...VIEWER_ONLY_OPTIONS.map((option) => [option, 1] as const),
    ...VIEWER_ONLY_OPTIONS.map((option) => [option, null] as const),
    ['open_action_replaceable', 'false'] as const,
    ['open_action_replaceable', null] as const,
    ['page_layout', null] as const,
    ['page_layout', 2] as const,
    ['page_mode', null] as const,
    ['zoom', null] as const,
    ['direction', null] as const,
    ['direction', 0] as const,
    ['pages', '3'] as const,
    ['pages', null] as const,
    ['open_page', '2'] as const,
    ['open_page', true] as const,
    ['zoom_percent', '150'] as const,
    ['zoom_percent', true] as const,
  ])('refuses %s = %p', (key, value) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ [key as string]: value })),
      `initialView.${key}`,
      'wrong-type',
    );
  });

  it.each(['SinglePage', 'single', 'two-page', 'Default', ''])(
    'refuses page_layout %p, the /PageLayout name rather than the panel value',
    (page_layout) => {
      refuses(
        () => parseInitialViewReply(initialViewReply({ page_layout })),
        'initialView.page_layout',
        'unknown-value',
      );
    },
  );

  it.each(['UseThumbs', 'fullscreen', 'FullScreen', ''])('refuses page_mode %p', (page_mode) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ page_mode })),
      'initialView.page_mode',
      'unknown-value',
    );
  });

  it.each(['XYZ', 'fit', 'fit-page-width', 'Percent', ''])('refuses zoom %p', (zoom) => {
    refuses(() => parseInitialViewReply(initialViewReply({ zoom })), 'initialView.zoom', 'unknown-value');
  });

  it.each(['ltr', 'L2r', 'LTR', 'R2l', ''])('refuses direction %p', (direction) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ direction })),
      'initialView.direction',
      'unknown-value',
    );
  });
});

describe('parseInitialViewReply: page and zoom limits', () => {
  it.each([
    [0, 'out-of-range'],
    [-1, 'out-of-range'],
    [1.5, 'not-integer'],
    [Number.NaN, 'not-finite'],
    [Number.POSITIVE_INFINITY, 'not-finite'],
  ])('refuses open_page %p as %s', (open_page, reason) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ open_page })),
      'initialView.open_page',
      reason as ReplyErrorReason,
    );
  });

  it('refuses an opening page past the end of the document', () => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ open_page: 4, pages: 3 })),
      'initialView.open_page',
      'out-of-range',
    );
  });

  it.each([
    [0, 'out-of-range'],
    [-150, 'out-of-range'],
    [Number.NaN, 'not-finite'],
    [Number.POSITIVE_INFINITY, 'not-finite'],
  ])('refuses zoom_percent %p as %s', (zoom_percent, reason) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ zoom_percent })),
      'initialView.zoom_percent',
      reason as ReplyErrorReason,
    );
  });

  it.each([
    [-1, 'out-of-range'],
    [2.5, 'not-integer'],
    [Number.NaN, 'not-finite'],
  ])('refuses pages %p as %s', (pages, reason) => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ pages, open_page: null, zoom: 'default', zoom_percent: null })),
      'initialView.pages',
      reason as ReplyErrorReason,
    );
  });
});

describe('parseInitialViewReply: the zoom pair must agree', () => {
  it('refuses a percentage without the percent form', () => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ zoom: 'fit-page', zoom_percent: 150 })),
      'initialView.zoom_percent',
      'inconsistent',
    );
  });

  it('refuses the percent form with no percentage', () => {
    refuses(
      () => parseInitialViewReply(initialViewReply({ zoom: 'percent', zoom_percent: null })),
      'initialView.zoom_percent',
      'inconsistent',
    );
  });

  it.each(ZOOM_VALUES.filter((z) => z !== 'percent'))(
    'refuses a percentage alongside %s',
    (zoom) => {
      refuses(
        () => parseInitialViewReply(initialViewReply({ zoom, zoom_percent: 100 })),
        'initialView.zoom_percent',
        'inconsistent',
      );
    },
  );
});
