// The accessibility report — the check-inventory mirror and the two emitters.
//
// The FIRST half is the parity gate. `engine/accessibility.py` is the
// authority on what the checker reports; the renderer keeps a mirror of that
// inventory because the mirror is what derives the catalog keys. A check the
// engine reports and the mirror omits would render nameless, and a detail key
// the engine emits with no catalog row would render as its own identifier —
// so both are read out of the engine's own source text and pinned in both
// directions.
//
// The SECOND half is the emitters. Both render one model, so the two formats
// can never disagree about a verdict: what is pinned is that the counts, the
// ordering and the not-applicable exclusion are the same in each, and that a
// document name carrying HTML metacharacters cannot escape the markup.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from '../src/renderer/i18n';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import {
  CATEGORY_IDS,
  CHECK_INVENTORY,
  VERDICT_GLYPH,
  escapeHtml,
  formatAccessibilityHtml,
  formatAccessibilityText,
  orderedCategories,
  reportFileName,
  type AccessibilityReport,
  type Category,
  type Check,
  type Finding,
  type Verdict,
} from '../src/renderer/lib/accessibility-report';

const ENGINE = readFileSync(
  resolve(__dirname, '../src/engine/accessibility.py'),
  'utf8',
);
const KEYS: Record<string, string> = PANEL_STRINGS;

// ── reading the engine's own source ───────────────────────────────────────

/** The `(id, category)` pairs of a Python tuple-of-tuples literal. */
function pairsOf(name: string): [string, string][] {
  const at = ENGINE.indexOf(`\n${name} = (`);
  expect(at, `${name} is not in the engine`).toBeGreaterThan(-1);
  const body = ENGINE.slice(at, ENGINE.indexOf('\n)', at));
  return [...body.matchAll(/\(\s*"([a-z_]+)",\s*"([a-z_]+)",?\s*\)/g)].map((m) => [m[1], m[2]]);
}

