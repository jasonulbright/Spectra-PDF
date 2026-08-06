import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAPPED,
  TRAPPED_VALUES,
  coerceField,
  freshPreset,
  isTrappedValue,
  orderedAssignments,
  rangeProblem,
  uncoveredPages,
  type TrapAssignment,
  type TrapVocabulary,
} from '../src/renderer/lib/trap-presets';

const VOCABULARY: TrapVocabulary = {
  fields: [
    { name: 'TrapWidth', type: 'number', default: 1.0, min: 0, max: 100 },
    { name: 'Enabled', type: 'boolean', default: true },
    { name: 'ImageResolution', type: 'integer', default: 1, min: 1, max: 10000 },
    { name: 'TrapSetName', type: 'text', default: null },
    {
      name: 'ImageTrapPlacement', type: 'choice', default: 'Center',
      choices: ['Center', 'Choke', 'Neutral', 'Spread'],
    },
    { name: 'ColorantZoneDetails', type: 'colorants', default: {} },
  ],
  trapped_values: ['True', 'False', 'Unknown'],
  default_trapped: 'Unknown',
  colorant_fields: ['TrapWidth'],
};

function assignment(first: number, last: number, name = 'Press'): TrapAssignment {
  return { first, last, name, preset: {} };
}

describe('trap preset vocabulary', () => {
  it('starts a preset at the engine’s own initial values', () => {
    expect(freshPreset(VOCABULARY)).toEqual({
      TrapWidth: 1.0,
      Enabled: true,
      ImageResolution: 1,
      TrapSetName: null,
      ImageTrapPlacement: 'Center',
      ColorantZoneDetails: {},
    });
  });

  it('has no fields at all before the vocabulary arrives', () => {
    expect(freshPreset(null)).toEqual({});
  });

  it('coerces a typed value to what its field accepts', () => {
    const width = VOCABULARY.fields[0];
    expect(coerceField(width, '2.5')).toBe(2.5);
    expect(coerceField(VOCABULARY.fields[1], true)).toBe(true);
    expect(coerceField(VOCABULARY.fields[3], '')).toBeNull();
    expect(coerceField(VOCABULARY.fields[3], 'Press A')).toBe('Press A');
  });

  it('leaves an unparseable number as typed, so the refusal names it', () => {
    expect(coerceField(VOCABULARY.fields[0], 'wide')).toBe('wide');
  });
});

describe('trapped declaration', () => {
  it('accepts only the three values PDF/X allows', () => {
    for (const value of TRAPPED_VALUES) expect(isTrappedValue(value)).toBe(true);
    expect(isTrappedValue('Maybe')).toBe(false);
  });

  it('defaults to the unasserted value', () => {
    expect(DEFAULT_TRAPPED).toBe('Unknown');
  });
});

describe('page ranges', () => {
  it('accepts a range inside the document', () => {
    expect(rangeProblem(1, 3, 5)).toBeNull();
  });

  it('rejects a range that runs past the last page', () => {
    expect(rangeProblem(4, 9, 5)).toBe('outside');
    expect(rangeProblem(0, 2, 5)).toBe('outside');
  });

  it('rejects a range whose end precedes its start', () => {
    expect(rangeProblem(4, 2, 5)).toBe('inverted');
  });

  it('rejects a range that is not two whole numbers', () => {
    expect(rangeProblem(Number.NaN, 2, 5)).toBe('notANumber');
    expect(rangeProblem(1.5, 2, 5)).toBe('notANumber');
  });

  it('rejects a range another preset already covers', () => {
    const existing = [assignment(2, 4)];
    expect(rangeProblem(3, 5, 8, existing)).toBe('overlap');
    expect(rangeProblem(5, 6, 8, existing)).toBeNull();
  });

  it('lets an assignment being edited overlap its own former range', () => {
    const existing = [assignment(2, 4), assignment(6, 7)];
    expect(rangeProblem(2, 5, 8, existing, 0)).toBeNull();
    expect(rangeProblem(2, 6, 8, existing, 0)).toBe('overlap');
  });

  it('does not police the page count when the document has not reported one', () => {
    expect(rangeProblem(1, 99, 0)).toBeNull();
  });
});

describe('assignment listing', () => {
  it('orders assignments by the page they start on', () => {
    const ordered = orderedAssignments([assignment(5, 6, 'B'), assignment(1, 2, 'A')]);
    expect(ordered.map((a) => a.name)).toEqual(['A', 'B']);
  });

  it('names the pages no preset covers', () => {
    expect(uncoveredPages([assignment(1, 2), assignment(5, 5)], 6)).toEqual([3, 4, 6]);
  });

  it('reports nothing uncovered when the ranges span the document', () => {
    expect(uncoveredPages([assignment(1, 6)], 6)).toEqual([]);
  });

  it('ignores the part of a range that falls outside the document', () => {
    expect(uncoveredPages([assignment(1, 99)], 3)).toEqual([]);
  });
});
