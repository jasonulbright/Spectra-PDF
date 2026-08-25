// The preflight report model and both emitters, and the panel-side profile
// model.
//
// Two things are pinned here that nothing else can pin: the check inventory
// mirror against the ENGINE's own list (read as source text, both directions —
// a check the engine reports and the panel cannot name would render nameless),
// and the escaping of an INK NAME, which is document content and reaches the
// report verbatim.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CATEGORY_IDS,
  CHECK_INVENTORY,
  DEFAULT_PROFILE_ID,
  FIXUP_IDS,
  PROFILE_SCHEMA,
  SHIPPED_PROFILE_IDS,
  deriveProfile,
  freeProfileId,
  isShippedProfileId,
  loadUserProfiles,
  paramKind,
  paramUnit,
  parseProfileFile,
  pickerOrder,
  profileFileName,
  profileSlug,
  profileToJson,
  removeProfile,
  storeProfile,
  type PreflightProfile,
} from '../src/renderer/lib/preflight-profile';
import {
  VERDICT_GLYPH,
  formatPreflightHtml,
  formatPreflightText,
  hiddenFindings,
  orderedCategories,
  paramsLine,
  type Check,
  type PreflightReport,
} from '../src/renderer/lib/preflight-report';

const ENGINE = resolve(__dirname, '../src/engine/preflight_profiles.py');

// No DOM test environment here, which is exactly why the store lives in the
// model and not in the component (the batch-OCR presets precedent).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

/** The engine module as source text, with line endings normalized — a
 * checkout may hold CRLF, and a block scan that ends on a bare `)` would then
 * run past the constant it was reading. */
function engineSource(): string {
  return readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
}

/** One parenthesised constant's body. The closing paren is the one at column
 * zero, so a nested `(…)` inside the block cannot end it early. */
function engineBlock(constant: string): string {
  const src = engineSource();
  const start = src.indexOf(`${constant} = (`);
  return src.slice(start, src.indexOf('\n)\n', start));
}

function engineInventory(): [string, string][] {
  return [
    ...engineBlock('CHECK_INVENTORY').matchAll(/\("([a-z0-9_]+)",\s*"([a-z_]+)"\)/g),
  ].map((m) => [m[1], m[2]] as [string, string]);
}

function tupleNames(constant: string): string[] {
  return [...engineBlock(constant).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function check(overrides: Partial<Check> = {}): Check {
  return {
    id: 'colour_family',
    category: 'colour',
    status: 'fail',
    severity: 'fail',
    counted: 3,
    params: { forbidden_families: ['DeviceRGB', 'CalRGB'] },
    findings: [],
    finding_count: 0,
    ...overrides,
  };
}

function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    profile: {
      id: 'sheetfed_offset',
      name: 'Sheetfed offset (CMYK)',
      name_key: 'profile.preflight.sheetfed_offset',
      based_on: '',
    },
    categories: [
      { id: 'colour', checks: [check()], passed: 0, applicable: 1 },
      { id: 'images', checks: [], passed: 0, applicable: 0 },
    ],
    summary: {
      passed: 10,
      failed: 3,
      warnings: 4,
      needs_review: 1,
      not_applicable: 19,
      applicable: 18,
      total: 37,
    },
    unreadable: [],
    images: 1,
    color_families: ['DeviceCMYK'],
    ...overrides,
  };
}

const RUN = { documentName: 'brochure.pdf', runAt: new Date(2026, 7, 15, 9, 30, 0) };

describe('the check inventory mirror', () => {
  it('matches the engine, in both directions and in order', () => {
    expect(CHECK_INVENTORY.map((r) => [r[0], r[1]])).toEqual(engineInventory());
  });

  it('names 38 checks across 7 categories', () => {
    expect(CHECK_INVENTORY).toHaveLength(38);
    expect(new Set(CHECK_INVENTORY.map((r) => r[1]))).toEqual(new Set(CATEGORY_IDS));
  });

  it('mirrors the engine’s category order', () => {
    expect(tupleNames('CATEGORIES')).toEqual([...CATEGORY_IDS]);
  });

  it('mirrors the engine’s fixup ids and shipped profile ids', () => {
    expect([...FIXUP_IDS]).toEqual(tupleNames('FIXUP_IDS'));
    const src = engineSource();
    expect(src).toContain(`DEFAULT_PROFILE_ID = "${DEFAULT_PROFILE_ID}"`);
    for (const id of SHIPPED_PROFILE_IDS) expect(src).toContain(`"${id}"`);
  });
});

