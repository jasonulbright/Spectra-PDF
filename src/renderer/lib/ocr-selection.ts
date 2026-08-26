// View-tier text recognition, so a SCANNED page can be selected and
// highlighted without first being rewritten.
//
// A page whose only content is a picture of text has no text layer, so the
// browser has nothing to select and the markup bar never appears. This module
// supplies the second geometry source: the page's own rendered pixels go to
// the bundled recognizer, and the word boxes that come back stand in for text
// runs long enough for a sweep to snap to words.
//
// STRUCTURALLY NON-DESTRUCTIVE. Recognition output lives here, in view state,
// exactly as redaction MARKS do — there is no code path from this module to
// file bytes, and nothing it produces is ever written. What a sweep authors is
// an ordinary /Highlight annotation with QuadPoints, which is valid with or
// without a text layer; writing a text layer INTO the document stays the
// explicit Scan & OCR door.
//
// Pure on purpose: there is no DOM test environment in this repo, so the
// confidence policy, the span geometry and the cache's invalidation rule live
// here where they can be pinned, and the component only mounts spans.

import type { OcrResult, OcrWord } from '../ocr/types';

/**
 * Words below this confidence are dropped outright. Tesseract reports 0..100
 * per word and -1 for a row it did not classify as text; a word it is barely
 * willing to claim is a box in the wrong place, and a selection that snaps to
 * the wrong box is worse than one that does not snap at all.
 */
export const WORD_MIN_CONFIDENCE = 40;

/**
 * A page whose surviving words do not AVERAGE this well is not snapped to at
 * all. A low-confidence page falls back to freehand rather
 * than snapping badly, so the whole page is refused rather than served a
 * scattering of the few words that happened to score.
 */
export const PAGE_MIN_MEAN_CONFIDENCE = 60;

/**
 * Fewer surviving words than this is noise on a picture, not a page of text.
 * Low deliberately: the floor exists to reject a photo whose caption scored,
 * not to demand a paragraph — a scanned form whose only recognised line is a
 * heading and an amount is still a page worth snapping to.
 */
export const PAGE_MIN_WORDS = 3;

/**
 * Pixels per PDF point the page is re-rendered at for recognition (~200 dpi).
 *
 * Fixed rather than "whatever the view is at", for the snapshot tool's reason:
 * a page recognised from a 40% zoom carries 40% of its detail into the
 * recogniser and quietly recognises worse. Below the 300 dpi the file-mutating
 * OCR pass uses because this tier only has to place BOXES, not transcribe.
 */
export const OCR_SELECT_SCALE = 200 / 72;

/**
 * Upper bound on the recognition raster, in pixels.
 *
 * `OCR_SELECT_SCALE` alone is unbounded in the page's own size: an A0 sheet
 * (3370x2384pt, ordinary for a drawing set) rasterises to ~62 Mpx, which is a
 * quarter-gigabyte canvas, then a PNG, then a base64 string, then an IPC
 * payload — per page, with several pages mounted. The boxes are normalised
 * against the raster's own dimensions, so scaling the raster down costs
 * recognition detail and costs geometry nothing.
 */
export const OCR_MAX_RASTER_PIXELS = 24_000_000;

/**
 * At most this many recognitions run at once.
 *
 * Each one holds a full-page canvas, a PNG blob, a base64 copy of it and an
 * engine subprocess; a reading view with a dozen scanned pages mounted would
 * otherwise start a dozen of those in the same frame.
 */
export const OCR_MAX_CONCURRENT = 2;

/**
 * The scale to rasterise a page of this size at: `OCR_SELECT_SCALE`, reduced
 * just enough that the result fits `OCR_MAX_RASTER_PIXELS`. Dimensions are in
 * PDF points, at the orientation the raster will be rendered at.
 */
export function rasterScaleFor(widthPt: number, heightPt: number): number {
  const area = Math.max(1, widthPt * OCR_SELECT_SCALE) * Math.max(1, heightPt * OCR_SELECT_SCALE);
  if (area <= OCR_MAX_RASTER_PIXELS) return OCR_SELECT_SCALE;
  return OCR_SELECT_SCALE * Math.sqrt(OCR_MAX_RASTER_PIXELS / area);
}

export type OcrSelectStatus =
  /** Recognition is running; the gesture works, snapping arrives when it does. */
  | 'pending'
  /** Word boxes are usable as selection geometry. */
  | 'ready'
  /** Recognised, but not well enough to snap to — freehand covers this page. */
  | 'lowConfidence'
  /** Nothing to recognise (a blank or purely graphic page). */
  | 'none'
  /** The recognizer refused or failed. A quiet fallback, never a dialog. */
  | 'failed';

export interface OcrSelectPage {
  status: OcrSelectStatus;
  /** Empty unless `status` is 'ready'. */
  words: readonly OcrWord[];
}

const EMPTY: readonly OcrWord[] = [];

/**
 * Apply the confidence policy to a raw recognition result.
 *
 * Two gates, deliberately: a per-word floor removes individual boxes the
 * recognizer does not stand behind, and a page-level mean decides whether the
 * page is worth snapping to at all. Either alone is wrong — the floor alone
 * would serve a page of garbage that happened to clear it word by word, and
 * the mean alone would let one confident heading drag a page of noise over
 * the line.
 */
