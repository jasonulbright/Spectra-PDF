// Read Out Loud: the reading model. What to speak, in what order, and which
// rectangles name any character range of it.
//
// A LEAF module — no React, no Tauri, no speech API. The synthesizer lives in
// `hooks/useReadAloud`; everything decidable without a voice is decided here,
// which is what vitest can hold.
//
// Rectangles arrive from the engine in page point space and are converted once,
// here, to display-normalized rects (the annotation/find overlay convention);
// a page's in-memory rotation re-projects them at draw time, the findWords
// recipe.
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One character range of a block's text that ONE run drew.
 *
 * `chars` is present only when the run's characters were proved to sit
 * one-to-one on the codes it drew. Where the proof failed — a ligature
 * spelling two letters, a normalization, a unit-level reordering — the span
 * carries `rect` alone and a sub-range of it highlights as the whole span.
 * The distinction is the engine's finding, never a guess made here. */
export interface ReadSpan {
  s: number;
  e: number;
  run: number;
  rect: NormRect;
  chars?: NormRect[];
}

export interface ReadBlock {
  index: number;
  /** The structure tag that owns the block ('H1', 'P', 'TD'), or null on a
   * page read in layout order. Carried for the caller that wants it; the
   * reader itself speaks every block the same way. */
  role: string | null;
  text: string;
  rect: NormRect;
  spans: ReadSpan[];
}

/** What the canvas draws over ONE page while the reader speaks: the block, the
 * sentence inside it, and the word inside that. Three tiers rather than one
 * because they answer different questions — where am I, what is being said,
 * and which word is in the air right now. */
export interface PageReadAloud {
  block: NormRect | null;
  sentence: NormRect[];
  word: NormRect[];
}

export interface ReadPage {
  /** 1-based position within the file's committed order. */
  page: number;
  order: 'structure' | 'layout';
  /** Why structure order did not run, when it did not. Engine-authored
   * English; the bar shows the ORDER, never this string. */
  reason: string | null;
  /** Runs excluded because their marked-content section is tagged /Artifact. */
  artifacts: number;
  blocks: ReadBlock[];
}

interface EngineSpan {
  s: number;
  e: number;
  run: number;
  rect: [number, number, number, number];
  exact: boolean;
  chars?: [number, number, number, number][];
}

interface EngineBlock {
  index: number;
  role: string | null;
  text: string;
  box: [number, number, number, number];
  spans: EngineSpan[];
}

interface EnginePage {
  page: number;
  order: string;
  reason: string | null;
  artifacts: number;
  blocks: EngineBlock[];
}

