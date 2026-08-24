// The personal-signature store and its geometry.
//
// There is no DOM test environment, so everything breakable about F31's
// renderer half lives in lib/signature-assets and lib/signature-image and is
// tested here: what survives a round trip through localStorage, what a raw
// capture normalizes to, what smoothing is allowed to change (nothing about
// the captured points), how a unit-box drawing lands in a placement rect, and
// what the F30 accessor hands the stamp-appearance lane.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodeImageDataUrl,
  isSignatureAsset,
  loadSignatureAssets,
  mergeSignatureAssets,
  normalizeStrokes,
  parseSignatureAssets,
  persistSignatureAssets,
  placeStrokes,
  signatureFaceSource,
  signatureFootprint,
  smoothStrokes,
  strokesBox,
  type SignatureAsset,
} from '../src/renderer/lib/signature-assets';

// A minimal localStorage. The store's whole contract is read-modify-write
// against a key another window also writes, so the test needs a real backing
// map rather than a spy.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const ink = (over: Partial<SignatureAsset> = {}): SignatureAsset =>
  ({
    id: 'a1',
    name: 'Mine',
    role: 'signature',
    aspect: 0.4,
    createdAt: 1000,
    kind: 'ink',
    strokes: [[0, 0, 1, 1]],
    ...over,
  }) as SignatureAsset;

describe('signature asset validation', () => {
  it('accepts each of the three payload shapes', () => {
    expect(isSignatureAsset(ink())).toBe(true);
    expect(
      isSignatureAsset({
        id: 't', name: 'T', role: 'initials', aspect: 0.5, createdAt: 1,
        kind: 'typed', text: 'A Name', face: 'greatvibes',
      }),
    ).toBe(true);
    expect(
      isSignatureAsset({
        id: 'i', name: 'I', role: 'signature', aspect: 0.3, createdAt: 1,
        kind: 'image', imageData: 'data:image/png;base64,AAAA',
      }),
    ).toBe(true);
  });

  it('rejects a typed asset naming a face this build does not ship', () => {
    expect(
      isSignatureAsset({
        id: 't', name: 'T', role: 'signature', aspect: 0.5, createdAt: 1,
        kind: 'typed', text: 'A Name', face: 'Segoe Script',
      }),
    ).toBe(false);
  });

  it('rejects the shapes that would crash a consumer rather than repairing them', () => {
    expect(isSignatureAsset(null)).toBe(false);
    expect(isSignatureAsset({ ...ink(), aspect: 0 })).toBe(false);
    expect(isSignatureAsset({ ...ink(), aspect: Number.NaN })).toBe(false);
    expect(isSignatureAsset({ ...ink(), strokes: [] })).toBe(false);
    // An odd-length path has a y with no x.
    expect(isSignatureAsset({ ...ink(), strokes: [[0, 0, 1]] })).toBe(false);
    expect(isSignatureAsset({ ...ink(), kind: 'scribble' })).toBe(false);
    expect(
      isSignatureAsset({
        id: 'i', name: 'I', role: 'signature', aspect: 0.3, createdAt: 1,
        kind: 'image', imageData: 'https://example.invalid/sig.png',
      }),
    ).toBe(false);
  });

  it('parses a non-array, a malformed row and unparseable text into an empty list', () => {
    expect(parseSignatureAssets(null)).toEqual([]);
    expect(parseSignatureAssets('{"not":"an array"}')).toEqual([]);
    expect(parseSignatureAssets('not json at all')).toEqual([]);
    expect(parseSignatureAssets(JSON.stringify([ink(), { junk: true }]))).toHaveLength(1);
  });
});

describe('the store is shared across windows', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('keeps what another window added while this one held its list', () => {
    persistSignatureAssets([ink({ id: 'mine', createdAt: 10 })]);
    loadSignatureAssets();
    // Another window appends directly to the shared key.
    const raw = JSON.parse(localStorage.getItem('spectra-signatures')!);
    localStorage.setItem(
      'spectra-signatures',
      JSON.stringify([...raw, ink({ id: 'theirs', createdAt: 20 })]),
    );
    // This window persists only what IT knows about.
    const after = persistSignatureAssets([ink({ id: 'mine', createdAt: 10 })]);
    expect(after.map((a) => a.id).sort()).toEqual(['mine', 'theirs']);
  });

  it('a delete here is not undone by the other window s copy', () => {
    persistSignatureAssets([ink({ id: 'x', createdAt: 5 }), ink({ id: 'y', createdAt: 6 })]);
    loadSignatureAssets();
    const after = persistSignatureAssets([ink({ id: 'y', createdAt: 6 })]);
    expect(after.map((a) => a.id)).toEqual(['y']);
  });

  it('merges newest-first, one row per id', () => {
    const merged = mergeSignatureAssets(
      [ink({ id: 'a', createdAt: 1 }), ink({ id: 'b', createdAt: 9 })],
      [ink({ id: 'a', createdAt: 4 })],
    );
    expect(merged.map((a) => [a.id, a.createdAt])).toEqual([
      ['b', 9],
      ['a', 4],
    ]);
  });
});

