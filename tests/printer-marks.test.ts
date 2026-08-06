import { describe, it, expect } from 'vitest';
import {
  MARK_KINDS,
  MARK_STYLES,
  MARK_WEIGHTS,
  MAX_PAGE_EXTENT,
  exceedsPageLimit,
  grownExtent,
  markGrowth,
  trimSourceKey,
} from '../src/renderer/lib/printer-marks';

describe('printer-mark growth', () => {
  it('every edge gains offset plus length', () => {
    expect(markGrowth(9, 18)).toBe(27);
    expect(markGrowth(0, 12)).toBe(12);
  });

  it('a negative input contributes nothing rather than shrinking the page', () => {
    expect(markGrowth(-40, 18)).toBe(18);
    expect(markGrowth(9, -18)).toBe(9);
  });

  it('the page grows on BOTH sides of each axis', () => {
    expect(grownExtent([0, 0, 612, 792], 9, 18)).toEqual({ width: 666, height: 846 });
  });

  it('an unusable box yields no extent rather than a guess', () => {
    expect(grownExtent([0, 0], 9, 18)).toBeNull();
    expect(exceedsPageLimit([0, 0], 9, 18)).toBe(false);
  });

  it('a box given corners in the other order still measures positive', () => {
    expect(grownExtent([612, 792, 0, 0], 0, 0)).toEqual({ width: 612, height: 792 });
  });

  it('growth past the page limit is visible before the engine refuses it', () => {
    expect(exceedsPageLimit([0, 0, 14000, 200], 100, 200)).toBe(true);
    expect(exceedsPageLimit([0, 0, 14000, 200], 9, 18)).toBe(false);
    expect(MAX_PAGE_EXTENT).toBe(14400);
  });
});

describe('trim source', () => {
  it('each source names its own key, so the panel never says trim when it guessed', () => {
    const keys = ['trim', 'crop', 'media', 'default'].map(trimSourceKey);
    expect(new Set(keys).size).toBe(4);
    expect(trimSourceKey('trim')).toBe('panel.printerMarks.sourceTrim');
  });

  it('an unknown source falls back rather than throwing', () => {
    expect(trimSourceKey('something-else')).toBe('panel.printerMarks.sourceDefault');
  });
});

describe('the mark vocabulary', () => {
  it('matches the engine’s own sets', () => {
    expect([...MARK_KINDS]).toEqual(['crop', 'registration', 'colorbars', 'pageinfo']);
    expect([...MARK_STYLES]).toEqual(['western', 'japanese']);
    expect([...MARK_WEIGHTS]).toEqual([0.125, 0.25, 0.5]);
  });
});
