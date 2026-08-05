// The renderer's single door to OCR recognition.
//
// Recognition is the ENGINE's job now — native Tesseract as a subprocess, the
// same recognizer the CLI and every scheduled run use. tesseract.js is retired:
// two recognizers can disagree about the same page, and a headless run has no
// WebView to host a WASM one in.
//
// This is a leaf module on purpose. Importing `ensureGsPath` from SettingsPanel
// creates a render-time dependency that breaks every non-panel consumer, the
// same dependency trap avoided by `app-settings.ts`: pulling in a panel
// component drags module-level theme and Ghostscript side effects into
// whatever imports it. Nothing here may touch React, the DOM, or a component —
// only the bridge and the leaf settings module.

import { app } from './tauri-bridge';
import { loadSettings } from './app-settings';
import type { OcrResult } from '../ocr/types';

/** The engine caller shape both consumers already hold (`useEngine().callRaw`). */
export type RawEngineCall = (
  op: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// Resolved once per session — the vendored paths cannot change at runtime, and
// asking Rust per PAGE would add a round trip to every OCR job in a batch.
let tesseractPathPromise: Promise<string> | null = null;
let bundledGsPromise: Promise<string> | null = null;

export function tesseractPath(): Promise<string> {
  if (!tesseractPathPromise) tesseractPathPromise = app.getTesseractPath();
  return tesseractPathPromise;
}

/** The user's configured Ghostscript, else the bundled one. Ghostscript is what
 * rasterises the page for recognition, so it honours the same preference every
 * other gs-backed operation does rather than hard-wiring the bundle. */
export async function ghostscriptPath(): Promise<string> {
  const configured = loadSettings().gsPath;
  if (configured) return configured;
  if (!bundledGsPromise) bundledGsPromise = app.getGsPath();
  return bundledGsPromise;
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
  const [tesseract, gs] = await Promise.all([tesseractPath(), ghostscriptPath()]);
  const res = (await callRaw('recognize', {
    file,
    page: pageIndex + 1,
    lang,
    tesseract_path: tesseract,
    gs_path: gs,
  })) as OcrResult | undefined;
  return { text: res?.text ?? '', words: res?.words ?? [] };
}
