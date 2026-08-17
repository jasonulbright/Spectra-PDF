// The new-field card's writing mode: what reaches the spec, what a kind that
// draws a mark is allowed to carry, and which engine calls a created batch
// still owes.
import { describe, expect, it } from 'vitest';
import {
  FIELD_SCRIPTS,
  effectiveFieldWriting,
  fieldWritingParams,
  verticalFontCalls,
  writesTextRun,
} from '../src/renderer/lib/form-writing';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';

const RECT: [number, number, number, number] = [10, 10, 110, 40];

function spec(over: Partial<NewFieldSpec> & { name: string }): NewFieldSpec {
  return { type: 'text', pageIndex: 0, rect: RECT, ...over };
}

describe('writesTextRun', () => {
  it('is true for exactly the kinds that draw their value as text', () => {
    expect(writesTextRun('text')).toBe(true);
    expect(writesTextRun('dropdown')).toBe(true);
    expect(writesTextRun('optionlist')).toBe(true);
  });

  it('is false for the kinds that draw a mark or nothing', () => {
    // A checkbox and a radio button draw a ZapfDingbats mark; a signature
    // field draws no value at all. The engine's own list, mirrored.
    expect(writesTextRun('checkbox')).toBe(false);
    expect(writesTextRun('radio')).toBe(false);
    expect(writesTextRun('signature')).toBe(false);
  });
});

describe('effectiveFieldWriting', () => {
  it('keeps a text-run kind on the mode that was chosen', () => {
    expect(effectiveFieldWriting('text', 'vertical')).toBe('vertical');
    expect(effectiveFieldWriting('dropdown', 'vertical')).toBe('vertical');
    expect(effectiveFieldWriting('optionlist', 'vertical')).toBe('vertical');
    expect(effectiveFieldWriting('text', 'horizontal')).toBe('horizontal');
  });

  it('resolves a mark-drawing kind back to horizontal', () => {
    // The control is off screen for these kinds, so a mode left behind by a
    // kind switch must not reach the write as a refusal.
    expect(effectiveFieldWriting('checkbox', 'vertical')).toBe('horizontal');
    expect(effectiveFieldWriting('radio', 'vertical')).toBe('horizontal');
    expect(effectiveFieldWriting('signature', 'vertical')).toBe('horizontal');
  });
});

describe('fieldWritingParams', () => {
  it('contributes NOTHING for a horizontal field', () => {
    // The byte-identity pin: a horizontal field's spec carries no writing key
    // at all, so it is key for key the spec written before this existed.
    expect(fieldWritingParams('text', 'horizontal', 'japanese')).toEqual({});
    expect(Object.keys(fieldWritingParams('text', 'horizontal', 'japanese'))).toHaveLength(0);
    expect('writingMode' in fieldWritingParams('text', 'horizontal', 'japanese')).toBe(false);
    expect('script' in fieldWritingParams('text', 'horizontal', 'japanese')).toBe(false);
  });

  it('contributes the mode AND the script for a vertical field', () => {
    expect(fieldWritingParams('text', 'vertical', 'japanese')).toEqual({
      writingMode: 'vertical',
      script: 'japanese',
    });
  });

  it('carries the script that was chosen, not a fixed one', () => {
    // Mutation proof: each script travels distinctly.
    for (const script of FIELD_SCRIPTS) {
      expect(fieldWritingParams('optionlist', 'vertical', script)).toEqual({
        writingMode: 'vertical',
        script,
      });
    }
    expect(fieldWritingParams('text', 'vertical', 'korean').script).toBe('korean');
    expect(fieldWritingParams('text', 'vertical', 'simplified-chinese').script).toBe(
      'simplified-chinese',
    );
    expect(fieldWritingParams('text', 'vertical', 'traditional-chinese').script).toBe(
      'traditional-chinese',
    );
  });

  it('contributes nothing for a mark-drawing kind, whatever the script says', () => {
    expect(fieldWritingParams('checkbox', 'vertical', 'korean')).toEqual({});
    expect(fieldWritingParams('signature', 'vertical', 'japanese')).toEqual({});
    expect(fieldWritingParams('radio', 'vertical', 'traditional-chinese')).toEqual({});
  });

  it('names every script the engine accepts, and no other', () => {
    expect([...FIELD_SCRIPTS]).toEqual([
      'japanese',
      'simplified-chinese',
      'traditional-chinese',
      'korean',
    ]);
  });
});

describe('verticalFontCalls', () => {
  it('asks for NOTHING when the batch is all horizontal', () => {
    // The whole point of the empty result: an ordinary create stays the one
    // pdf-lib write it has always been, with no engine round trip.
    expect(
      verticalFontCalls([
        spec({ name: 'a' }),
        spec({ name: 'b', type: 'checkbox' }),
        spec({ name: 'c', type: 'dropdown', options: ['x'] }),
      ]),
    ).toEqual([]);
  });

  it('asks for one call per field bound to one script', () => {
    expect(
      verticalFontCalls([spec({ name: 'notes', writingMode: 'vertical', script: 'japanese' })]),
    ).toEqual([{ script: 'japanese', fields: ['notes'] }]);
  });

  it('groups every field of one script into a single call', () => {
    // Each call re-saves the whole document, so forty Japanese fields are one
    // rewrite rather than forty.
    const calls = verticalFontCalls([
      spec({ name: 'one', writingMode: 'vertical', script: 'japanese' }),
      spec({ name: 'two', writingMode: 'vertical', script: 'japanese' }),
      spec({ name: 'three', writingMode: 'vertical', script: 'japanese' }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ script: 'japanese', fields: ['one', 'two', 'three'] });
  });

  it('splits by script, in the order the scripts first appear', () => {
    const calls = verticalFontCalls([
      spec({ name: 'kr1', writingMode: 'vertical', script: 'korean' }),
      spec({ name: 'jp1', writingMode: 'vertical', script: 'japanese' }),
      spec({ name: 'kr2', writingMode: 'vertical', script: 'korean' }),
    ]);
    expect(calls).toEqual([
      { script: 'korean', fields: ['kr1', 'kr2'] },
      { script: 'japanese', fields: ['jp1'] },
    ]);
  });

  it('skips the horizontal fields of a mixed batch', () => {
    const calls = verticalFontCalls([
      spec({ name: 'plain' }),
      spec({ name: 'column', writingMode: 'vertical', script: 'traditional-chinese' }),
      spec({ name: 'sign', type: 'signature' }),
    ]);
    expect(calls).toEqual([{ script: 'traditional-chinese', fields: ['column'] }]);
  });

  it('never binds a mark-drawing kind, even when the spec says vertical', () => {
    // The engine door would refuse it by name; the batch never asks.
    expect(
      verticalFontCalls([
        spec({ name: 'agree', type: 'checkbox', writingMode: 'vertical', script: 'japanese' }),
      ]),
    ).toEqual([]);
  });

  it('ignores a script left on a field that writes horizontally', () => {
    expect(verticalFontCalls([spec({ name: 'plain', script: 'korean' })])).toEqual([]);
  });

  it('sends the field name the write used — trimmed', () => {
    // The create trims the name before it writes it; a call naming the
    // untrimmed spelling would find no field.
    expect(
      verticalFontCalls([spec({ name: '  spaced  ', writingMode: 'vertical', script: 'korean' })]),
    ).toEqual([{ script: 'korean', fields: ['spaced'] }]);
  });

  it('skips a nameless spec rather than asking for a field with no name', () => {
    expect(
      verticalFontCalls([spec({ name: '   ', writingMode: 'vertical', script: 'japanese' })]),
    ).toEqual([]);
  });
});
