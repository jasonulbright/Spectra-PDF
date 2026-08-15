// The panel side of the preflight fixups — which kind a check's repair is,
// what an authored value becomes, and the mirror against the engine's own
// table.
//
// The mirror is what nothing else can pin: a fixup that is automatic in one
// half and authored in the other would give a row a button whose value the
// engine then refuses, and only reading the engine module as SOURCE TEXT
// catches it (the two are separate processes at run time).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTHORED_FIXUPS,
  CHECK_FIXUPS,
  TRAPPED_STATES,
  authoredFixProfile,
  autoFixCall,
  carriedFixups,
  draftKey,
  fixFor,
  fixableChecks,
  isFixableStatus,
  suggestionFor,
} from '../src/renderer/lib/preflight-fixes';
import type { Check } from '../src/renderer/lib/preflight-report';

const ENGINE = resolve(__dirname, '../src/engine/preflight_fixups.py');

function engineSource(): string {
  return readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
}

/** The engine's `CHECK_FIXUPS`, read as source text. The closing brace is the
 * one at column zero, so a nested `(…)` cannot end the block early. */
function engineCheckFixups(): Record<string, string[]> {
  const src = engineSource();
  const start = src.indexOf('CHECK_FIXUPS: dict[str, tuple] = {');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const out: Record<string, string[]> = {};
  for (const line of body.split('\n')) {
    const row = /^\s*"([a-z0-9_]+)":\s*\(([^)]*)\),?\s*$/.exec(line);
    if (!row) continue;
    out[row[1]] = [...row[2].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  }
  return out;
}

