import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_KIND_LABEL,
  ACTION_TRIGGERS,
  ACTION_TRIGGER_LABEL,
  AUTHORED_KINDS,
  authoredActions,
  defaultAction,
  isRunnable,
  narrowAction,
  narrowActions,
  toEngineAction,
  unauthorableTriggers,
  type ActionTrigger,
  type AuthoredAction,
  type WidgetAction,
} from '../src/renderer/lib/field-actions';

// The renderer half of the data-action pin. The SAME JSON file drives
// tests/test_field_data_actions.py: the engine classifies what a document
// carries and this side narrows it, so a wire key spelled one way at the
// engine and another here is a button that silently does nothing.
interface DataActionCase {
  name: string;
  authored: Record<string, unknown>[];
  read?: Record<string, unknown>;
  refuses?: string;
  problems?: string[];
}

const CORPUS = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'field-spec-corpus.json'), 'utf8'),
) as { data_action_cases: DataActionCase[] };

// The refusing rows are asserted by the ENGINE half alone, deliberately.
// Unlike field CREATION — a genuine twin, where both writers validate and each
// maps the corpus condition into its own vocabulary — the data-action door has
// one implementation. A second validator here would be a second answer waiting
// to drift, and the engine's own English passes through the bridge verbatim,
// which is the treatment every composed authoring problem already gets.

describe('the data-action corpus', () => {
  for (const dataCase of CORPUS.data_action_cases) {
    if (dataCase.refuses) continue;
    it(`${dataCase.name} — the properties editor round-trips it`, () => {
      // The inverse the properties editor rests on: a field opened and applied
      // UNCHANGED must rewrite exactly what it already had. Narrow what the
      // engine read back, take the authorable actions, re-serialize — and the
      // result is the list that was authored, member for member.
      const narrowed = narrowActions(dataCase.read);
      const round = authoredActions(narrowed).map(toEngineAction);
      expect(round).toEqual(dataCase.authored);
    });
  }

  it('covers every kind, every trigger and both outcomes', () => {
    const rows = CORPUS.data_action_cases;
    const kinds = new Set<string>();
    const triggers = new Set<string>();
    for (const row of rows) {
      if (row.refuses) continue;
      for (const action of row.authored) {
        kinds.add(String(action.kind));
        triggers.add(String(action.trigger));
      }
    }
    expect([...kinds].sort()).toEqual([...AUTHORED_KINDS].sort());
    expect([...triggers].sort()).toEqual([...ACTION_TRIGGERS].sort());
    expect(new Set(rows.map((r) => Boolean(r.refuses)))).toEqual(new Set([true, false]));
  });

  it('never narrows a refusing row into something the editor would offer', () => {
    // A row the engine refuses must not read back as a valid action here
    // either: the editor is seeded from what the document carries, and a
    // document cannot carry one of these.
    for (const row of CORPUS.data_action_cases) {
      if (!row.refuses) continue;
      expect(row.read).toBeUndefined();
    }
  });
});

describe('narrowing what the engine reports', () => {
  it('drops a kind this build does not know rather than guessing at it', () => {
    expect(narrowAction({ kind: 'sound', file: 'x.wav' })).toBeNull();
    expect(narrowAction(null)).toBeNull();
    expect(narrowAction({})).toBeNull();
  });

  it('drops an unknown trigger from the map', () => {
    const map = narrowActions({
      A: { kind: 'uri', uri: 'https://example.invalid/a' },
      PO: { kind: 'uri', uri: 'https://example.invalid/po' },
    });
    expect(Object.keys(map)).toEqual(['A']);
  });

  it('reads a hide with no /H as a HIDE, which is what the format defaults', () => {
    expect(narrowAction({ kind: 'hide', targets: ['a'] })).toEqual({
      kind: 'hide',
      targets: ['a'],
      hide: true,
    });
    expect(narrowAction({ kind: 'hide', targets: ['a'], hide: false })).toEqual({
      kind: 'hide',
      targets: ['a'],
      hide: false,
    });
  });

  it('falls back to FDF for a submission format it does not know', () => {
    const action = narrowAction({ kind: 'submit', url: 'u', format: 'csv' });
    expect(action).toMatchObject({ kind: 'submit', format: 'fdf', method: 'post' });
  });

  it('reads an empty field list as no scope, which is every field', () => {
    expect(narrowAction({ kind: 'reset', fields: [], exclude: false })).toEqual({
      kind: 'reset',
      fields: null,
      exclude: false,
    });
  });
});

