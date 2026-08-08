// The Advanced tab's model: parsing the engine payload, the change set a save
// sends, and the page-size display rules.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ADVANCED,
  TRAPPED_VALUES,
  advancedChanges,
  pageSizeMeasures,
  paperNameOf,
  parseAdvanced,
  type AdvancedProperties,
} from '../src/renderer/lib/doc-advanced';

const advanced = (patch: Partial<AdvancedProperties> = {}): AdvancedProperties => ({
  ...DEFAULT_ADVANCED,
  version: '1.7',
  pages: 5,
  ...patch,
});

describe('parseAdvanced', () => {
  it('reads an engine payload', () => {
    const parsed = parseAdvanced({
      version: '1.7',
      linearized: true,
      tagged: true,
      pages: 12,
      page_sizes: [{ width: 612, height: 792, count: 12 }],
      bytes: 4096,
      trapped: 'true',
      base_url: 'https://example.invalid/',
      has_open_action: true,
      search_index: 'manuals.pdx',
    });
    expect(parsed.linearized).toBe(true);
    expect(parsed.tagged).toBe(true);
    expect(parsed.page_sizes).toEqual([{ width: 612, height: 792, count: 12 }]);
    expect(parsed.trapped).toBe('true');
    expect(parsed.search_index).toBe('manuals.pdx');
  });

  it('falls back to unknown for a trapped value outside the three the spec defines', () => {
    expect(parseAdvanced({ trapped: 'maybe' }).trapped).toBe('unknown');
    expect(parseAdvanced({}).trapped).toBe('unknown');
    for (const value of TRAPPED_VALUES) {
      expect(parseAdvanced({ trapped: value }).trapped).toBe(value);
    }
  });

  it('drops a malformed page-size entry rather than rendering NaN', () => {
    const parsed = parseAdvanced({
      page_sizes: [
        { width: 612, height: 792, count: 2 },
        { width: '612', height: 792, count: 2 },
        null,
        { width: 300 },
      ],
    });
    expect(parsed.page_sizes).toEqual([{ width: 612, height: 792, count: 2 }]);
  });

  it('reports an empty search index as none recorded', () => {
    expect(parseAdvanced({ search_index: '' }).search_index).toBeNull();
    expect(parseAdvanced({ search_index: null }).search_index).toBeNull();
  });
});

describe('advancedChanges', () => {
  it('sends nothing when nothing moved', () => {
    expect(advancedChanges(advanced(), advanced())).toBeNull();
  });

  it('sends only the field that moved', () => {
    expect(advancedChanges(advanced(), advanced({ trapped: 'true' }))).toEqual({
      trapped: 'true',
    });
    expect(advancedChanges(advanced(), advanced({ base_url: 'https://a.invalid/' }))).toEqual({
      base_url: 'https://a.invalid/',
    });
  });

  it('sends an emptied base URL, which is how it is removed', () => {
    const base = advanced({ base_url: 'https://a.invalid/' });
    expect(advancedChanges(base, { ...base, base_url: '' })).toEqual({ base_url: '' });
  });
});

describe('paperNameOf', () => {
  it('names the common papers', () => {
    expect(paperNameOf(612, 792)).toBe('Letter');
    expect(paperNameOf(612, 1008)).toBe('Legal');
    expect(paperNameOf(595.28, 841.89)).toBe('A4');
    expect(paperNameOf(841.89, 1190.55)).toBe('A3');
  });

  it('names a landscape page by the same paper', () => {
    expect(paperNameOf(792, 612)).toBe('Letter');
    expect(paperNameOf(841.89, 595.28)).toBe('A4');
  });

  it('tolerates a producer’s rounding', () => {
    expect(paperNameOf(595.3, 841.9)).toBe('A4');
    expect(paperNameOf(595, 842)).toBe('A4');
  });

  it('answers null for a size no standard paper matches', () => {
    expect(paperNameOf(300, 300)).toBeNull();
    expect(paperNameOf(612, 800)).toBeNull();
  });
});

describe('pageSizeMeasures', () => {
  it('converts points to inches at exactly 72 per inch', () => {
    expect(pageSizeMeasures(612, 792).inches).toEqual({ w: 8.5, h: 11 });
  });

  it('converts points to millimetres', () => {
    expect(pageSizeMeasures(595.28, 841.89).millimetres).toEqual({ w: 210, h: 297 });
  });

  it('rounds rather than printing a full float', () => {
    const measures = pageSizeMeasures(613.7, 791.2);
    expect(String(measures.inches.w).length).toBeLessThanOrEqual(5);
    expect(String(measures.millimetres.h).length).toBeLessThanOrEqual(6);
  });
});
