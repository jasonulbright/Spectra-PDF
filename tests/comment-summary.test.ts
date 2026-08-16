// The comment summary's renderer half.
//
// The FIRST half is the parity gate. The ENGINE decides which comments, in
// what order; the renderer's job is to go through that answer rather than
// re-derive one, and to hand back parameters the engine actually models. Both
// vocabularies — the sorts, the modes, the placements, the furniture label
// names — are read out of `engine/comment_summary.py`'s own source text, so a
// control the engine grew and the dialog never offered, or a label the dialog
// sends and the engine never reads, fails here rather than at run time.
//
// The SECOND half is the pure formatting: the ordering, the filter shape, the
// date rendering (the reader's format at the document's own offset), and the
// file name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from '../src/renderer/i18n';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import {
  COMMENT_SORTS,
  DEFAULT_SUMMARY_OPTIONS,
  SUMMARY_MODES,
  SUMMARY_PAPERS,
  SUMMARY_PLACEMENTS,
  SUBTYPE_KEYS,
  engineFilter,
  filterIsActive,
  formatCommentDate,
  localeDigits,
  matchWorkspaceRow,
  orderedComments,
  renderedDates,
  summaryExclusions,
  summaryFileName,
  summaryLabels,
  summaryParams,
  typeLabel,
  type CommentModel,
  type EngineComment,
  type SummaryResult,
} from '../src/renderer/lib/comment-summary';

const ENGINE = readFileSync(
  resolve(__dirname, '../src/engine/comment_summary.py'),
  'utf8',
);

/** The bare strings of a Python tuple-of-strings literal, one line or many. */
function stringsOf(name: string): string[] {
  const at = ENGINE.indexOf(`\n${name} = (`);
  expect(at, `${name} is not in the engine`).toBeGreaterThan(-1);
  const body = ENGINE.slice(at, ENGINE.indexOf(')', at));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The keys of the engine's DEFAULT_LABELS dict. */
function defaultLabelKeys(): string[] {
  const at = ENGINE.indexOf('\nDEFAULT_LABELS: dict[str, str] = {');
  expect(at, 'DEFAULT_LABELS is not in the engine').toBeGreaterThan(-1);
  const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at));
  return [...body.matchAll(/^ {4}"([A-Za-z]+)":/gm)].map((m) => m[1]);
}

function comment(over: Partial<EngineComment> & { id: string }): EngineComment {
  return {
    page: 1,
    subtype: 'Text',
    rect: [10, 10, 30, 30],
    contents: '',
    author: '',
    subject: '',
    created: null,
    modified: null,
    state: '',
    state_model: '',
    name: '',
    reply_to: null,
    reply_type: null,
    children: [],
    orphan: false,
    cycle: false,
    ...over,
  };
}

function model(comments: EngineComment[]): CommentModel {
  return {
    comments,
    count: comments.length,
    found: comments.length,
    authors: [],
    subtypes: [],
    states: [],
    by_type: {},
    excluded: { filtered: 0, unmodelled: 0 },
    unreadable: [],
    sort: 'page',
  };
}

// ── the engine's vocabulary, mirrored ─────────────────────────────────────

describe('the engine is the authority on the controls', () => {
  it('offers exactly the sorts the engine accepts', () => {
    expect([...COMMENT_SORTS]).toEqual(stringsOf('SORTS'));
  });

  it('offers exactly the modes the engine accepts', () => {
    expect([...SUMMARY_MODES]).toEqual(stringsOf('MODES'));
  });

  it('offers exactly the placements the engine accepts', () => {
    expect([...SUMMARY_PLACEMENTS]).toEqual(stringsOf('PLACEMENTS'));
  });

  it('sends only filter conditions the engine models', () => {
    const keys = stringsOf('FILTER_KEYS');
    const everything = engineFilter({
      authors: ['a'],
      subtypes: ['Text'],
      states: ['Accepted'],
      pages: '1-2',
      has_body: true,
    });
    expect(Object.keys(everything).sort()).toEqual([...keys].sort());
  });

  it('offers only paper sizes the engine has', () => {
    const at = ENGINE.indexOf('from engine.create_pdf import PAGE_SIZES');
    expect(at, 'the engine no longer reads its paper sizes from create_pdf')
      .toBeGreaterThan(-1);
    const sizes = readFileSync(resolve(__dirname, '../src/engine/create_pdf.py'), 'utf8');
    const body = sizes.slice(
      sizes.indexOf('PAGE_SIZES: dict[str, tuple[float, float]] = {'),
      sizes.indexOf('\n}', sizes.indexOf('PAGE_SIZES: dict')),
    );
    const names = [...body.matchAll(/^ {4}"([a-z0-9]+)":/gm)].map((m) => m[1]);
    expect([...SUMMARY_PAPERS].sort()).toEqual(names.sort());
  });

  it('resolves every furniture label the engine writes, and no other', () => {
    const engineKeys = defaultLabelKeys();
    expect(engineKeys.length).toBeGreaterThan(20);
    const labels = summaryLabels(['Text']);
    const sent = Object.keys(labels).filter((k) => k !== 'types');
    for (const key of sent) {
      expect(engineKeys, `the engine has no furniture called ${key}`).toContain(key);
    }
    for (const key of engineKeys) {
      expect(sent, `the engine writes ${key} and the caller never resolves it`)
        .toContain(key);
    }
  });

  it('every furniture label carries the engine default\u2019s placeholders', () => {
    const at = ENGINE.indexOf('\nDEFAULT_LABELS: dict[str, str] = {');
    // A wrapped entry puts its string on the next line; joining the
    // continuation back onto its key is what lets every default be compared,
    // not only the short ones.
    const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at)).replace(/\n\s+"/g, ' "');
    const defaults = new Map<string, string>();
    for (const m of body.matchAll(/"([A-Za-z]+)": "((?:[^"\\]|\\.)*)",/g)) {
      defaults.set(m[1], m[2]);
    }
    expect(defaults.size).toBe(defaultLabelKeys().length);
    const holders = (s: string): string =>
      [...s.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]).sort().join(',');
    const labels = summaryLabels([]) as Record<string, string>;
    for (const [key, english] of defaults) {
      expect(holders(labels[key]), `${key} placeholders diverge from the engine`)
        .toBe(holders(english));
    }
  });
});