/** The bare strings of a Python tuple-of-strings literal. */
function stringsOf(name: string): string[] {
  const at = ENGINE.indexOf(`\n${name} = (`);
  expect(at, `${name} is not in the engine`).toBeGreaterThan(-1);
  const body = ENGINE.slice(at, ENGINE.indexOf('\n)', at));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Walk from just after an open bracket to its match, or to a comma at depth
 * zero — whichever comes first. Returns the index it stopped at. */
function argEnd(from: number): number {
  let depth = 0;
  for (let i = from; i < ENGINE.length; i += 1) {
    const c = ENGINE[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === ',' && depth === 0) return i;
  }
  return ENGINE.length;
}

/** Walk to the close paren that matches the one just before `from`. */
function callEnd(from: number): number {
  let depth = 0;
  for (let i = from; i < ENGINE.length; i += 1) {
    const c = ENGINE[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return ENGINE.length;
}

/**
 * Every `detail_key` the checker can emit, with the value names its localized
 * sentence may interpolate — read out of the `_finding(...)` calls themselves.
 *
 * The key is the SECOND argument and the first is always one of the three
 * address builders, so the scan walks brackets to find the boundary rather
 * than matching a shape. A conditional key (`"a" if … else "b"`) contributes
 * both of its ARMS and neither its condition — a string compared against
 * inside the condition is a verdict or a flag, never a detail key.
 */
/** The literal keys an argument can evaluate to: itself, or — when it is a
 * conditional — the value on each side of the `if … else`. */
function armsOf(text: string): string[] {
  const ifAt = text.search(/\bif\b/);
  if (ifAt < 0) return [...text.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const elseAt = text.search(/\belse\b/);
  const arms = [text.slice(0, ifAt), elseAt < 0 ? '' : text.slice(elseAt + 'else'.length)];
  return arms.flatMap((arm) => [...arm.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

/** The keys an argument that NAMES its value can evaluate to: every literal
 * assigned to that name inside the enclosing `def`. A detail key is always a
 * literal at its assignment, so the branches of an if/elif chain are the whole
 * set; without this a key bound to a local reads as dead in the catalog. */
function boundTo(name: string, at: number): string[] {
  const defAt = ENGINE.lastIndexOf('\ndef ', at);
  const body = ENGINE.slice(defAt < 0 ? 0 : defAt, at);
  const assign = new RegExp(`\\n\\s*${name}\\s*=\\s*"([a-z0-9_]+)"`, 'g');
  return [...body.matchAll(assign)].map((m) => m[1]);
}

function detailKeys(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const call = '_finding(';
  for (let at = ENGINE.indexOf(call); at >= 0; at = ENGINE.indexOf(call, at + 1)) {
    if (ENGINE.slice(Math.max(0, at - 4), at) === 'def ') continue;
    const firstEnd = argEnd(at + call.length);
    if (ENGINE[firstEnd] !== ',') continue;
    const secondEnd = argEnd(firstEnd + 1);
    const values = new Set<string>();
    const body = ENGINE.slice(at + call.length, callEnd(at + call.length));
    const dict = /values=\{([^{}]*)\}/.exec(body);
    if (dict) for (const m of dict[1].matchAll(/"([a-z0-9_]+)":/g)) values.add(m[1]);
    const arg = ENGINE.slice(firstEnd + 1, secondEnd);
    let keys = armsOf(arg);
    if (keys.length === 0 && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(arg)) {
      keys = boundTo(arg.trim(), at);
    }
    // A call site the scan reads no key out of is a silent hole: the catalog
    // row it needs would report as dead and the missing sentence as absent.
    expect(keys.length, `_finding at ${at} names no detail key`).toBeGreaterThan(0);
    for (const key of keys) {
      const seen = out.get(key);
      if (seen) for (const v of values) seen.add(v);
      else out.set(key, new Set(values));
    }
  }
  return out;
}

const CATALOG_PREFIXED = (prefix: string): string[] =>
  Object.keys(KEYS)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

describe('the check inventory mirrors the engine', () => {
  it('carries every check the engine reports, in the engine order', () => {
    expect(CHECK_INVENTORY.map((row) => [...row])).toEqual(pairsOf('CHECK_INVENTORY'));
  });

  it('carries the engine categories, in the engine order', () => {
    expect([...CATEGORY_IDS]).toEqual(stringsOf('CATEGORIES'));
  });

  it('partitions every check into a category the mirror has', () => {
    expect(CHECK_INVENTORY).toHaveLength(45);
    for (const [, category] of CHECK_INVENTORY) expect(CATEGORY_IDS).toContain(category);
  });
});

describe('every reported thing has a catalog row', () => {
  it('names and explains all 45 checks', () => {
    const ids = CHECK_INVENTORY.map(([id]) => id).sort();
    expect(CATALOG_PREFIXED('panel.a11y.check.').sort()).toEqual(ids);
    expect(CATALOG_PREFIXED('panel.a11y.explain.').sort()).toEqual(ids);
  });

  it('names every category', () => {
    expect(CATALOG_PREFIXED('panel.a11y.category.').sort()).toEqual([...CATEGORY_IDS].sort());
  });

  it('labels every verdict', () => {
    expect(CATALOG_PREFIXED('panel.a11y.verdict.').sort()).toEqual(
      Object.keys(VERDICT_GLYPH).sort(),
    );
  });

  it('has a sentence for every detail key the engine emits, and no dead ones', () => {
    const emitted = [...detailKeys().keys()].sort();
    // A scan that found nothing would pass the comparison below vacuously.
    expect(emitted.length).toBeGreaterThan(30);
    expect(CATALOG_PREFIXED('panel.a11y.detail.').sort()).toEqual(emitted);
  });

  it('interpolates only values the engine actually measures', () => {
    // Every placeholder in a detail sentence must be a name the engine puts in
    // that finding's `values`, or the sentence renders a raw `{{name}}`.
    const values = detailKeys();
    expect([...values.values()].filter((v) => v.size > 0).length).toBeGreaterThan(10);
    for (const [key, names] of values) {
      const sentence = KEYS[`panel.a11y.detail.${key}`];
      expect(sentence, key).toBeTruthy();
      for (const m of sentence.matchAll(/\{\{([a-zA-Z]+)\}\}/g)) {
        expect([...names], `${key} interpolates {{${m[1]}}}`).toContain(m[1]);
      }
    }
  });
});

// ── the emitters ──────────────────────────────────────────────────────────

const RUN_AT = new Date(2026, 7, 14, 21, 5, 30);

function check(
  id: string,
  category: string,
  status: Verdict,
  findings: Finding[] = [],
  counted = 1,
): Check {
  return { id, category, status, counted, findings };
}

const FIGURE: Finding = {
  address: { kind: 'struct', path: [0, 2], page: 1 },
  detail_key: 'figure_missing_alt',
  preview: '',
  rect: [40, 620, 160, 680],
  values: { role: 'Figure' },
};
const CONTENT: Finding = {
  address: { kind: 'content', page: 2, run: 5 },
  detail_key: 'content_not_tagged',
  preview: 'Draft — do not circulate',
  rect: [72, 700, 300, 712],
  values: { page: 2 },
};
const FIELD: Finding = {
  address: { kind: 'object', field: 'approval' },
  detail_key: 'field_has_no_description',
  preview: '',
  values: { type: 'signature' },
};

function category(id: string, checks: Check[]): Category {
  return {
    id,
    checks,
    passed: checks.filter((c) => c.status === 'pass').length,
    applicable: checks.filter((c) => c.status !== 'not_applicable').length,
  };
}

const REPORT: AccessibilityReport = {
  categories: [
    category('document', [
      check('permissions', 'document', 'pass'),
      check('lang', 'document', 'fail', [
        {
          address: { kind: 'object', page: null },
          detail_key: 'document_language_missing',
          preview: '',
        },
      ]),
    ]),
    category('page_content', [check('tagged_content', 'page_content', 'fail', [CONTENT], 40)]),
    category('forms', [check('field_descriptions', 'forms', 'fail', [FIELD], 3)]),
    category('alt_text', [check('figures_alt', 'alt_text', 'fail', [FIGURE], 1)]),
    category('tables', [
      check('table_rows', 'tables', 'not_applicable', [], 0),
      check('table_cells', 'tables', 'not_applicable', [], 0),
    ]),
    category('lists', [check('list_items', 'lists', 'pass')]),
    category('headings', [check('heading_nesting', 'headings', 'warn')]),
  ],
  summary: {
    passed: 2,
    failed: 4,
    warnings: 1,
    needs_review: 0,
    not_applicable: 2,
    applicable: 7,
    total: 9,
  },
  unreadable: [{ page: 3, stage: 'text', reason: 'content stream would not parse' }],
};

const RUN = { documentName: 'quarterly & <report>.pdf', runAt: RUN_AT, report: REPORT };

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterAll(async () => {
  await i18next.changeLanguage('en');
});

describe('the ordered model', () => {
  it('renders categories in inventory order however the engine emitted them', () => {
    const shuffled: AccessibilityReport = {
      ...REPORT,
      categories: [...REPORT.categories].reverse(),
    };
    expect(orderedCategories(shuffled).map((c) => c.id)).toEqual(
      orderedCategories(REPORT).map((c) => c.id),
    );
  });

  it('drops nothing while reordering', () => {
    const ids = orderedCategories(REPORT).flatMap((c) => c.checks.map((k) => k.id));
    expect(ids.sort()).toEqual(
      REPORT.categories.flatMap((c) => c.checks.map((k) => k.id)).sort(),
    );
  });
});

describe('the report file name', () => {
  it('is date-first so a folder sorts chronologically', () => {
    expect(reportFileName('quarterly-report.pdf', RUN_AT, 'html')).toBe(
      'quarterly-report-accessibility-20260814-2105.html',
    );
  });

  it('strips the characters a file name cannot carry', () => {
    expect(reportFileName('a/b:c*d.pdf', RUN_AT, 'txt')).toBe(
      'a_b_c_d-accessibility-20260814-2105.txt',
    );
  });
});

describe('both formats say the same thing', () => {
  const text = formatAccessibilityText(RUN);
  const html = formatAccessibilityHtml(RUN);

  it('names the document first', () => {
    expect(text.split('\n')[1]).toContain('quarterly & <report>.pdf');
  });

  it('carries every check id in both, in one order', () => {
    const ids = orderedCategories(REPORT).flatMap((c) => c.checks.map((k) => k.id));
    const inText = ids.filter((id) => text.includes(`(${id})`));
    const inHtml = ids.filter((id) => html.includes(`<code>${id}</code>`));
    expect(inText).toEqual(ids);
    expect(inHtml).toEqual(ids);
    // One order, not two: the ids appear in the same sequence in each.
    const order = (body: string, needle: (id: string) => string): number[] =>
      ids.map((id) => body.indexOf(needle(id)));
    const ascending = (xs: number[]): boolean => xs.every((v, i) => i === 0 || xs[i - 1] < v);
    expect(ascending(order(text, (id) => `(${id})`))).toBe(true);
    expect(ascending(order(html, (id) => `<code>${id}</code>`))).toBe(true);
  });

  it('prints the same summary line in each', () => {
    const line = text.split('\n')[4];
    expect(line).toContain('7 of 9');
    expect(html).toContain(escapeHtml(line));
  });

  it('counts a category as passed / applicable, never passed / total', () => {
    // Two table checks, both not applicable: the category says so instead of
    // claiming 0 of 2.
    expect(text).toContain('nothing to check');
    expect(html).toContain('nothing to check');
    expect(text).not.toContain('0 / 2');
  });

  it('keeps a not-applicable row out of the pass tally', () => {
    const applicable = REPORT.categories.reduce((n, c) => n + c.applicable, 0);
    expect(applicable).toBe(REPORT.summary.applicable);
    expect(REPORT.summary.passed + REPORT.summary.failed + REPORT.summary.warnings +
      REPORT.summary.needs_review).toBe(REPORT.summary.applicable);
  });

  it('interpolates a finding from its measured values, never a rendered sentence', () => {
    expect(text).toContain('Tag 0.2');
    expect(text).toContain('This Figure has neither alternate text nor actual text.');
    expect(text).toContain('Field “approval”');
    expect(text).toContain('This signature field has no description.');
    expect(html).toContain('This signature field has no description.');
  });

  it('names the pages it could not read', () => {
    expect(text).toContain('Page 3');
    expect(html).toContain('Page 3');
  });
});

describe('the HTML emitter', () => {
  it('escapes a document name carrying markup', () => {
    const html = formatAccessibilityHtml(RUN);
    expect(html).toContain('quarterly &amp; &lt;report&gt;.pdf');
    expect(html).not.toContain('<report>');
  });

  it('escapes a preview carrying markup', () => {
    const hostile: AccessibilityReport = {
      ...REPORT,
      categories: [
        category('page_content', [
          check('tagged_content', 'page_content', 'fail', [
            { ...CONTENT, preview: '"><script>alert(1)</script>' },
          ]),
        ]),
      ],
    };
    const html = formatAccessibilityHtml({ ...RUN, report: hostile });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is self-contained — no reference leaves the file', () => {
    const html = formatAccessibilityHtml(RUN);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it('declares the emitting locale and its direction', async () => {
    await i18next.changeLanguage('he');
    const rtl = formatAccessibilityHtml(RUN);
    expect(rtl).toContain('lang="he"');
    expect(rtl).toContain('dir="rtl"');
    await i18next.changeLanguage('en');
    expect(formatAccessibilityHtml(RUN)).toContain('dir="ltr"');
  });

  it('renders the report in the UI locale', async () => {
    const english = formatAccessibilityText(RUN);
    await i18next.changeLanguage('fr');
    const french = formatAccessibilityText(RUN);
    await i18next.changeLanguage('en');
    expect(french).not.toBe(english);
    // The ids are the shared vocabulary and stay identical in every locale.
    for (const [id] of CHECK_INVENTORY) {
      if (!english.includes(`(${id})`)) continue;
      expect(french).toContain(`(${id})`);
    }
  });
});

describe('escapeHtml', () => {
  it('covers text nodes and quoted attribute values with one pass', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so an entity is not double-built', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
