// Clipboard acquisition for Create PDF.
//
// Nothing converts here and nothing converts in the engine either: the Rust
// side writes the clipboard payload into a scratch file whose extension the
// engine's accepted set ALREADY covers (`.png` / `.dib` / `.html` / `.txt`),
// so a clipboard row is an ordinary source row that reorders, removes and
// combines with picked files. `tests/clipboard-source.test.ts` pins that
// every kind this module can produce classifies to a real `SourceKind` —
// a clipboard row that landed as "not supported" would be a door that only
// looks open.
//
// A leaf data + pure-function module for the reason `create-pdf.ts` gives:
// there is no DOM test environment, so a rule inside the component is a rule
// with no test.

import { classify, rowFromPath, type SourceKind, type SourceRow } from './create-pdf';

/** What the Rust `read_clipboard_source` command reports. */
export interface ClipboardSourceResult {
  path: string;
  /** What the user is told they pasted. The ENGINE decides the converter
   * from the extension, exactly as it does for a picked file. */
  kind: 'image' | 'html' | 'text';
  /** The clipboard format the payload came from, for the report line. */
  format: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  chars?: number | null;
  /** `CF_HTML`'s `SourceURL`. Shown, never fetched. */
  source_url?: string | null;
}

/** Every clipboard kind, for the totality pin. */
export const CLIPBOARD_KINDS = ['image', 'html', 'text'] as const;
export type ClipboardKind = (typeof CLIPBOARD_KINDS)[number];

/** The catalog key naming what was pasted. */
export const CLIPBOARD_KIND_LABEL_KEYS: Record<ClipboardKind, string> = {
  image: 'dialog.createPdf.clipboardImage',
  html: 'dialog.createPdf.clipboardHtml',
  text: 'dialog.createPdf.clipboardText',
};

/**
 * The source row for a clipboard payload.
 *
 * `rowFromPath` is the SAME constructor a picked file goes through, so the
 * kind badge, the duplicate suppression and the engine argument cannot
 * diverge between the two doors. `origin` only changes what the row is
 * CALLED — a scratch name like `clipboard-1755…-0.dib` is not a thing a user
 * recognises.
 */
export function clipboardRow(result: ClipboardSourceResult): SourceRow {
  return { ...rowFromPath(result.path), origin: 'clipboard', clipboardKind: result.kind };
}

/**
 * The extension the Rust side writes for each kind.
 *
 * The third copy of a cross-process table (Python converts, TypeScript
 * badges, Rust writes), so it is pinned the way the accepted set already is:
 * `tests/clipboard-source.test.ts` PARSES `clipboard_read.rs` and requires
 * agreement, and requires every extension here to `classify()` non-empty.
 */
export const CLIPBOARD_EXTENSIONS: Record<ClipboardKind, readonly string[]> = {
  image: ['.png', '.dib'],
  html: ['.html'],
  text: ['.txt'],
};

/** Which arm converts a clipboard payload of this kind. Never `''`. */
export function clipboardKindConverts(kind: ClipboardKind): SourceKind[] {
  return CLIPBOARD_EXTENSIONS[kind].map((ext) => classify(`clipboard${ext}`));
}

/**
 * The one-line report under a clipboard row: what arrived, and how much.
 *
 * Returns a catalog key plus its interpolations rather than a string —
 * concatenation is banned, and the shapes genuinely differ (an image has
 * pixels, text has characters, HTML has characters and a source). `count`
 * is present exactly when the key is a plural pair, so the caller picks
 * `tChrome` or `tChromeCount` from the DATA rather than from the key's
 * spelling.
 */
export interface ClipboardSummary {
  key: string;
  params: Record<string, string | number>;
  count?: number;
}

export function clipboardSummary(result: ClipboardSourceResult): ClipboardSummary {
  if (result.kind === 'image') {
    const width = result.width ?? 0;
    const height = result.height ?? 0;
    if (width > 0 && height > 0) {
      return { key: 'dialog.createPdf.clipboardImageSize', params: { width, height } };
    }
    return { key: 'dialog.createPdf.clipboardImagePlain', params: {} };
  }
  const chars = result.chars ?? 0;
  if (result.kind === 'html' && result.source_url) {
    return {
      key: 'dialog.createPdf.clipboardHtmlFrom',
      params: { count: chars, source: result.source_url },
      count: chars,
    };
  }
  return {
    key: result.kind === 'html'
      ? 'dialog.createPdf.clipboardHtmlChars'
      : 'dialog.createPdf.clipboardTextChars',
    params: { count: chars },
    count: chars,
  };
}
