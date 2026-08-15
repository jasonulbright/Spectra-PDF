// The fix surface — what the report offers, and where the value goes.
//
// The engine owns WHICH checks have an automatic fix (`AUTOMATIC_CHECKS`) and
// which take an authored value (`AUTHORED_CHECKS`); the renderer keeps a
// mirror because it is what decides whether a row draws a button or a field.
// A check that is automatic in one and authored in the other would offer a
// control whose door refuses it, so both lists are read out of the engine's
// own source text and pinned in both directions — the same shape
// `accessibility-report.test.ts` uses for the check inventory itself.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from '../src/renderer/i18n';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import {
  AUTHORED_CHECKS,
  AUTOMATIC_CHECKS,
  authoredCall,
  draftKey,
  fixFor,
  isFixableStatus,
  suggestionFor,
} from '../src/renderer/lib/a11y-fixes';
import { CHECK_INVENTORY, type Check, type Finding } from '../src/renderer/lib/accessibility-report';

const ENGINE = readFileSync(
  resolve(__dirname, '../src/engine/accessibility_fixes.py'),
  'utf8',
);

/** A python tuple-of-strings constant, read out of the engine module. */
function pythonTuple(name: string): string[] {
  const match = ENGINE.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'));
  if (!match) throw new Error(`no ${name} in accessibility_fixes.py`);
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function check(id: string, status: Check['status'], extra: Partial<Check> = {}): Check {
  const category = CHECK_INVENTORY.find(([c]) => c === id)?.[1] ?? 'document';
  return { id, category, status, counted: 1, findings: [], ...extra };
}

function finding(address: Finding['address']): Finding {
  return { address, detail_key: 'x', preview: '' };
}

describe('the engine and the panel agree about which fixes exist', () => {
  it('mirrors AUTOMATIC_CHECKS', () => {
    const engine = pythonTuple('AUTOMATIC_CHECKS');
    expect(engine.length).toBeGreaterThan(0);
    expect([...AUTOMATIC_CHECKS].sort()).toEqual([...engine].sort());
  });

  it('mirrors AUTHORED_CHECKS', () => {
    const engine = pythonTuple('AUTHORED_CHECKS');
    expect([...AUTHORED_CHECKS].sort()).toEqual([...engine].sort());
  });

  it('every check the engine can fix automatically has a door in its table', () => {
    const engine = pythonTuple('AUTOMATIC_CHECKS');
    // The door table is keyed by the same ids, in both directions: an
    // automatic check with no door refuses everything the panel offers, and a
    // door with no check is a repair nothing can reach.
    const doors = [
      ...ENGINE.matchAll(/^ {4}"([a-z_]+)": (?:_fix_[a-z_]+|_clear_alt|_tag_annotations)/gm),
    ].map((m) => m[1]);
    expect(doors.sort()).toEqual([...engine].sort());
  });

  it('every fixable check is a real check', () => {
    const ids = new Set(CHECK_INVENTORY.map(([id]) => id));
    for (const id of [...AUTOMATIC_CHECKS, ...AUTHORED_CHECKS]) expect(ids).toContain(id);
  });
});

describe('what a row offers', () => {
  it('offers nothing on a verdict a fix does not apply to', () => {
    for (const status of ['pass', 'needs_review', 'not_applicable'] as const) {
      expect(isFixableStatus(status)).toBe(false);
      expect(fixFor(check('tab_order', status))).toBeNull();
    }
  });

  it('offers the automatic button on a failing automatic check', () => {
    expect(fixFor(check('tab_order', 'fail'))).toEqual({ kind: 'auto' });
    expect(fixFor(check('heading_nesting', 'fail'))).toEqual({ kind: 'auto' });
  });

  it('offers a field on an authored check', () => {
    const offer = fixFor(check('figures_alt', 'fail'));
    expect(offer?.kind).toBe('authored');
    expect(offer?.authored).toEqual({ input: 'text', scope: 'finding', field: 'alt' });
    expect(fixFor(check('lang', 'fail'))?.authored).toEqual({
      input: 'language',
      scope: 'check',
      field: 'lang',
    });
  });

  it('splits `title` on the verdict, exactly as the engine door does', () => {
    // A title that is merely not SHOWN needs no value from anyone.
    expect(fixFor(check('title', 'warn'))).toEqual({ kind: 'auto' });
    // A missing title needs the one thing a machine must not invent.
    expect(fixFor(check('title', 'fail'))?.kind).toBe('authored');
  });

  it('offers deriving bookmarks only where there are headings to derive from', () => {
    expect(fixFor(check('bookmarks', 'warn', { data: { headings: 0 } }))).toBeNull();
    expect(fixFor(check('bookmarks', 'warn', { data: {} }))).toBeNull();
    expect(fixFor(check('bookmarks', 'warn', { data: { headings: 4 } }))).toEqual({
      kind: 'auto',
    });
  });

  it('offers nothing for a check that only routes', () => {
    for (const id of ['reading_order', 'contrast', 'table_regularity', 'list_items']) {
      expect(fixFor(check(id, 'fail'))).toBeNull();
    }
  });
});

describe('where an authored value goes', () => {
  it('routes each authored check to its own door', () => {
    expect(authoredCall('lang', null, ' en-GB ', true)).toEqual({
      method: 'set_document_language',
      params: { lang: 'en-GB', allow_signed: true },
    });
    expect(authoredCall('title', null, 'Quarterly report', false)).toEqual({
      method: 'set_document_title',
      params: { title: 'Quarterly report', display: true, allow_signed: false },
    });
    expect(
      authoredCall('field_descriptions', finding({ kind: 'object', field: 'approval' }), 'Sign here', true),
    ).toEqual({
      method: 'set_field_description',
      params: { field: 'approval', description: 'Sign here', allow_signed: true },
    });
    expect(authoredCall('figures_alt', finding({ kind: 'struct', path: [0, 2] }), 'A chart', true)).toEqual({
      method: 'set_struct_props',
      params: { path: [0, 2], props: { alt: 'A chart' } },
    });
    expect(authoredCall('table_summary', finding({ kind: 'struct', path: [0, 1] }), 'Revenue', true)).toEqual({
      method: 'set_struct_props',
      params: { path: [0, 1], props: { summary: 'Revenue' } },
    });
  });

  it('refuses an empty value rather than writing one', () => {
    expect(authoredCall('lang', null, '   ', true)).toBeNull();
    expect(authoredCall('figures_alt', finding({ kind: 'struct', path: [0] }), '', true)).toBeNull();
  });

  it('refuses a finding whose address cannot carry the value', () => {
    // A figure finding with no path, and a field finding with no field name:
    // both are addresses the report no longer resolves, and retargeting them
    // silently is the failure the stale-path rule exists to prevent.
    expect(authoredCall('figures_alt', finding({ kind: 'struct' }), 'A chart', true)).toBeNull();
    expect(authoredCall('field_descriptions', finding({ kind: 'object' }), 'Sign', true)).toBeNull();
    expect(authoredCall('figures_alt', null, 'A chart', true)).toBeNull();
  });

  it('has no door for a check that routes', () => {
    expect(authoredCall('contrast', null, 'anything', true)).toBeNull();
  });

  it('never passes allow_signed to a door that does not declare it', () => {
    const call = authoredCall('figures_alt', finding({ kind: 'struct', path: [1] }), 'x', true);
    expect(call?.params).not.toHaveProperty('allow_signed');
  });
});

describe('the editors', () => {
  it('keys a check-scope editor apart from its findings', () => {
    expect(draftKey('lang', null)).toBe('lang');
    expect(draftKey('figures_alt', 0)).toBe('figures_alt:0');
    expect(draftKey('figures_alt', 1)).not.toBe(draftKey('figures_alt', 0));
  });

  it("suggests a field's own name and nothing else", () => {
    expect(suggestionFor('field_descriptions', finding({ kind: 'object', field: 'Text1' }))).toBe(
      'Text1',
    );
    // A suggestion is a PLACEHOLDER at the surface: nothing here writes it.
    expect(suggestionFor('figures_alt', finding({ kind: 'struct', path: [0] }))).toBe('');
    expect(suggestionFor('field_descriptions', null)).toBe('');
  });
});

describe('the fix surface is fully localized', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
  });
  afterAll(async () => {
    await i18next.changeLanguage('en');
  });

  it('has a label and a hint for every authored field', () => {
    const fields = new Set<string>();
    for (const id of AUTHORED_CHECKS) {
      const offer = fixFor(check(id, 'fail'));
      if (offer?.authored) fields.add(offer.authored.field);
    }
    // `title` reaches its authored arm on a fail, which the loop above uses.
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) {
      expect(PANEL_STRINGS, `panel.a11y.field.${field}`).toHaveProperty(
        `panel.a11y.field.${field}`,
      );
      expect(PANEL_STRINGS, `panel.a11y.hint.${field}`).toHaveProperty(
        `panel.a11y.hint.${field}`,
      );
    }
  });

  it('has the chrome the controls need', () => {
    for (const key of [
      'panel.a11y.fix',
      'panel.a11y.fixTitle',
      'panel.a11y.fixing',
      'panel.a11y.fixed',
      'panel.a11y.apply',
      'panel.a11y.needsValue',
      'panel.a11y.langPick',
    ]) {
      expect(PANEL_STRINGS).toHaveProperty(key);
    }
  });
});
