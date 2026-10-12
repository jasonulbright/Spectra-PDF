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
// Keyed on the CONTENT KEY of the bytes (lib/pdfDocCache: SHA-256 of the
// buffer). A commit or an undo that changes the bytes changes the key, and the
// next gesture recognises the page that is actually on screen; a cache keyed
// on path plus page index would instead hand the NEW bytes the OLD page's
// boxes. A new pdf.js document over EQUAL bytes keeps the key, so its boxes
// and the selection over them survive the swap of document objects.
//
// Lifetime: each cached document holds its key from load to eviction; the
// entry goes when the last document for its bytes is evicted.

// The ROTATION is part of the entry key, not just the page number. A page-tier
// quarter-turn changes no bytes, so the content key and the page number are
// unchanged, while the raster the boxes were measured against has swapped
// dimensions. Serving the pre-rotation boxes transposes every hit-box: the
// sweep selects a different word than the pointer is over, and the /Highlight
// quads it authors land on the wrong part of the page.
//
// The effective LANGUAGE is part of it for the identical reason, one step
// further out: the recognition language changes the words and their boxes
// while leaving the bytes, the page number and the rotation untouched. Pinning
// a model in Preferences must re-recognise the page on screen, and without the
// language in the key it would instead serve the boxes the previous model
// produced for as long as the bytes stayed open.

type RecognitionRun = () => Promise<OcrResult | null>;

/** One page's recognition. `runners` holds every caller's run while the
 * result is pending, newest last; it is emptied once the result settles. */
interface PageWork {
  result: Promise<OcrSelectPage>;
  runners: RecognitionRun[];
}

interface KeyEntry {
  documents: number;
  pages: Map<string, PageWork>;
}

const cache = new Map<string, KeyEntry>();
let runs = 0;

/** A document over the bytes `key` names was loaded. */
export function retainSelectionCache(key: string): void {
  const entry = cache.get(key);
  if (entry) entry.documents++;
  else cache.set(key, { documents: 1, pages: new Map() });
}

/** A document over the bytes `key` names was evicted. The last one takes the
 * recognition of those bytes with it. */
export function releaseSelectionCache(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  if (--entry.documents <= 0) cache.delete(key);
}

/** How many recognitions have started since the module loaded. */
export function recognitionRunCount(): number {
  return runs;
}

/** Page, absolute display rotation normalised to one of 0/90/180/270, and the
 *  '+'-joined model string the boxes were produced by. */
function entryKey(pageNumber: number, spin: number, lang: string): string {
  const turn = (((Math.round(spin / 90) * 90) % 360) + 360) % 360;
  return `${pageNumber}:${turn}:${lang}`;
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
 * A run whose document was destroyed before or while it rendered. It says
 * nothing about the bytes: another document over the same bytes can still
 * recognise them.
 */
export class RecognitionCancelled extends Error {
  constructor() {
    super('recognition cancelled: the document was destroyed');
    this.name = 'RecognitionCancelled';
  }
}

/**
 * Whether a run's rejection is a cancellation rather than a recognizer
 * failure. pdf.js rejects a render in flight with `RenderingCancelledException`
 * when its document is destroyed, and an aborted operator-list stream with
 * `AbortException`; both carry the class name in `name`.
 */
export function isRecognitionCancellation(error: unknown): boolean {
  if (error instanceof RecognitionCancelled) return true;
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

/**
 * Holds every recognition after it takes its slot and before its run starts,
 * until `release`. An end-to-end spec decides with it what happens while a
 * recognition is pending. Reached only from the harness.
 */
let recognitionHold: { held: Promise<void>; waiting: number } | null = null;
export function holdSelectionRecognition(): { release: () => void; waiting: () => number } {
  let release!: () => void;
  const hold = { held: new Promise<void>((resolve) => { release = resolve; }), waiting: 0 };
  recognitionHold = hold;
  return {
    release: () => {
      if (recognitionHold === hold) recognitionHold = null;
      release();
    },
    waiting: () => hold.waiting,
  };
}

const FAILED: OcrSelectPage = { status: 'failed', words: EMPTY };

/** One attempt through the newest live runner. A cancelled runner is dropped
 * and the next newest is tried; with none left the work leaves the cache. */
function attempt(work: PageWork, drop: () => void): Promise<OcrSelectPage> {
  let run: RecognitionRun | undefined;
  return withSlot(async () => {
    const hold = recognitionHold;
    if (hold) {
      hold.waiting++;
      try { await hold.held; } finally { hold.waiting--; }
    }
    run = work.runners[work.runners.length - 1];
    runs++;
    return run();
  }).then(
    (raw) => {
      work.runners = [];
      return gateRecognition(raw);
    },
    (error: unknown) => {
      if (!isRecognitionCancellation(error)) {
        work.runners = [];
        return FAILED;
      }
      work.runners = work.runners.filter((runner) => runner !== run);
      if (work.runners.length) return attempt(work, drop);
      drop();
      return FAILED;
    },
  );
}

/**
 * Recognise one page once per content key per rotation per language. A run
 * is called at most once per (key, page, spin, lang) while a document holds
 * the key, and only once a concurrency slot is free. A key no document holds
 * caches nothing: its entry would never be released.
 *
 * A failure is CACHED as 'failed' rather than left to retry: a recognizer that
 * refused this page will refuse it again, and re-running Tesseract on every
 * pointer-down would turn one quiet fallback into a stutter.
 *
 * A cancellation is not a failure. Two documents over equal bytes share one
 * entry, and each caller's `run` renders through its own document. While the
 * entry is pending every caller's run is kept; a run whose document was
 * destroyed under it gives way to the newest remaining run, and when none
 * remains the entry is dropped, so the next gesture recognises through a live
 * document instead of being served the closed one's cancellation.
 */
export function recognizeForSelection(
  key: string,
  pageNumber: number,
  spin: number,
  lang: string,
  run: RecognitionRun,
): Promise<OcrSelectPage> {
  const pages = cache.get(key)?.pages;
  const id = entryKey(pageNumber, spin, lang);
  const existing = pages?.get(id);
  if (existing) {
    if (existing.runners.length && !existing.runners.includes(run)) existing.runners.push(run);
    return existing.result;
  }
  const work: PageWork = { result: undefined as unknown as Promise<OcrSelectPage>, runners: [run] };
  pages?.set(id, work);
  work.result = attempt(work, () => {
    if (pages?.get(id) === work) pages.delete(id);
  });
  return work.result;
}

/** What the cache already knows, without starting anything. */
export function peekSelectionCache(
  key: string,
  pageNumber: number,
  spin: number,
  lang: string,
): Promise<OcrSelectPage> | null {
  return cache.get(key)?.pages.get(entryKey(pageNumber, spin, lang))?.result ?? null;
}

/**
 * Forget the recognition of one content key, keeping its document count. The
 * OCR preference turning OFF must not leave a page that gets it back showing
 * boxes recognised under the old setting.
 */
export function forgetSelectionCache(key: string): void {
  cache.get(key)?.pages.clear();
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
export function releaseOcrSelection(key: string | null, host: OcrLayerHost): boolean {
  if (key) forgetSelectionCache(key);
  if (!host.hasOcrSpans) return false;
  host.clear();
  return true;
}