// ── the panel goes through the engine's order ─────────────────────────────

describe('orderedComments', () => {
  it('keeps the engine\u2019s sequence exactly', () => {
    const rows = orderedComments(
      model([comment({ id: 'c3' }), comment({ id: 'c1' }), comment({ id: 'c2' })]),
    );
    expect(rows.map((r) => r.comment.id)).toEqual(['c3', 'c1', 'c2']);
  });

  it('indents a reply under its parent and a nested reply under that', () => {
    const rows = orderedComments(
      model([
        comment({ id: 'c1' }),
        comment({ id: 'c2', reply_to: 'c1', reply_type: 'reply' }),
        comment({ id: 'c3', reply_to: 'c2', reply_type: 'reply' }),
      ]),
    );
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it('leaves a group member at the top level', () => {
    const rows = orderedComments(
      model([
        comment({ id: 'c1' }),
        comment({ id: 'c2', reply_to: 'c1', reply_type: 'group' }),
      ]),
    );
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('leaves a promoted orphan at the top level', () => {
    const rows = orderedComments(
      model([comment({ id: 'c9', reply_type: 'reply', orphan: true })]),
    );
    expect(rows[0].depth).toBe(0);
  });
});

describe('the filter', () => {
  it('sends an unset condition as ABSENT, never as an empty list', () => {
    expect(engineFilter({ authors: [], subtypes: ['Text'] })).toEqual({
      subtypes: ['Text'],
    });
    expect(engineFilter({})).toEqual({});
  });

  it('knows when it narrows nothing', () => {
    expect(filterIsActive({})).toBe(false);
    expect(filterIsActive({ authors: [] })).toBe(false);
    expect(filterIsActive({ has_body: false })).toBe(true);
    expect(filterIsActive({ pages: '2' })).toBe(true);
  });
});

describe('matchWorkspaceRow', () => {
  const rows = [
    { annotationId: 'a', subtype: 'Square', rect: [10, 10, 30, 30] as const },
    { annotationId: 'b', subtype: 'Square', rect: [10, 10, 30, 30] as const },
    { annotationId: 'c', subtype: 'Text', rect: [40, 40, 60, 60] as const },
  ];

  it('pairs on subtype and the raw rect', () => {
    const used = new Set<string>();
    const hit = matchWorkspaceRow(
      comment({ id: 'c1', subtype: 'Text', rect: [40, 40, 60, 60] }),
      rows,
      used,
    );
    expect(hit?.annotationId).toBe('c');
  });

  it('claims each workspace row at most once', () => {
    const used = new Set<string>();
    const square = comment({ id: 'c1', subtype: 'Square', rect: [10, 10, 30, 30] });
    expect(matchWorkspaceRow(square, rows, used)?.annotationId).toBe('a');
    expect(matchWorkspaceRow(square, rows, used)?.annotationId).toBe('b');
    expect(matchWorkspaceRow(square, rows, used)).toBeNull();
  });

  it('never pairs a comment with no readable position', () => {
    expect(matchWorkspaceRow(comment({ id: 'c1', rect: null }), rows, new Set())).toBeNull();
  });
});

// ── the parameters the dialog assembles ───────────────────────────────────

describe('summaryParams', () => {
  const options = { ...DEFAULT_SUMMARY_OPTIONS, filter: { authors: ['Ada'] } };
  const built = (): Record<string, unknown> =>
    summaryParams(
      'C:/work/file.pdf',
      'C:/out/summary.pdf',
      options,
      model([
        comment({
          id: 'c1',
          modified: {
            raw: "D:20260814093000+02'00'",
            year: 2026, month: 8, day: 14, hour: 9, minute: 30, second: 0, offset: 120,
          },
        }),
      ]),
      'file.pdf',
      'C:/fonts',
    );

  it('carries every control the engine takes', () => {
    const params = built();
    for (const key of [
      'file', 'output', 'mode', 'placement', 'connectors', 'gutter', 'paper',
      'sort', 'filter', 'labels', 'dates', 'digits', 'lang', 'direction',
      'font_path', 'document_name',
    ]) {
      expect(params, `summarize_comments takes ${key}`).toHaveProperty(key);
    }
    const signature = ENGINE.slice(
      ENGINE.indexOf('def summarize_comments('),
      ENGINE.indexOf(') -> dict:', ENGINE.indexOf('def summarize_comments(')),
    );
    for (const key of Object.keys(params)) {
      expect(signature, `summarize_comments has no ${key} parameter`).toContain(`${key}:`);
    }
  });

  it('sends the reader\u2019s rendering of each raw date', () => {
    const params = built();
    const dates = params.dates as Record<string, string>;
    expect(Object.keys(dates)).toEqual(["D:20260814093000+02'00'"]);
    expect(dates["D:20260814093000+02'00'"]).toContain('+02:00');
  });

  it('sends the filter in the engine\u2019s own shape', () => {
    expect(built().filter).toEqual({ authors: ['Ada'] });
  });
});

describe('renderedDates', () => {
  it('maps each distinct raw string once, from both date keys', () => {
    const stamp = {
      raw: 'D:20260814101500Z',
      year: 2026, month: 8, day: 14, hour: 10, minute: 15, second: 0, offset: 0,
    };
    const dates = renderedDates(
      model([
        comment({ id: 'c1', created: stamp, modified: stamp }),
        comment({ id: 'c2', modified: stamp }),
      ]),
    );
    expect(Object.keys(dates)).toEqual(['D:20260814101500Z']);
  });
});

// ── the date rendering ────────────────────────────────────────────────────

describe('formatCommentDate', () => {
  const at = (offset: number | null): Parameters<typeof formatCommentDate>[0] => ({
    raw: 'D:20260814093000',
    year: 2026, month: 8, day: 14, hour: 9, minute: 30, second: 0, offset,
  });

  it('renders the wall clock the document recorded, never this machine\u2019s', () => {
    // The same wall clock whatever zone the machine running the test is in
    // and whatever offset the document recorded — converting would move a
    // comment across a date boundary for every reader who is not in the
    // author's zone. Compared against the formatter's own rendering of that
    // instant in UTC, so the assertion holds in every locale's time style.
    const wall = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 7, 14, 9, 30, 0)));
    expect(formatCommentDate(at(120))).toContain(wall);
    expect(formatCommentDate(at(-330))).toContain(wall);
    expect(formatCommentDate(at(null))).toContain(wall);
  });

  it('renders the offset the document recorded', () => {
    expect(formatCommentDate(at(120))).toContain('+02:00');
    expect(formatCommentDate(at(-330))).toContain('-05:30');
    expect(formatCommentDate(at(0))).toContain('+00:00');
  });

  it('says so when no offset was recorded, rather than assuming UTC', () => {
    expect(formatCommentDate(at(null))).toBe(
      PANEL_STRINGS['panel.comments.dateNoOffset'].replace(
        '{{date}}',
        formatCommentDate(at(null)).replace(/ \(.*\)$/, ''),
      ),
    );
  });

  it('shows a value that is not a date string verbatim', () => {
    expect(formatCommentDate({ raw: 'last Tuesday' })).toBe('last Tuesday');
  });

  it('says so when there is no date at all', () => {
    expect(formatCommentDate(null)).toBe(PANEL_STRINGS['panel.comments.dateMissing']);
  });
});

describe('localeDigits', () => {
  it('is ten digits, in the reader\u2019s own numerals', () => {
    expect(localeDigits()).toHaveLength(10);
    expect(localeDigits()).toBe('0123456789');
  });
});

// ── the file name ─────────────────────────────────────────────────────────

describe('summaryFileName', () => {
  it('is date-first so one folder sorts chronologically', () => {
    expect(summaryFileName('Contract.pdf', new Date(2026, 7, 14, 9, 5))).toBe(
      'Contract-comments-20260814-0905.pdf',
    );
  });

  it('drops the source suffix whatever its case', () => {
    expect(summaryFileName('Deal.PDF', new Date(2026, 0, 2, 3, 4))).toBe(
      'Deal-comments-20260102-0304.pdf',
    );
  });

  it('strips the characters a path cannot carry', () => {
    expect(summaryFileName('a/b:c*d?.pdf', new Date(2026, 0, 2, 3, 4))).toBe(
      'a_b_c_d_-comments-20260102-0304.pdf',
    );
  });
});

// ── the subtype vocabulary ────────────────────────────────────────────────

describe('typeLabel', () => {
  it('names every markup subtype the engine can report', () => {
    const engine = readFileSync(resolve(__dirname, '../src/engine/annotations.py'), 'utf8');
    const body = engine.slice(engine.indexOf('_MARKUP = {'), engine.indexOf('\n}', engine.indexOf('_MARKUP = {')));
    const subtypes = [...body.matchAll(/"\/([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(subtypes.length).toBeGreaterThan(10);
    for (const subtype of subtypes) {
      expect(SUBTYPE_KEYS, `${subtype} has no name in the catalog`)
        .toContain(subtype.toLowerCase());
    }
  });

  it('shows an unknown subtype verbatim rather than blank', () => {
    expect(typeLabel('Projection')).toBe('Projection');
  });
});

// ── the same answers in another language ──────────────────────────────────

describe('in another language', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('de');
  });
  afterAll(async () => {
    await i18next.changeLanguage('en');
  });

  it('resolves the furniture from that language\u2019s catalog', () => {
    const labels = summaryLabels(['Text']) as Record<string, string>;
    expect(labels.title).toBe('Kommentarzusammenfassung');
    expect(labels.reconcileHeading).toBe('Abgleich');
  });

  it('keeps the placeholders the engine substitutes', () => {
    const labels = summaryLabels([]) as Record<string, string>;
    expect(labels.entryMeta).toContain('{{date}}');
    expect(labels.entryMeta).toContain('{{page}}');
    expect(labels.entryMeta).toContain('{{type}}');
  });
});

