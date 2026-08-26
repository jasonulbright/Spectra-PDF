// View-tier scanned-page recognition: the confidence
// policy, the span geometry, and the cache's invalidation rule.
//
// There is no DOM test environment in this repo, so what can break is what
// lives in `lib/ocr-selection` — the component only mounts spans from the
// boxes this module hands it.
import { describe, it, expect, vi } from 'vitest';
import {
  OCR_MAX_CONCURRENT,
  OCR_MAX_RASTER_PIXELS,
  OCR_SELECT_SCALE,
  PAGE_MIN_MEAN_CONFIDENCE,
  PAGE_MIN_WORDS,
  WORD_MIN_CONFIDENCE,
  forgetSelectionCache,
  gateRecognition,
  peekSelectionCache,
  rasterScaleFor,
  recognizeForSelection,
  releaseOcrSelection,
  wordSpanBox,
} from '../src/renderer/lib/ocr-selection';
import type { OcrResult, OcrWord } from '../src/renderer/ocr/types';

const word = (text: string, conf: number, i = 0): OcrWord => ({
  text,
  x: 0.1,
  y: 0.1 + i * 0.05,
  w: 0.2,
  h: 0.03,
  conf,
});

const result = (words: OcrWord[]): OcrResult => ({ text: words.map((w) => w.text).join(' '), words });

const confidentPage = (n = PAGE_MIN_WORDS + 2): OcrWord[] =>
  Array.from({ length: n }, (_, i) => word(`w${i}`, 92, i));

describe('gateRecognition', () => {
  it('serves a confident page as selection geometry', () => {
    const gated = gateRecognition(result(confidentPage()));
    expect(gated.status).toBe('ready');
    expect(gated.words).toHaveLength(PAGE_MIN_WORDS + 2);
  });

  it('reports nothing recognised as "none", not as a failure', () => {
    // A blank page is not a broken one — the fallback is silent either way,
    // but only 'failed' means the recognizer refused.
    expect(gateRecognition(result([])).status).toBe('none');
    expect(gateRecognition(null).status).toBe('none');
  });

  it('drops words below the per-word floor', () => {
    const words = [...confidentPage(), word('junk', WORD_MIN_CONFIDENCE - 1, 9)];
    const gated = gateRecognition(result(words));
    expect(gated.status).toBe('ready');
    expect(gated.words.map((w) => w.text)).not.toContain('junk');
  });

  it('refuses a page whose surviving words do not average well enough', () => {
    // Every word clears the per-word floor, so the floor alone would serve
    // this page; the page-level mean is what refuses it.
    const mid = WORD_MIN_CONFIDENCE + 2;
    expect(mid).toBeLessThan(PAGE_MIN_MEAN_CONFIDENCE);
    const gated = gateRecognition(
      result(Array.from({ length: 12 }, (_, i) => word(`w${i}`, mid, i))),
    );
    expect(gated.status).toBe('lowConfidence');
    expect(gated.words).toHaveLength(0);
  });

  it('refuses a page with too few words to be a page of text', () => {
    const gated = gateRecognition(result(confidentPage(PAGE_MIN_WORDS - 1)));
    expect(gated.status).toBe('lowConfidence');
  });

  it('does not let one confident heading carry a page of noise', () => {
    const words = [
      word('HEADING', 99, 0),
      ...Array.from({ length: 20 }, (_, i) => word(`n${i}`, WORD_MIN_CONFIDENCE + 1, i + 1)),
    ];
    expect(gateRecognition(result(words)).status).toBe('lowConfidence');
  });

  it('takes a result with no confidence at face value', () => {
    // `conf` is additive on the engine side; treating its absence as zero
    // would turn every pre-existing result into a refusal.
    const words = Array.from({ length: 6 }, (_, i) => {
      const w = word(`w${i}`, 0, i);
      delete w.conf;
      return w;
    });
    expect(gateRecognition(result(words)).status).toBe('ready');
  });

  it('drops degenerate boxes', () => {
    const words = [...confidentPage(), { ...word('flat', 99, 9), h: 0 }];
    expect(gateRecognition(result(words)).words.map((w) => w.text)).not.toContain('flat');
  });
});