describe('normalizing a raw capture', () => {
  it('maps the drawing into its own unit box and reports its aspect', () => {
    const got = normalizeStrokes([[10, 20, 30, 20], [10, 30, 30, 40]]);
    expect(got).not.toBeNull();
    expect(got!.aspect).toBeCloseTo(20 / 20, 6);
    expect(got!.strokes[0]).toEqual([0, 0, 1, 0]);
    expect(got!.strokes[1]).toEqual([0, 0.5, 1, 1]);
  });

  it('keeps every captured point — normalizing is not resampling', () => {
    const raw = [[0, 0, 1, 4, 2, 1, 3, 9, 4, 2]];
    const got = normalizeStrokes(raw)!;
    expect(got.strokes[0]).toHaveLength(raw[0].length);
  });

  it('does not stretch a flat stroke into a square', () => {
    // A purely horizontal dash: a zero-height box would divide into NaN, and
    // scaling it to fill the box would turn a dash into a diagonal smear.
    const got = normalizeStrokes([[0, 5, 100, 5]])!;
    expect(got.strokes[0].every(Number.isFinite)).toBe(true);
    expect(got.aspect).toBeCloseTo(1, 6);
    expect(got.strokes[0][1]).toBeCloseTo(0.5, 6);
    expect(got.strokes[0][3]).toBeCloseTo(0.5, 6);
  });

  it('refuses a capture with no extent', () => {
    expect(normalizeStrokes([])).toBeNull();
    expect(normalizeStrokes([[7, 7]])).toBeNull();
    expect(strokesBox([])).toBeNull();
  });
});

describe('smoothing is a render decision', () => {
  it('keeps every captured point on the curve', () => {
    const raw = [[0, 0, 1, 2, 2, 0, 3, 2]];
    const out = smoothStrokes(raw, 4);
    for (let i = 0; i + 1 < raw[0].length; i += 2) {
      const found = [];
      for (let k = 0; k + 1 < out[0].length; k += 2) {
        if (
          Math.abs(out[0][k] - raw[0][i]) < 1e-9 &&
          Math.abs(out[0][k + 1] - raw[0][i + 1]) < 1e-9
        ) {
          found.push(k);
        }
      }
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it('adds points between the samples rather than replacing them', () => {
    const out = smoothStrokes([[0, 0, 1, 2, 2, 0, 3, 2]], 4);
    expect(out[0].length).toBeGreaterThan(8);
  });

  it('leaves a stroke with nothing to curve through untouched', () => {
    expect(smoothStrokes([[0, 0, 1, 1]], 4)).toEqual([[0, 0, 1, 1]]);
    expect(smoothStrokes([[0, 0, 1, 2, 2, 0]], 1)).toEqual([[0, 0, 1, 2, 2, 0]]);
  });

  it('never mutates its input', () => {
    const raw = [[0, 0, 1, 2, 2, 0, 3, 2]];
    const before = JSON.stringify(raw);
    smoothStrokes(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('placement', () => {
  it('maps unit strokes into the placement rect', () => {
    const placed = placeStrokes([[0, 0, 1, 1]], { x: 0.2, y: 0.4, w: 0.5, h: 0.1 });
    expect(placed[0][0]).toBeCloseTo(0.2, 6);
    expect(placed[0][1]).toBeCloseTo(0.4, 6);
    expect(placed[0][2]).toBeCloseTo(0.7, 6);
    expect(placed[0][3]).toBeCloseTo(0.5, 6);
  });

  it('sizes the box so the artwork is undistorted on the sheet', () => {
    // A 2:1 wide mark on a page cell twice as tall as it is wide: the
    // normalized height must carry the cell's own ratio, or the mark is
    // squashed on paper.
    const { w, h } = signatureFootprint(0.5, 400, 800, 0.28);
    expect(w).toBeCloseTo(0.28, 6);
    expect(h).toBeCloseTo(0.28 * 0.5 * (400 / 800), 6);
  });

  it('never places a mark taller than the page', () => {
    const { w, h } = signatureFootprint(20, 400, 400, 0.9);
    expect(h).toBeCloseTo(1, 6);
    expect(w).toBeLessThan(0.9);
    expect(w).toBeGreaterThan(0);
  });
});

describe('the certificate-stamp face accessor (F30)', () => {
  it('hands a drawn signature over as smoothed vector paths, never a raster', () => {
    const src = signatureFaceSource(ink({ strokes: [[0, 0, 0.5, 1, 1, 0]] }))!;
    expect(src.form).toBe('vector');
    expect(src.image).toBeUndefined();
    expect(src.paths!.length).toBe(1);
    expect(src.paths![0].length).toBeGreaterThan(6);
    expect(src.aspect).toBe(0.4);
  });

  it('hands a typed signature over as text plus the BUNDLED face file', () => {
    const src = signatureFaceSource({
      id: 't', name: 'T', role: 'signature', aspect: 0.4, createdAt: 1,
      kind: 'typed', text: 'Ada Lovelace', face: 'sacramento',
    })!;
    expect(src.form).toBe('typed');
    expect(src.typed).toEqual({
      text: 'Ada Lovelace',
      faceId: 'sacramento',
      fontFile: 'Sacramento-Regular.ttf',
    });
  });

  it('hands an imported signature over as decoded bytes and its type', () => {
    // A one-pixel PNG.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const src = signatureFaceSource({
      id: 'i', name: 'I', role: 'signature', aspect: 1, createdAt: 1,
      kind: 'image', imageData: png,
    })!;
    expect(src.form).toBe('image');
    expect(src.image!.mime).toBe('image/png');
    // The PNG signature, so the bytes are the image and not the base64 text.
    expect([...src.image!.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('returns an honest absence rather than a zero-length image', () => {
    expect(decodeImageDataUrl('data:image/png,notbase64')).toBeNull();
    expect(decodeImageDataUrl('data:image/gif;base64,AAAA')).toBeNull();
    expect(
      signatureFaceSource({
        id: 'i', name: 'I', role: 'signature', aspect: 1, createdAt: 1,
        kind: 'image', imageData: 'data:image/png,notbase64',
      }),
    ).toBeNull();
  });
});
