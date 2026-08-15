// Web-page capture for Create PDF: the pure half.
//
// The capture itself is Rust (`src-tauri/src/web_capture.rs`) — a VISIBLE
// browser window, WebView2's own `PrintToPdf`, one window navigated in turn.
// The engine never learns what a URL is, and this module never fetches
// anything.
//
// What lives here: the option shapes, the clamps, and the outline the
// captured link structure lands as. The URL parse below is PRESENTATIONAL —
// it decides nothing, it only lets the dialog name the host it is about to
// contact before the user presses Capture. The Rust validator is the single
// authority on what may be loaded, and `tests/web-capture.test.ts` PARSES
// `web_capture.rs` so the scheme list and the ceilings here cannot drift from
// the ones that actually decide.

/** The only schemes a capture may load. Mirrors the Rust gate. */
export const CAPTURE_SCHEMES = ['http', 'https', 'file'] as const;

/** The absolute ceilings the Rust side clamps to, whatever is asked. */
export const MAX_PAGES_CEILING = 100;
export const MAX_DEPTH_CEILING = 3;

/** Capture depths the dialog offers, and their catalog keys. */
export const CAPTURE_DEPTHS = [0, 1, 2] as const;
export type CaptureDepth = (typeof CAPTURE_DEPTHS)[number];

export const DEPTH_LABEL_KEYS: Record<CaptureDepth, string> = {
  0: 'dialog.webCapture.depth.page',
  1: 'dialog.webCapture.depth.one',
  2: 'dialog.webCapture.depth.two',
};

/** Paper the dialog offers, in inches — WebView2's print settings unit. */
export const CAPTURE_PAPERS = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  a3: [11.69, 16.54],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
} as const;
export type CapturePaper = keyof typeof CAPTURE_PAPERS;
export const CAPTURE_PAPER_IDS = Object.keys(CAPTURE_PAPERS) as CapturePaper[];

export interface CaptureRequest {
  url: string;
  depth: number;
  maxPages: number;
  pageWidthIn: number;
  pageHeightIn: number;
  orientation: 'portrait' | 'landscape';
  marginIn: number;
  headersFooters: boolean;
  backgrounds: boolean;
  scale: number;
}

export interface CapturedPage {
  url: string;
  title: string;
  path: string;
}

export interface CaptureResult {
  pages: CapturedPage[];
  visited: number;
  truncated: boolean;
  failures: string[];
}

/**
 * The host a capture would contact, for the line the dialog shows BEFORE the
 * capture runs. `null` when nothing usable can be read out of the field —
 * which is a display state, never a decision: the Rust gate refuses, with its
 * own message, whatever this returns.
 */
export function previewHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = trimmed.includes(':') ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!(CAPTURE_SCHEMES as readonly string[]).includes(scheme)) return null;
  // A file: URL has no host and is its own origin — name the file instead of
  // showing an empty string where a host belongs.
  if (scheme === 'file') {
    return decodeURIComponent(parsed.pathname).split('/').filter(Boolean).pop() ?? null;
  }
  return parsed.host.toLowerCase() || null;
}

/**
 * The request the Rust command receives.
 *
 * Clamped HERE as well as in Rust, and that is deliberate rather than
 * duplicated defence: the dialog states the budget it is about to use, and a
 * stated budget the caller then silently changes is worse than no statement.
 * The Rust clamp is what DECIDES; this one is what the user was told.
 */
export function buildRequest(partial: Partial<CaptureRequest> & { url: string }): CaptureRequest {
  const depth = clampInt(partial.depth ?? 0, 0, MAX_DEPTH_CEILING);
  const maxPages = clampInt(partial.maxPages ?? 1, 1, MAX_PAGES_CEILING);
  // Out of range falls back to 1, it does not CLAMP — the Rust side does
  // exactly that, and a renderer that clamped where the gate falls back would
  // report a scale the capture never used.
  const raw = partial.scale ?? 1;
  const scale = Number.isFinite(raw) && raw >= 0.1 && raw <= 2 ? raw : 1;
  const margin = Number.isFinite(partial.marginIn) ? Math.max(0, partial.marginIn!) : 0;
  return {
    url: partial.url.trim(),
    // Depth 0 can only ever produce one page, so a budget above 1 there would
    // advertise a crawl that cannot happen.
    depth,
    maxPages: depth === 0 ? 1 : maxPages,
    pageWidthIn: partial.pageWidthIn && partial.pageWidthIn > 0 ? partial.pageWidthIn : 8.5,
    pageHeightIn: partial.pageHeightIn && partial.pageHeightIn > 0 ? partial.pageHeightIn : 11,
    orientation: partial.orientation === 'landscape' ? 'landscape' : 'portrait',
    marginIn: margin,
    headersFooters: partial.headersFooters ?? false,
    backgrounds: partial.backgrounds ?? true,
    scale,
  };
}

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

/**
 * A paper's width/height in inches, always PORTRAIT.
 *
 * Orientation rides as WebView2's own setting rather than by swapping these,
 * so the two can never disagree about which edge is long.
 */
export function paperInches(paper: CapturePaper): [number, number] {
  const [w, h] = CAPTURE_PAPERS[paper];
  return [w, h];
}

/** The source row shape this module needs, so it stays free of the dialog. */
export interface OutlineRow {
  origin?: 'clipboard' | 'web';
  captureUrl?: string;
  captureTitle?: string;
}

/**
 * The captured link structure, as bookmarks.
 *
 * `contributed` is what `create_pdf` reported each source contributed, in the
 * SAME order the sources were sent — so the offsets come from the assembly
 * that actually happened, never from a page count computed before it. That is
 * also what makes a MIXED list correct: a captured site combined with two
 * local files still gets its bookmarks on the pages the captures landed on.
 *
 * A `contributed` list that does not line up with the rows returns an empty
 * outline rather than bookmarks pointing at the wrong pages — a bookmark that
 * jumps somewhere else is worse than no bookmark.
 */
export function outlineFromRows(
  rows: readonly OutlineRow[],
  contributed: readonly number[],
): { title: string; page: number }[] {
  if (rows.length === 0 || contributed.length !== rows.length) return [];
  const entries: { title: string; page: number }[] = [];
  let cursor = 1;
  for (let i = 0; i < rows.length; i += 1) {
    const count = contributed[i];
    if (!Number.isFinite(count) || count < 1) return [];
    const row = rows[i];
    if (row.origin === 'web') {
      const title = (row.captureTitle ?? '').trim() || (row.captureUrl ?? '').trim();
      if (title) entries.push({ title, page: cursor });
    }
    cursor += count;
  }
  return entries;
}