describe('wordSpanBox', () => {
  it('denormalises against the layer, with no rotation of its own', () => {
    // The raster is recognised at the orientation the layer is laid out at,
    // so the boxes arrive in the displayed frame already.
    const box = wordSpanBox({ text: 'x', x: 0.25, y: 0.5, w: 0.1, h: 0.04 }, 800, 1000);
    expect(box).toEqual({ left: 200, top: 500, width: 80, height: 40, fontSize: 40 });
  });

  it('never asks for a zero font size', () => {
    const box = wordSpanBox({ text: 'x', x: 0, y: 0, w: 0.1, h: 0 }, 800, 1000);
    expect(box.fontSize).toBeGreaterThan(0);
  });
});

describe('recognizeForSelection', () => {
  it('recognises a page once per buffer', async () => {
    const key = {};
    const run = vi.fn(async () => result(confidentPage()));
    const a = await recognizeForSelection(key, 1, 0, 'eng', run);
    const b = await recognizeForSelection(key, 1, 0, 'eng', run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('keys pages separately', async () => {
    const key = {};
    const run = vi.fn(async () => result(confidentPage()));
    await recognizeForSelection(key, 1, 0, 'eng', run);
    await recognizeForSelection(key, 2, 0, 'eng', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('re-recognises after a page-tier ROTATE', async () => {
    // A quarter-turn changes no bytes, so the proxy and the page number are
    // both unchanged while the raster the boxes were measured against has
    // swapped dimensions. Serving the old entry transposes every hit-box: the
    // sweep selects a different word than the pointer is over, and the quads
    // it authors land on the wrong part of the page.
    const key = {};
    const run = vi.fn(async () => result(confidentPage()));
    const upright = await recognizeForSelection(key, 1, 0, 'eng', run);
    const turned = await recognizeForSelection(key, 1, 90, 'eng', run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(turned).not.toBe(upright);
    // …and turning back reaches the entry recognised at that orientation.
    expect(await recognizeForSelection(key, 1, 0, 'eng', run)).toBe(upright);
    expect(run).toHaveBeenCalledTimes(2);
    // The peek answers per rotation too, or the component would skip the
    // gesture gate on the strength of a different orientation's answer.
    expect(peekSelectionCache(key, 1, 180, 'eng')).toBeNull();
    expect(peekSelectionCache(key, 1, 90, 'eng')).not.toBeNull();
    // 360 is 0: the key is normalised, not the raw sum of two rotations.
    expect(peekSelectionCache(key, 1, 360, 'eng')).toBe(peekSelectionCache(key, 1, 0, 'eng'));
  });

  it('re-recognises when the effective LANGUAGE changes', async () => {
    // The language changes the words and their boxes while leaving the buffer,
    // the page number and the rotation untouched. Pinning a model in
    // Preferences must re-recognise the page on screen; without the language in
    // the key the old model's boxes would be served for the buffer's lifetime.
    const key = {};
    const run = vi.fn(async () => result(confidentPage()));
    const english = await recognizeForSelection(key, 1, 0, 'eng', run);
    const french = await recognizeForSelection(key, 1, 0, 'fra', run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(french).not.toBe(english);
    // Switching back reaches the entry recognised under that model.
    expect(await recognizeForSelection(key, 1, 0, 'eng', run)).toBe(english);
    expect(run).toHaveBeenCalledTimes(2);
    // A multi-model string is its own entry, not a hit on either half.
    expect(peekSelectionCache(key, 1, 0, 'eng+fra')).toBeNull();
    expect(peekSelectionCache(key, 1, 0, 'fra')).not.toBeNull();
  });

  it('re-recognises after the buffer changes', async () => {
    // The key IS the buffer identity (the pdf.js proxy, one per file per
    // buffer). A commit retires it, so the next gesture recognises the page
    // that is actually on screen rather than being handed the old boxes.
    const run = vi.fn(async () => result(confidentPage()));
    await recognizeForSelection({}, 1, 0, 'eng', run);
    await recognizeForSelection({}, 1, 0, 'eng', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('caches a failure instead of retrying on every gesture', async () => {
    const key = {};
    const run = vi.fn(async () => {
      throw new Error('no tesseract');
    });
    expect((await recognizeForSelection(key, 1, 0, 'eng', run)).status).toBe('failed');
    expect((await recognizeForSelection(key, 1, 0, 'eng', run)).status).toBe('failed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('peeks without starting work, and forgets on demand', async () => {
    const key = {};
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
    const run = vi.fn(async () => result(confidentPage()));
    await recognizeForSelection(key, 1, 0, 'eng', run);
    expect(peekSelectionCache(key, 1, 0, 'eng')).not.toBeNull();
    forgetSelectionCache(key);
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
    await recognizeForSelection(key, 1, 0, 'eng', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs no more than OCR_MAX_CONCURRENT recognitions at once', async () => {
    // Each one holds a full-page canvas, a PNG, a base64 copy and an engine
    // subprocess; a reading view with a dozen scanned pages mounted would
    // otherwise start a dozen of those in the same frame.
    const key = {};
    let live = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const run = vi.fn(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((resolve) => release.push(resolve));
      live--;
      return result(confidentPage());
    });
    const all = [1, 2, 3, 4, 5].map((p) => recognizeForSelection(key, p, 0, 'eng', run));
    // Let the slots that are free start.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(OCR_MAX_CONCURRENT);
    expect(run).toHaveBeenCalledTimes(OCR_MAX_CONCURRENT);
    // Drain: each release frees a slot for a queued page.
    while (release.length) {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(all);
    expect(run).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(OCR_MAX_CONCURRENT);
  });
});

describe('rasterScaleFor', () => {
  it('leaves an ordinary page at the recognition scale', () => {
    expect(rasterScaleFor(612, 792)).toBe(OCR_SELECT_SCALE);
  });

  it('scales a large-format sheet down to the pixel bound', () => {
    // An A0 sheet is ordinary in a drawing set and rasterises to ~62 Mpx at
    // the unbounded scale — a quarter-gigabyte canvas, then a PNG, then a
    // base64 string, then an IPC payload, per mounted page.
    const scale = rasterScaleFor(3370, 2384);
    expect(scale).toBeLessThan(OCR_SELECT_SCALE);
    expect(3370 * scale * (2384 * scale)).toBeLessThanOrEqual(OCR_MAX_RASTER_PIXELS + 1);
  });

  it('never returns a scale that would collapse the raster', () => {
    expect(rasterScaleFor(100000, 100000)).toBeGreaterThan(0);
  });
});

describe('releaseOcrSelection', () => {
  it('unmounts the spans on the page already on screen, and forgets the buffer', async () => {
    // The preference turning OFF must take back what is on screen; without
    // this the spans stay selectable until an unrelated rebuild (a reopen, a
    // rotate or a zoom), so "off restores the older behaviour" would only be
    // true after a gesture the user did not make for that reason.
    const key = {};
    const run = vi.fn(async () => result(confidentPage()));
    await recognizeForSelection(key, 1, 0, 'eng', run);
    let cleared = 0;
    expect(releaseOcrSelection(key, { hasOcrSpans: true, clear: () => void cleared++ })).toBe(true);
    expect(cleared).toBe(1);
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
  });

  it('reports nothing to unmount when no recognised spans are mounted', () => {
    let cleared = 0;
    expect(releaseOcrSelection(null, { hasOcrSpans: false, clear: () => void cleared++ })).toBe(
      false,
    );
    expect(cleared).toBe(0);
  });
});