describe('the report model', () => {
  it('orders categories and checks by the inventory, whatever the engine sent', () => {
    const scrambled = report({
      categories: [
        { id: 'images', checks: [], passed: 0, applicable: 0 },
        { id: 'colour', checks: [check()], passed: 0, applicable: 1 },
      ],
    });
    expect(orderedCategories(scrambled).map((c) => c.id)).toEqual(['colour', 'images']);
  });

  it('counts the findings a bounded list did not carry', () => {
    expect(hiddenFindings(check({ finding_count: 250, findings: [] }))).toBe(250);
    expect(hiddenFindings(check({ finding_count: 2, findings: [] }))).toBe(2);
  });

  it('renders the rule a row was measured against', () => {
    const line = paramsLine(
      check({ params: { min_dpi: 300, allow_landscape: true, allowed_names: [] } }),
    );
    expect(line).toContain('300 dpi');
    expect(line).toContain('yes');
    expect(line).toContain('any');
  });

  it('gives every verdict a glyph, and never the same one twice', () => {
    const glyphs = Object.values(VERDICT_GLYPH);
    expect(glyphs).toHaveLength(5);
    expect(new Set(glyphs).size).toBe(5);
  });
});

describe('both emitters render one model', () => {
  it('agrees about the counts', () => {
    const text = formatPreflightText({ ...RUN, report: report() });
    const html = formatPreflightHtml({ ...RUN, report: report() });
    for (const fragment of ['10', '3', '4', '1', '19', '18', '37']) {
      expect(text).toContain(fragment);
      expect(html).toContain(fragment);
    }
  });

  it('names the profile in both formats', () => {
    expect(formatPreflightText({ ...RUN, report: report() })).toContain('Sheetfed offset');
    expect(formatPreflightHtml({ ...RUN, report: report() })).toContain('Sheetfed offset');
  });

  it('carries every check id beside its name', () => {
    const text = formatPreflightText({ ...RUN, report: report() });
    const html = formatPreflightHtml({ ...RUN, report: report() });
    expect(text).toContain('colour_family');
    expect(html).toContain('colour_family');
  });

  it('carries the parameters identically in both formats', () => {
    const text = formatPreflightText({ ...RUN, report: report() });
    const html = formatPreflightHtml({ ...RUN, report: report() });
    expect(text).toContain('DeviceRGB, CalRGB');
    expect(html).toContain('DeviceRGB, CalRGB');
  });

  it('escapes a document name and an INK NAME in the HTML', () => {
    // An ink name is document content and reaches the report verbatim, so it
    // is the one string a hostile document controls end to end.
    const hostile = report({
      categories: [
        {
          id: 'colour',
          checks: [
            check({
              id: 'spot_ink_names',
              findings: [
                {
                  address: { kind: 'object', ink: '<script>&"x"' },
                  detail_key: 'spot_not_allowed',
                  preview: '<script>&"x"',
                  values: { name: '<script>&"x"' },
                },
              ],
              finding_count: 1,
            }),
          ],
          passed: 0,
          applicable: 1,
        },
      ],
    });
    const html = formatPreflightHtml({
      ...RUN,
      documentName: '<b>doc</b>.pdf',
      report: hostile,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;doc&lt;/b&gt;.pdf');
  });

  it('states the findings a bounded list left out, in both formats', () => {
    const bounded = report({
      categories: [
        {
          id: 'colour',
          checks: [check({ findings: [], finding_count: 900 })],
          passed: 0,
          applicable: 1,
        },
      ],
    });
    expect(formatPreflightText({ ...RUN, report: bounded })).toContain('900');
    expect(formatPreflightHtml({ ...RUN, report: bounded })).toContain('900');
  });

  it('marks a not-applicable row without counting it as a pass', () => {
    const na = report({
      categories: [
        {
          id: 'colour',
          checks: [check({ status: 'not_applicable' })],
          passed: 0,
          applicable: 0,
        },
      ],
    });
    expect(formatPreflightHtml({ ...RUN, report: na })).toContain('class="na"');
  });
});

describe('the profile model', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reserves the nine shipped ids', () => {
    for (const id of SHIPPED_PROFILE_IDS) expect(isShippedProfileId(id)).toBe(true);
    expect(isShippedProfileId('house_rule')).toBe(false);
  });

  it('never stores a profile claiming a shipped id', () => {
    const kept = storeProfile({
      schema: PROFILE_SCHEMA,
      id: 'sheetfed_offset',
      name: 'Mine',
      checks: {},
      fixups: [],
    });
    expect(kept).toEqual([]);
  });

  it('stores, replaces and removes a user profile', () => {
    const profile: PreflightProfile = {
      schema: PROFILE_SCHEMA,
      id: 'house',
      name: 'House rule',
      checks: {},
      fixups: [],
    };
    expect(storeProfile(profile)).toHaveLength(1);
    expect(storeProfile({ ...profile, name: 'House rule 2' })).toHaveLength(1);
    expect(loadUserProfiles()[0].name).toBe('House rule 2');
    expect(removeProfile('house')).toEqual([]);
  });

  it('survives a store that holds nonsense', () => {
    localStorage.setItem('spectra-preflight-profiles', 'not json at all');
    expect(loadUserProfiles()).toEqual([]);
  });

  it('derives a copy that records what it came from and never takes a used id', () => {
    const base: PreflightProfile = {
      schema: PROFILE_SCHEMA,
      id: 'sheetfed_offset',
      name: 'Sheetfed offset (CMYK)',
      checks: { ink_coverage_max: { max_tac_pct: 300 } },
      fixups: [{ id: 'fix_hairlines', params: {} }],
    };
    const first = deriveProfile(base, 'House rule', []);
    expect(first.id).toBe('house_rule');
    expect(first.based_on).toBe('sheetfed_offset');
    expect(first.checks).toEqual(base.checks);
    // A copy of a copy keeps the SHIPPED provenance, not the intermediate.
    expect(deriveProfile(first, 'Second', []).based_on).toBe('sheetfed_offset');
    expect(deriveProfile(base, 'House rule', ['house_rule']).id).toBe('house_rule_2');
  });

  it('never derives an id that collides with a shipped one', () => {
    expect(freeProfileId('Newsprint', [])).toBe('newsprint_2');
    expect(profileSlug('   ')).toBe('profile');
  });

  it('orders the picker: the shipped rules first, then the user’s by name', () => {
    const shipped = SHIPPED_PROFILE_IDS.map((id) => ({
      schema: PROFILE_SCHEMA,
      id,
      name: id,
      checks: {},
      fixups: [],
    }));
    const user = [
      { schema: PROFILE_SCHEMA, id: 'z', name: 'Zeta', checks: {}, fixups: [] },
      { schema: PROFILE_SCHEMA, id: 'a', name: 'Alpha', checks: {}, fixups: [] },
    ];
    expect(pickerOrder(shipped, user).map((p) => p.id)).toEqual([
      ...SHIPPED_PROFILE_IDS,
      'a',
      'z',
    ]);
  });

  it('reads a parameter’s control kind and its unit', () => {
    expect(paramKind(true)).toBe('boolean');
    expect(paramKind([])).toBe('list');
    expect(paramKind(300)).toBe('integer');
    expect(paramKind(0.25)).toBe('number');
    expect(paramKind('1.7')).toBe('text');
    expect(paramUnit('min_bleed_pt')).toBe('pt');
    expect(paramUnit('min_dpi')).toBe('dpi');
    expect(paramUnit('max_tac_pct')).toBe('pct');
    expect(paramUnit('max_version')).toBe('');
  });
});