function engineTuple(constant: string): string[] {
  const src = engineSource();
  const start = src.indexOf(`${constant} = (`);
  const end = src.indexOf('\n)', start);
  return [...src.slice(start, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function check(overrides: Partial<Check> = {}): Check {
  return {
    id: 'trim_box',
    category: 'pages',
    status: 'fail',
    severity: 'fail',
    counted: 1,
    params: {},
    findings: [],
    finding_count: 0,
    ...overrides,
  } as Check;
}

const PROFILE = {
  fixups: [
    { id: 'set_trim_box', params: { from_box: 'crop' } },
    { id: 'grow_bleed_box', params: {} },
    { id: 'set_document_title', params: {} },
    { id: 'set_trapped', params: {} },
    { id: 'alias_spot', params: {} },
    { id: 'spots_to_process', params: {} },
  ] as { id: string; params: Record<string, unknown> }[],
};
const CARRIED = PROFILE.fixups.map((f) => f.id);

describe('the fixup mirror', () => {
  it('matches the engine’s check → fixups table, in both directions', () => {
    const engine = engineCheckFixups();
    expect(Object.keys(CHECK_FIXUPS).sort()).toEqual(Object.keys(engine).sort());
    for (const [id, fixups] of Object.entries(engine)) {
      expect([...(CHECK_FIXUPS[id] ?? [])]).toEqual(fixups);
    }
  });

  it('mirrors the engine’s authored set', () => {
    expect([...AUTHORED_FIXUPS]).toEqual(engineTuple('AUTHORED_FIXUPS'));
  });

  it('names 22 checks, and every fixup it names is in the engine’s order', () => {
    const order = engineTuple('FIXUP_ORDER');
    expect(Object.keys(CHECK_FIXUPS)).toHaveLength(22);
    for (const fixups of Object.values(CHECK_FIXUPS)) {
      for (const id of fixups) expect(order).toContain(id);
    }
  });
});

describe('what a row offers', () => {
  it('offers nothing on a verdict a door does not repair', () => {
    for (const status of ['pass', 'needs_review', 'not_applicable'] as const) {
      expect(isFixableStatus(status)).toBe(false);
      expect(fixFor(check({ status }), CARRIED)).toBeNull();
    }
  });

  it('offers nothing the profile does not carry', () => {
    // A button whose only outcome is "that profile has no fixup for this" is
    // worse than no button.
    expect(fixFor(check({ id: 'document_javascript' }), CARRIED)).toBeNull();
    expect(carriedFixups('document_javascript', CARRIED)).toEqual([]);
  });

  it('offers a button for an automatic fixup', () => {
    const offer = fixFor(check({ id: 'trim_box' }), CARRIED);
    expect(offer).toEqual({ kind: 'auto', fixups: ['set_trim_box'] });
  });

  it('offers a field for an authored one', () => {
    const offer = fixFor(check({ id: 'title_present', status: 'warn' }), CARRIED);
    expect(offer?.kind).toBe('authored');
    expect(offer?.authored?.param).toBe('title');
    expect(offer?.authored?.scope).toBe('check');
  });

  it('prefers the automatic door where a check carries both', () => {
    // `spot_ink_names` offers an ink alias and a whole-set conversion;
    // converting is the answer that needs nothing typed.
    const offer = fixFor(check({ id: 'spot_ink_names' }), CARRIED);
    expect(offer).toEqual({ kind: 'auto', fixups: ['spots_to_process'] });
  });

  it('falls to the per-finding alias when only that is carried', () => {
    const offer = fixFor(check({ id: 'spot_ink_names' }), ['alias_spot']);
    expect(offer?.kind).toBe('authored');
    expect(offer?.authored?.scope).toBe('finding');
  });
});

describe('what "fix what this profile can" would run', () => {
  it('names only the automatic rows', () => {
    const checks = [
      check({ id: 'trim_box', status: 'fail' }),
      check({ id: 'title_present', status: 'fail' }),
      check({ id: 'page_count', status: 'fail' }),
      check({ id: 'trim_box', status: 'pass' }),
    ];
    expect(fixableChecks(checks, CARRIED)).toEqual(['trim_box']);
  });

  it('sends CHECK ids, never a sequence of its own', () => {
    // The engine resolves a check to its doors and applies them in its own
    // canonical order; a panel that stated a sequence would be a second answer.
    expect(autoFixCall('sheetfed_offset', ['trim_box', 'xmp_present'])).toEqual({
      method: 'apply_preflight_fixups',
      params: { profile: 'sheetfed_offset', checks: ['trim_box', 'xmp_present'] },
    });
    expect(autoFixCall('sheetfed_offset', [])).toBeNull();
  });
});

describe('an authored value', () => {
  const authored = (id: string) => fixFor(check({ id, status: 'fail' }), CARRIED)!.authored!;

  it('travels as a parameter of the profile’s own fixup entry', () => {
    const patched = authoredFixProfile(PROFILE, authored('title_present'), ' Spring ');
    expect(patched?.checks).toEqual(['set_document_title']);
    const entry = (patched?.profile as typeof PROFILE).fixups.find(
      (f) => f.id === 'set_document_title',
    );
    expect(entry?.params).toEqual({ title: 'Spring' });
  });

  it('leaves every other fixup entry untouched', () => {
    const patched = authoredFixProfile(PROFILE, authored('title_present'), 'x');
    const trim = (patched?.profile as typeof PROFILE).fixups.find(
      (f) => f.id === 'set_trim_box',
    );
    expect(trim?.params).toEqual({ from_box: 'crop' });
  });

  it('refuses an empty value rather than writing one a machine invented', () => {
    expect(authoredFixProfile(PROFILE, authored('title_present'), '   ')).toBeNull();
  });

  it('types a number and refuses one that is not positive', () => {
    const bleed = authored('bleed_sufficient');
    const patched = authoredFixProfile(PROFILE, bleed, '8.5');
    const entry = (patched?.profile as typeof PROFILE).fixups.find(
      (f) => f.id === 'grow_bleed_box',
    );
    expect(entry?.params).toEqual({ bleed_pt: 8.5 });
    expect(authoredFixProfile(PROFILE, bleed, '0')).toBeNull();
    expect(authoredFixProfile(PROFILE, bleed, 'wide')).toBeNull();
  });

  it('accepts only the three trapping states', () => {
    const trapped = authored('trapped_declared');
    for (const state of TRAPPED_STATES) {
      expect(authoredFixProfile(PROFILE, trapped, state)).not.toBeNull();
    }
    expect(authoredFixProfile(PROFILE, trapped, 'maybe')).toBeNull();
  });

  it('carries the finding’s own ink as the alias source', () => {
    const alias = fixFor(check({ id: 'spot_ink_names' }), ['alias_spot'])!.authored!;
    const patched = authoredFixProfile({ fixups: [{ id: 'alias_spot', params: {} }] },
      alias, 'PANTONE 185 C', { source: 'HouseGreen' });
    const entry = (patched?.profile as typeof PROFILE).fixups[0];
    expect(entry.params).toEqual({ source: 'HouseGreen', target: 'PANTONE 185 C' });
  });
});

describe('the editors', () => {
  it('keys one editor per check, and one per finding where the fixup is', () => {
    expect(draftKey('title_present', null)).toBe('fix:title_present');
    expect(draftKey('spot_ink_names', 2)).toBe('fix:spot_ink_names:2');
    expect(draftKey('spot_ink_names', 2)).not.toBe(draftKey('spot_ink_names', 3));
  });

  it('starts a bleed editor at the rule the row was measured against', () => {
    expect(suggestionFor(check({ id: 'bleed_sufficient', params: { min_bleed_pt: 8.5 } })))
      .toBe('8.5');
  });

  it('starts a title editor empty — that value is never invented', () => {
    expect(suggestionFor(check({ id: 'title_present' }))).toBe('');
  });
});
