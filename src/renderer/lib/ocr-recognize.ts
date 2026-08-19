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