export async function fetchReadAloudPage(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<ReadPage> {
  const raw = (await call('read_aloud_page', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EnginePage;
  const toDisplay = (rect: [number, number, number, number]): NormRect =>
    pdfRectToDisplay(rect, geometry.box, geometry.bakedRotate);
  return {
    page: raw.page,
    order: raw.order === 'structure' ? 'structure' : 'layout',
    reason: raw.reason ?? null,
    artifacts: raw.artifacts ?? 0,
    blocks: (raw.blocks ?? []).map((block) => ({
      index: block.index,
      role: block.role ?? null,
      text: block.text,
      rect: toDisplay(block.box),
      spans: (block.spans ?? []).map((span) => ({
        s: span.s,
        e: span.e,
        run: span.run,
        rect: toDisplay(span.rect),
        ...(span.exact && span.chars ? { chars: span.chars.map(toDisplay) } : {}),
      })),
    })),
  };
}

/** The union of a non-empty rect list. Used only WITHIN one span — a box
 * bounded across runs would swallow the margin a wrapped phrase crosses. */
function union(rects: NormRect[]): NormRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The rectangles covering `[start, end)` of a block's text: one per span the
 * range touches, sliced to the characters actually named where the span
 * carries per-character geometry and the whole span otherwise. */
export function rectsForRange(block: ReadBlock, start: number, end: number): NormRect[] {
  if (end <= start) return [];
  const out: NormRect[] = [];
  for (const span of block.spans) {
    const from = Math.max(span.s, start);
    const to = Math.min(span.e, end);
    if (to <= from) continue;
    if (!span.chars) {
      out.push(span.rect);
      continue;
    }
    const slice = span.chars.slice(from - span.s, to - span.s);
    // A slice of only zero-width entries (a synthesized line-join space) names
    // no ink; its span's own rect is the honest answer.
    const inked = slice.filter((r) => r.w > 0 || r.h > 0);
    out.push(inked.length > 0 ? union(inked) : span.rect);
  }
  return out;
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

/**
 * A block's text split into sentences, by `Intl.Segmenter` at `sentence`
 * granularity under `locale`.
 *
 * A runtime without `Intl.Segmenter` reads the block as ONE sentence rather
 * than applying a punctuation regex: a regex that is right for English is
 * wrong for the scripts the segmenter exists to serve, and one long utterance
 * is spoken correctly — only the highlight is coarser.
 */
export function segmentSentences(text: string, locale: string): Sentence[] {
  const out: Sentence[] = [];
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) {
    return text.trim() ? [{ start: 0, end: text.length, text }] : [];
  }
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Segmenter(locale, { granularity: 'sentence' });
  } catch {
    // An unusable locale tag is the DOCUMENT's, not the user's, so it must
    // never take the feature down: fall back to the runtime's own default.
    segmenter = new Segmenter(undefined, { granularity: 'sentence' });
  }
  for (const part of segmenter.segment(text)) {
    const segment = part.segment;
    if (!segment.trim()) continue;
    out.push({
      start: part.index,
      end: part.index + segment.length,
      text: segment,
    });
  }
  return out;
}

/** One thing the synthesizer is asked to say. */
export interface Utterance {
  pageIndex: number;
  blockIndex: number;
  /** Offsets into the BLOCK's text — what `rectsForRange` takes. */
  start: number;
  end: number;
  text: string;
}

/**
 * Every utterance of one page, in reading order.
 *
 * A block whose text yields no sentence (a rule, a stray page number, pure
 * whitespace) contributes nothing: speaking an empty utterance produces a
 * silent stretch the listener reads as the reader having stopped.
 */
export function utterancesForPage(
  page: ReadPage,
  pageIndex: number,
  locale: string,
): Utterance[] {
  const out: Utterance[] = [];
  for (const block of page.blocks) {
    for (const sentence of segmentSentences(block.text, locale)) {
      out.push({
        pageIndex,
        blockIndex: block.index,
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
      });
    }
  }
  return out;
}

/** The BCP-47 tag sentence segmentation and voice matching run under.
 *
 * The document's own `/Lang` wins where it states one — a document says what
 * it is written in more reliably than the interface language of whoever
 * opened it (the rule spell check settled). A tag the runtime cannot parse is
 * not a tag. */
export function readingLocale(docLang: string | null, uiLanguage: string): string {
  const candidate = (docLang ?? '').trim();
  if (candidate) {
    try {
      return new Intl.Locale(candidate).toString();
    } catch {
      /* not a tag — fall through to the interface language */
    }
  }
  return uiLanguage;
}

/**
 * The voice to speak `locale` in, out of what the platform offers.
 *
 * Exact tag first, then the language subtag, then the platform default (an
 * empty return, which the synthesizer answers with its own default voice — the
 * measured: an unassigned utterance still speaks). A `pinned`
 * voiceURI the user chose outranks all of it while that voice is still
 * installed; a voice that has been uninstalled falls back rather than leaving
 * the reader silent.
 */
export function pickVoice(
  voices: readonly { voiceURI: string; lang: string; default?: boolean }[],
  locale: string,
  pinned: string,
): string {
  if (pinned && voices.some((v) => v.voiceURI === pinned)) return pinned;
  const wanted = locale.toLowerCase();
  const exact = voices.find((v) => v.lang.toLowerCase().replace('_', '-') === wanted);
  if (exact) return exact.voiceURI;
  const language = wanted.split('-')[0];
  const partial = voices.find(
    (v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === language,
  );
  if (partial) return partial.voiceURI;
  return '';
}

/** Speaking rates the bar offers, as multiples of the voice's own. The Web
 * Speech range is 0.1–10; these are the span a listener actually uses, and
 * every one of them is a value `SpeechSynthesisUtterance.rate` takes. */
export const READ_ALOUD_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** Clamp a stored rate onto the offered set — a settings file edited by hand,
 * or written by an older build, must not hand the synthesizer a value it
 * rejects (which throws away the whole utterance, not just the rate). */
export function normalizeRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  let best: number = READ_ALOUD_RATES[0];
  for (const candidate of READ_ALOUD_RATES) {
    if (Math.abs(candidate - rate) < Math.abs(best - rate)) best = candidate;
  }
  return best;
}
