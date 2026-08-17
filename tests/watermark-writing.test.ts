// The watermark card's writing mode: what reaches the engine, and what the
// card is allowed to say came back.
import { describe, expect, it } from 'vitest';
import {
  effectiveWriting,
  resolvedColumns,
  writingParams,
} from '../src/renderer/lib/watermark-writing';

describe('effectiveWriting', () => {
  it('keeps a text stamp on the mode that was chosen', () => {
    expect(effectiveWriting('text', 'horizontal')).toBe('horizontal');
    expect(effectiveWriting('text', 'vertical')).toBe('vertical');
  });

  it('resolves a non-text source back to horizontal', () => {
    // The control is off screen for these sources, so a mode left behind by
    // a source switch must not reach the engine as a refusal.
    expect(effectiveWriting('image', 'vertical')).toBe('horizontal');
    expect(effectiveWriting('pdf', 'vertical')).toBe('horizontal');
  });
});

describe('writingParams', () => {
  it('sends NOTHING for a horizontal stamp', () => {
    // The byte-identity pin: the call a horizontal stamp makes carries no
    // writing_mode key at all, so it is argument-for-argument the call made
    // before the control existed.
    expect(writingParams('text', 'horizontal')).toEqual({});
    expect(Object.keys(writingParams('text', 'horizontal'))).toHaveLength(0);
    expect('writing_mode' in writingParams('text', 'horizontal')).toBe(false);
  });

  it('sends the bare vertical mode for a vertical text stamp', () => {
    // Bare `vertical`, never a spelled direction: the engine derives the
    // column direction from the text, and an explicit spelling it disagrees
    // with is a refusal.
    expect(writingParams('text', 'vertical')).toEqual({ writing_mode: 'vertical' });
  });

  it('sends nothing for a picture or a lifted page whatever the mode', () => {
    expect(writingParams('image', 'vertical')).toEqual({});
    expect(writingParams('pdf', 'vertical')).toEqual({});
  });
});

describe('resolvedColumns', () => {
  it('reads the direction off the engine result', () => {
    expect(resolvedColumns('vertical-rl')).toBe('rtl');
    expect(resolvedColumns('vertical-lr')).toBe('ltr');
  });

  it('claims nothing when the result is not a vertical one', () => {
    expect(resolvedColumns('horizontal')).toBeNull();
    expect(resolvedColumns('vertical')).toBeNull();
    expect(resolvedColumns(undefined)).toBeNull();
    expect(resolvedColumns(null)).toBeNull();
    expect(resolvedColumns(0)).toBeNull();
  });
});