describe('the profile file', () => {
  const profile: PreflightProfile = {
    schema: PROFILE_SCHEMA,
    id: 'house',
    name: 'House rule',
    based_on: 'sheetfed_offset',
    checks: { ink_coverage_max: { severity: 'warn', max_tac_pct: 280 } },
    fixups: [{ id: 'fix_hairlines', params: { replacement_pt: 0.3 } }],
  };

  it('exports the shape the import accepts — that is what makes it portable', () => {
    const parsed = parseProfileFile(profileToJson(profile));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.profile).toEqual(profile);
  });

  it('names the file after the profile, never after its id alone', () => {
    expect(profileFileName(profile)).toBe('House rule.json');
    expect(profileFileName({ ...profile, name: 'a/b:c' })).toBe('a_b_c.json');
  });

  it('refuses a file that is not JSON, and imports nothing', () => {
    const parsed = parseProfileFile('{not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.key).toBe('panel.preflight.import.notJson');
  });

  it('refuses another app’s file by naming what it holds', () => {
    const parsed = parseProfileFile(JSON.stringify({ kind: 'spectra-symbol-set' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.key).toBe('panel.preflight.import.wrongKind');
      expect(parsed.refusal.vars?.kind).toBe('spectra-symbol-set');
    }
  });

  it('refuses a schema it cannot read rather than reading it optimistically', () => {
    const parsed = parseProfileFile(JSON.stringify({ id: 'x', schema: 9 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.key).toBe('panel.preflight.import.wrongSchema');
  });

  it('refuses a profile with no id', () => {
    const parsed = parseProfileFile(JSON.stringify({ name: 'nameless' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.key).toBe('panel.preflight.import.noId');
  });

  it('refuses a file claiming a shipped id', () => {
    const parsed = parseProfileFile(JSON.stringify({ id: 'newsprint', name: 'Mine' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.key).toBe('panel.preflight.import.shippedId');
      expect(parsed.refusal.vars?.id).toBe('newsprint');
    }
  });

  it('reads a bare profile object as well as a wrapped one', () => {
    const parsed = parseProfileFile(JSON.stringify(profile));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.profile.id).toBe('house');
  });
});