// ── what a finished run still owes the reader ─────────────────────────────
//
// The dialog is gone the moment the summary exists, so this decision is what
// stands between a summary that quietly left comments out and a reader who
// knows it did. It is a pure function for exactly that reason: there is no
// DOM here, and a guard that only exists inside a component is a guard no
// test can reach.

describe('summaryExclusions', () => {
  const clean: SummaryResult = {
    output: 'C:/out/summary.pdf',
    sheets: 4,
    found: 8,
    written: 8,
    excluded: { filtered: 0, unmodelled: 0, no_position: 0, body_refused: 0 },
    unreadable: [],
    no_box_pages: [],
    reconciles: true,
    marks: [],
  };

  it('says nothing when the run accounted for every comment', () => {
    expect(summaryExclusions(clean)).toBeNull();
  });

  it('owes the accounting when fewer were written than found', () => {
    const result = summaryExclusions({
      ...clean,
      written: 5,
      excluded: { ...clean.excluded, filtered: 2, unmodelled: 1 },
    });
    expect(result?.accounting).toBe(true);
  });

  it('shows the arithmetic when the numbers do not balance', () => {
    // Written matches found and the four numbers still do not add up: the
    // count alone would read as a complete run.
    const result = summaryExclusions({
      ...clean,
      excluded: { ...clean.excluded, filtered: 1 },
      reconciles: false,
    });
    expect(result?.accounting).toBe(true);
  });

  it('reports a comment written without a badge', () => {
    const result = summaryExclusions({
      ...clean,
      excluded: { ...clean.excluded, no_position: 2 },
    });
    expect(result?.noPosition).toBe(2);
    expect(result?.accounting).toBe(false);
  });

  it('reports a comment written without its text', () => {
    const result = summaryExclusions({
      ...clean,
      excluded: { ...clean.excluded, body_refused: 1 },
    });
    expect(result?.bodyRefused).toBe(1);
  });

  it('reports a page listed without its image', () => {
    expect(summaryExclusions({ ...clean, no_box_pages: [3, 7] })?.noBoxPages)
      .toEqual([3, 7]);
  });

  it('reports a page whose comment list could not be read', () => {
    expect(
      summaryExclusions({ ...clean, unreadable: [{ page: 2 }, { page: 9 }] })
        ?.unreadablePages,
    ).toEqual([2, 9]);
  });

  it('carries every warning of a run that went wrong in several ways at once', () => {
    const result = summaryExclusions({
      ...clean,
      written: 6,
      excluded: { filtered: 1, unmodelled: 1, no_position: 3, body_refused: 2 },
      unreadable: [{ page: 4 }],
      no_box_pages: [5],
    });
    expect(result).toEqual({
      accounting: true,
      noPosition: 3,
      bodyRefused: 2,
      noBoxPages: [5],
      unreadablePages: [4],
    });
  });
});
