import { describe, it, expect } from 'vitest';
import {
  processingStepLabel,
  processingStepNote,
  type ProcessingStep,
} from '../src/renderer/lib/processing-steps';
import { plateCacheKey } from '../src/renderer/lib/separation-preview';

function step(group: string, type = '', status = 'standard'): ProcessingStep {
  return { group, type, status, page_element: '' };
}

describe('the processing-step label', () => {
  it('joins the group and the type as the document spells them', () => {
    expect(processingStepLabel(step('Structural', 'Cutting'))).toBe('Structural / Cutting');
  });

  it('is the group alone where the group defines no types', () => {
    // `/White` and `/Legend` carry a group and no type at all. A trailing
    // separator would present an empty type as a type.
    expect(processingStepLabel(step('White'))).toBe('White');
    expect(processingStepLabel(step('Legend'))).toBe('Legend');
  });

  it('never translates either half', () => {
    // Both are document content: a vendor-defined group name reaches the
    // panel exactly as the file wrote it, spaces and prefix included.
    const custom = step('GWGS_Test Suite Custom Group');
    expect(processingStepLabel(custom)).toBe('GWGS_Test Suite Custom Group');
  });
});

describe('the note beside a declaration', () => {
  it('says nothing about a declaration the engine took at face value', () => {
    expect(processingStepNote('standard')).toBe('');
  });

  it('names each state the engine could not take at face value', () => {
    for (const status of [
      'missing_group', 'type_on_untyped_group', 'unregistered', 'custom',
    ]) {
      expect(processingStepNote(status)).not.toBe('');
    }
  });

  it('asks about an unrecognized name rather than pronouncing it wrong', () => {
    // The vocabulary the engine matches against is second-hand. Telling a
    // packaging operator their conforming file is broken costs a print run,
    // so this string has to stay a question.
    expect(processingStepNote('unregistered').toLowerCase()).toContain('confirm');
  });

  it('says nothing about a state it has never heard of', () => {
    expect(processingStepNote('something_new')).toBe('');
  });
});

describe('the plate cache key carries the processing-steps switch', () => {
  it('separates the two states of the same page', () => {
    // With the steps hidden the device never saw the die line, so these are
    // two different plate sets. A key that omitted the flag would serve the
    // set from before the flip and present the switch as broken.
    const off = plateCacheKey('d', 'p', 150, true, '', false);
    const on = plateCacheKey('d', 'p', 150, true, '', true);
    expect(off).not.toBe(on);
  });

  it('defaults to the print truth, and to the key the old call produced', () => {
    expect(plateCacheKey('d', 'p', 150, true, '')).toBe(
      plateCacheKey('d', 'p', 150, true, '', false),
    );
  });

  it('still separates everything it separated before', () => {
    const base = plateCacheKey('d', 'p', 150, true, '', true);
    expect(plateCacheKey('e', 'p', 150, true, '', true)).not.toBe(base);
    expect(plateCacheKey('d', 'q', 150, true, '', true)).not.toBe(base);
    expect(plateCacheKey('d', 'p', 300, true, '', true)).not.toBe(base);
    expect(plateCacheKey('d', 'p', 150, false, '', true)).not.toBe(base);
    expect(plateCacheKey('d', 'p', 150, true, 'x', true)).not.toBe(base);
  });
});
