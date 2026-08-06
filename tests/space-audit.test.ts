import { describe, it, expect } from 'vitest';
import {
  CATEGORY_IDS,
  KNOB_IDS,
  accountsForFile,
  knobOf,
  overheadParts,
  percentOf,
  ranked,
  type SpaceCategory,
  type SpaceReport,
} from '../src/renderer/lib/space-audit';

function category(id: string, over: Partial<SpaceCategory> = {}): SpaceCategory {
  return { id, bytes: 0, share: 0, objects: 0, detail: [], ...over };
}

/** A report whose rows sum to the file size, which is what the engine
 * guarantees and what every consumer is entitled to assume. */
function report(sizes: Record<string, number>, over: Partial<SpaceReport> = {}): SpaceReport {
  const categories = CATEGORY_IDS.map((id) =>
    category(id, {
      bytes: sizes[id] ?? 0,
      residual: id === 'overhead' || undefined,
    }),
  );
  const size = categories.reduce((acc, row) => acc + row.bytes, 0);
  return {
    file_size: size,
    total: size,
    objects: 10,
    revisions: 1,
    unmeasured_objects: 0,
    categories: categories.map((row) => ({ ...row, share: size ? row.bytes / size : 0 })),
    ...over,
  };
}

describe('the space report model', () => {
  it('lists the same fourteen categories the engine reports, overhead last', () => {
    expect(CATEGORY_IDS).toHaveLength(14);
    expect(CATEGORY_IDS[0]).toBe('images');
    expect(CATEGORY_IDS[CATEGORY_IDS.length - 1]).toBe('overhead');
  });

  it('ranks largest first, with overhead competing like any other row', () => {
    const r = report({ images: 100, overhead: 400, fonts: 250 });
    const order = ranked(r).map((row) => row.id);
    expect(order[0]).toBe('overhead');
    expect(order[1]).toBe('fonts');
    expect(order[2]).toBe('images');
  });

  it('breaks ties on the engine order so two audits of one file agree', () => {
    const r = report({ images: 50, fonts: 50, content_streams: 50 });
    const order = ranked(r)
      .filter((row) => row.bytes === 50)
      .map((row) => row.id);
    expect(order).toEqual(['images', 'fonts', 'content_streams']);
  });

  it('accepts a report whose rows account for the file', () => {
    expect(accountsForFile(report({ images: 900, overhead: 100 }))).toBe(true);
  });

  it('rejects a report whose rows do not reach the file size', () => {
    const r = report({ images: 900, overhead: 100 });
    expect(accountsForFile({ ...r, file_size: r.file_size + 1 })).toBe(false);
    expect(accountsForFile({ ...r, total: r.total - 1 })).toBe(false);
    expect(accountsForFile(null)).toBe(false);
  });

  it('rejects an empty file rather than dividing by it', () => {
    expect(accountsForFile(report({}))).toBe(false);
  });

  it('renders a share as a percentage of the file, to one decimal', () => {
    expect(percentOf(category('images', { share: 0.62345 }))).toBe(62.3);
    expect(percentOf(category('images', { share: 1 }))).toBe(100);
    expect(percentOf(category('images', { share: 0 }))).toBe(0);
  });

  it('clamps a share that is not a fraction rather than charting it', () => {
    expect(percentOf(category('images', { share: -0.5 }))).toBe(0);
    expect(percentOf(category('images', { share: 4 }))).toBe(100);
    expect(percentOf(category('images', { share: Number.NaN }))).toBe(0);
  });

  it('names only knobs that exist', () => {
    expect(knobOf(category('images', { knob: 'compress' }))).toBe('compress');
    expect(knobOf(category('fonts'))).toBeNull();
    expect(knobOf(category('fonts', { knob: 'subset_fonts' }))).toBeNull();
    for (const id of KNOB_IDS) {
      expect(knobOf(category('x', { knob: id }))).toBe(id);
    }
  });

  it('orders the residual parts by what a reader can act on first', () => {
    const overhead = category('overhead', {
      residual: true,
      detail: [
        { kind: 'structural', bytes: 4 },
        { kind: 'cross_reference', bytes: 3 },
        { kind: 'unreferenced', bytes: 2 },
        { kind: 'superseded', bytes: 1 },
      ],
    });
    expect(overheadParts(overhead).map((d) => d.kind)).toEqual([
      'superseded',
      'unreferenced',
      'cross_reference',
      'structural',
    ]);
  });

  it('has no residual parts for an ordinary category', () => {
    expect(overheadParts(category('images', { detail: [{ bytes: 5 }] }))).toEqual([]);
  });
});