describe('what runs and what is reported', () => {
  const RUNS: WidgetAction[] = [
    { kind: 'goto', page: 2 },
    { kind: 'uri', uri: 'https://example.invalid/x' },
    { kind: 'reset', fields: null, exclude: false },
    { kind: 'hide', targets: ['a'], hide: true },
    { kind: 'import', file: 'd.fdf' },
    {
      kind: 'submit',
      url: 'https://example.invalid/x',
      format: 'fdf',
      method: 'post',
      fields: null,
      exclude: false,
      includeEmpty: false,
    },
  ];
  const REPORTS: WidgetAction[] = [
    { kind: 'javascript' },
    { kind: 'named', name: 'NextPage' },
    { kind: 'remote', file: 'other.pdf' },
    { kind: 'other', action: 'Movie' },
  ];

  it.each(RUNS)('$kind runs', (action) => {
    expect(isRunnable(action)).toBe(true);
  });

  it.each(REPORTS)('$kind is reported, not run', (action) => {
    expect(isRunnable(action)).toBe(false);
  });

  it('a go-to whose destination resolves to nothing does not run', () => {
    expect(isRunnable({ kind: 'goto', page: null })).toBe(false);
  });
});

describe('the authoring inverse', () => {
  it('drops a kind this app does not write and reports the trigger it was on', () => {
    const map: Partial<Record<ActionTrigger, WidgetAction>> = {
      A: { kind: 'goto', page: 1 },
      U: { kind: 'javascript' },
      E: { kind: 'named', name: 'NextPage' },
    };
    expect(authoredActions(map).map((a) => a.trigger)).toEqual(['A']);
    expect(unauthorableTriggers(map)).toEqual(['U', 'E']);
  });

  it('refuses to author a go-to whose destination resolves to nothing', () => {
    // Writing it back would have to invent a page the author never named.
    expect(authoredActions({ A: { kind: 'goto', page: null } })).toEqual([]);
    expect(unauthorableTriggers({ A: { kind: 'goto', page: null } })).toEqual([]);
  });

  it('gives a fresh action only the members its kind carries', () => {
    for (const kind of AUTHORED_KINDS) {
      const action = defaultAction(kind, 'A');
      expect(action.kind).toBe(kind);
      expect(action.trigger).toBe('A');
      // The serialized form is what the engine validates, so it must never
      // carry a member left behind by the kind the editor switched away from.
      expect(Object.keys(toEngineAction(action)).sort()).toEqual(
        Object.keys(toEngineAction(defaultAction(kind, 'A'))).sort(),
      );
    }
  });

  it('serializes the engine key spelling, not the renderer one', () => {
    const submit: AuthoredAction = {
      kind: 'submit',
      trigger: 'A',
      url: 'https://example.invalid/x',
      format: 'xfdf',
      method: 'get',
      fields: ['A'],
      exclude: true,
      includeEmpty: true,
    };
    expect(toEngineAction(submit)).toEqual({
      trigger: 'A',
      kind: 'submit',
      url: 'https://example.invalid/x',
      format: 'xfdf',
      method: 'get',
      fields: ['A'],
      exclude: true,
      include_empty: true,
    });
  });
});

describe('the label tables', () => {
  it('name every kind and every trigger, with no key used twice', () => {
    const kindKeys = Object.values(ACTION_KIND_LABEL);
    const triggerKeys = Object.values(ACTION_TRIGGER_LABEL);
    expect(new Set(kindKeys).size).toBe(kindKeys.length);
    expect(new Set(triggerKeys).size).toBe(triggerKeys.length);
    expect(Object.keys(ACTION_TRIGGER_LABEL).sort()).toEqual([...ACTION_TRIGGERS].sort());
  });
});
