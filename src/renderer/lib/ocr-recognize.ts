// The renderer's single door to OCR recognition.
//
// Recognition is the ENGINE's job now — native Tesseract as a subprocess, the
// same recognizer the CLI and every scheduled run use. tesseract.js is retired:
// two recognizers can disagree about the same page, and a headless run has no
// WebView to host a WASM one in.
//
// This is a leaf module on purpose. Importing the settings PANEL for a
// Ghostscript path created a render-time dependency that broke every
// non-panel consumer, so this module resolved its own — a second resolver
// that could disagree with the first. `lib/gs-capability` is itself a leaf,
// which dissolves that reason: there is one answer, and this module asks for
// it. Nothing here may touch React, the DOM, or a component.

import { app } from './tauri-bridge';
import { requireGsPath } from './gs-capability';
import type { OcrResult } from '../ocr/types';

/** The engine caller shape both consumers already hold (`useEngine().callRaw`). */
export type RawEngineCall = (
  op: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// Resolved once per session — the vendored paths cannot change at runtime, and
// asking Rust per PAGE would add a round trip to every OCR job in a batch.
let tesseractPathPromise: Promise<string> | null = null;

export function tesseractPath(): Promise<string> {
  if (!tesseractPathPromise) tesseractPathPromise = app.getTesseractPath();
  return tesseractPathPromise;
}

/**
 * Recognise ONE page. `pageIndex` is 0-based (the renderer's convention); the
 * engine op takes 1-based, and the conversion lives here so no call site has to
 * remember it.
 *
 * Coordinates come back normalised to fractions of the rendered page with y
 * measured from the top — byte-for-byte what tesseract.js returned, which is
 * why every downstream consumer's display→PDF conversion still applies
 * unchanged.
 */
export async function recognizePage(
  callRaw: RawEngineCall,
  file: string,
  pageIndex: number,
  lang: string,
): Promise<OcrResult> {
  const [tesseract, gs] = await Promise.all([tesseractPath(), requireGsPath()]);
  const res = (await callRaw('recognize', {
    file,
    page: pageIndex + 1,
    lang,
    tesseract_path: tesseract,
    gs_path: gs,
  })) as OcrResult | undefined;
  return { text: res?.text ?? '', words: res?.words ?? [] };
}

/**
 * Recognise PNG BYTES the caller already holds — the view-tier door.
 *
 * No `file`, and no Ghostscript: the viewer has already rasterised the page it
 * is showing, and the engine op takes those pixels on stdin. That matters
 * beyond saving a render — the distribution ships no Ghostscript, so a
 * reading-view capability that is on by default cannot route through the
 * page-rendering arm above.
 *
 * `callRaw` rather than `call` deliberately, and by a wider margin than the
 * redaction-mark seed's documented exception: that one at least names a
 * workspace path. This op has NO file parameter at all — it is a pure function
 * of bytes, targets no workspace file, writes nothing, and must not queue a
 * visible operation or run the commit gate for a selection gesture.
 */
export async function recognizeRaster(
  callRaw: RawEngineCall,
  png: Uint8Array,
  lang: string,
): Promise<OcrResult> {
  const tesseract = await tesseractPath();
  const res = (await callRaw('recognize_raster', {
    data: toBase64(png),
    lang,
    tesseract_path: tesseract,
  })) as OcrResult | undefined;
  return { text: res?.text ?? '', words: res?.words ?? [] };
}

/** Chunked so a multi-megabyte page raster cannot blow the argument limit that
 *  `String.fromCharCode(...all)` hits. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