export function gateRecognition(result: OcrResult | null | undefined): OcrSelectPage {
  const raw = result?.words ?? [];
  if (raw.length === 0) return { status: 'none', words: EMPTY };
  const kept: OcrWord[] = [];
  let total = 0;
  for (const w of raw) {
    // A result with no confidence at all (an older engine) is taken at face
    // value rather than silently discarded: `conf` is additive, and treating
    // its absence as zero would turn every such page into a refusal.
    const conf = w.conf ?? 100;
    if (conf < WORD_MIN_CONFIDENCE) continue;
    if (w.w <= 0 || w.h <= 0) continue;
    kept.push(w);
    total += conf;
  }
  if (kept.length < PAGE_MIN_WORDS) return { status: 'lowConfidence', words: EMPTY };
  if (total / kept.length < PAGE_MIN_MEAN_CONFIDENCE) {
    return { status: 'lowConfidence', words: EMPTY };
  }
  return { status: 'ready', words: kept };
}

/** Where one word's span sits inside a text layer of the given pixel size. */
export interface WordSpanBox {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

/**
 * One normalised word box → its span's pixel geometry.
 *
 * The boxes are normalised to the page at the rotation they were RECOGNISED
 * at, and the cache is keyed on that rotation, so a hit can only ever be boxes
 * from the same frame the layer is being laid out in — hence no rotation to
 * undo here. The selection rects the spans produce then travel the identical
 * `selectionQuadsByPage` path real text runs travel, which is what makes the
 * quads land correctly under Rotate View with no second geometry idiom.
 *
 * Tesseract's boxes are axis-aligned, so a skewed scan yields upright quads.
 * That is the contract: the quads ARE the boxes.
 */
export function wordSpanBox(word: OcrWord, layoutW: number, layoutH: number): WordSpanBox {
  const height = word.h * layoutH;
  return {
    left: word.x * layoutW,
    top: word.y * layoutH,
    width: word.w * layoutW,
    height,
    // The span is scaled horizontally to the box after measurement (pdf.js's
    // own trick); the font size only has to make the glyphs the right HEIGHT.
    fontSize: Math.max(1, height),
  };
}

// ── The cache ───────────────────────────────────────────────────────────────
// Keyed on BUFFER IDENTITY, which is what the pdf.js proxy already is: one
// proxy per file per buffer (lib/pdfDocCache), replaced the moment the bytes
// change. So a commit, an undo or a refresh retires the proxy, the entries
// keyed on it become unreachable, and the next gesture recognises the page
// that is actually on screen. A cache keyed on path plus page index would
// instead hand the NEW bytes the OLD page's boxes.
//
// A WeakMap because the key IS the lifetime: nothing here should keep a
// destroyed document's raster geometry alive.

// The ROTATION is part of the entry key, not just the page number. A page-tier
// quarter-turn changes no bytes, so the proxy is unchanged and the page number
// is unchanged, while the raster the boxes were measured against has swapped
// dimensions. Serving the pre-rotation boxes transposes every hit-box: the
// sweep selects a different word than the pointer is over, and the /Highlight
// quads it authors land on the wrong part of the page.

const cache = new WeakMap<object, Map<string, Promise<OcrSelectPage>>>();

/** Absolute display rotation, normalised to one of 0/90/180/270. */
function entryKey(pageNumber: number, spin: number): string {
  return `${pageNumber}:${((Math.round(spin / 90) * 90) % 360 + 360) % 360}`;
}

let inFlight = 0;
const waiting: (() => void)[] = [];

/** Run `job` once a recognition slot is free. */
async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (inFlight >= OCR_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await job();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/**
 * Recognise one page once per buffer per rotation. `key` is the
 * buffer-identity object (the pdf.js proxy); `run` produces a raw result and
 * is called at most once per (key, page, spin), and only once a concurrency
 * slot is free.
 *
 * A failure is CACHED as 'failed' rather than left to retry: a recognizer that
 * refused this page will refuse it again, and re-running Tesseract on every
 * pointer-down would turn one quiet fallback into a stutter.
 */
export function recognizeForSelection(
  key: object,
  pageNumber: number,
  spin: number,
  run: () => Promise<OcrResult | null>,
): Promise<OcrSelectPage> {
  let pages = cache.get(key);
  if (!pages) cache.set(key, (pages = new Map()));
  const id = entryKey(pageNumber, spin);
  const existing = pages.get(id);
  if (existing) return existing;
  const started = withSlot(run).then(gateRecognition, () => ({
    status: 'failed' as const,
    words: EMPTY,
  }));
  pages.set(id, started);
  return started;
}

/** What the cache already knows, without starting anything. */
export function peekSelectionCache(
  key: object,
  pageNumber: number,
  spin: number,
): Promise<OcrSelectPage> | null {
  return cache.get(key)?.get(entryKey(pageNumber, spin)) ?? null;
}

/**
 * Forget one buffer's recognition. Not needed for correctness — a retired
 * proxy is unreachable — but the OCR preference turning OFF should not leave
 * a page that gets it back showing boxes recognised under the old setting.
 */
export function forgetSelectionCache(key: object): void {
  cache.delete(key);
}

/** The mounted OCR spans, as much of them as this module needs to see. */
export interface OcrLayerHost {
  /** Whether recognised spans are currently mounted. */
  hasOcrSpans: boolean;
  /** Remove them, restoring the layer the native render would have left. */
  clear: () => void;
}

/**
 * The preference turning OFF, applied to a page that is already on screen.
 *
 * Without this the spans stay mounted and selectable until the page next
 * rebuilds (a reopen, a rotate or a zoom), so "off restores the older
 * behaviour exactly" would be true only after an unrelated gesture. Returns
 * whether anything was unmounted.
 */
export function releaseOcrSelection(key: object | null, host: OcrLayerHost): boolean {
  if (key) forgetSelectionCache(key);
  if (!host.hasOcrSpans) return false;
  host.clear();
  return true;
}
