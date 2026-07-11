// Ported near-verbatim from PDFx src/renderer/src/ocr/ocr.worker.ts (same
// owner). One adaptation: assets are served from the app's own origin
// (public/ocr staged by scripts/sync-ocr-assets.mjs) instead of PDFx's
// custom Electron protocol — fully offline either way.
import Tesseract from 'tesseract.js';
import { DEFAULT_OCR_LANGUAGE } from './languages';
import type { OcrRequest, OcrResponse } from './protocol';
import type { OcrWord } from './types';

// Deviation from PDFx: word boxes come from TSV, not `blocks`. `blocks` is
// built from GetJSONText(), whose availability varies across the WASM core
// variants tesseract.js selects by CPU capability at runtime — in WebView2
// it came back null (text present, zero word boxes) though it works in Node.
// TSV is the long-stable word-geometry format (level 5 = word), reliable
// across every core. Casing is preserved (unlike PDFx's toLowerCase) because
// these words also persist into the PDF as the searchable layer (2m);
// search-side comparisons lowercase at the point of use.
function tsvToWords(tsv: string | null | undefined, width: number, height: number): OcrWord[] {
  if (!tsv) return [];
  const words: OcrWord[] = [];
  for (const line of tsv.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue; // level 5 = word
    const text = cols[11];
    if (!text || !text.trim()) continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const w = Number(cols[8]);
    const h = Number(cols[9]);
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    words.push({ text, x: left / width, y: top / height, w: w / width, h: h / height });
  }
  return words;
}

type Scheduler = ReturnType<typeof Tesseract.createScheduler>;

const scope = self as unknown as {
  postMessage: (message: OcrResponse) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<OcrRequest>) => void) => void;
};

const POOL = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

// Absolute URLs resolved against this worker's own location. Root-relative
// paths ('/ocr/…') fail inside the Tauri WebView2 worker context —
// tesseract's importScripts rejected them as "invalid URL" (live-caught).
// `new URL('/ocr/x', self.location.href)` yields e.g.
// http://tauri.localhost/ocr/x, which loads fine.
const asset = (p: string): string => new URL(p, self.location.href).href;

const OFFLINE_OPTIONS = {
  workerPath: asset('/ocr/worker.min.js'),
  corePath: asset('/ocr/core'),
  langPath: asset('/ocr/lang'),
  gzip: true,
  logger: () => {},
  errorHandler: (error: unknown) => console.error('[ocr worker]', error),
};

let currentLang = DEFAULT_OCR_LANGUAGE;
let schedulerPromise: Promise<Scheduler> | null = null;

async function buildScheduler(lang: string): Promise<Scheduler> {
  const scheduler = Tesseract.createScheduler();
  for (let i = 0; i < POOL; i++) {
    const worker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, OFFLINE_OPTIONS);
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
    scheduler.addWorker(worker);
  }
  return scheduler;
}

function ensureScheduler(): Promise<Scheduler> {
  if (!schedulerPromise) schedulerPromise = buildScheduler(currentLang);
  return schedulerPromise;
}

async function terminateScheduler(): Promise<void> {
  const previous = schedulerPromise;
  schedulerPromise = null;
  if (!previous) return;
  try {
    await (await previous).terminate();
  } catch {
    return;
  }
}

async function setLanguage(lang: string): Promise<void> {
  if (lang === currentLang && schedulerPromise) return;
  currentLang = lang;
  await terminateScheduler();
}

interface Job {
  jobId: string;
  bitmap: ImageBitmap;
}

const queue: Job[] = [];
const cancelled = new Set<string>();
let running = 0;

function pump(): void {
  while (running < POOL && queue.length > 0) {
    const job = queue.shift()!;
    if (cancelled.has(job.jobId)) {
      cancelled.delete(job.jobId);
      job.bitmap.close();
      continue;
    }
    running++;
    void recognize(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function recognize(job: Job): Promise<void> {
  try {
    const scheduler = await ensureScheduler();
    if (cancelled.has(job.jobId)) {
      cancelled.delete(job.jobId);
      job.bitmap.close();
      return;
    }
    const canvas = new OffscreenCanvas(job.bitmap.width, job.bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(job.bitmap, 0, 0);
    const { width, height } = job.bitmap;
    job.bitmap.close();
    const { data } = await scheduler.addJob('recognize', canvas, {}, { text: true, tsv: true });
    scope.postMessage({
      type: 'result',
      jobId: job.jobId,
      text: data.text ?? '',
      words: tsvToWords((data as { tsv?: string }).tsv, width, height),
    });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      jobId: job.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function clearQueue(): void {
  for (const job of queue) job.bitmap.close();
  queue.length = 0;
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'setLanguage':
      void setLanguage(message.lang);
      break;
    case 'recognize':
      queue.push({ jobId: message.jobId, bitmap: message.bitmap });
      pump();
      break;
    case 'cancel':
      cancelled.add(message.jobId);
      break;
    case 'cancelAll':
      clearQueue();
      break;
    case 'dispose':
      clearQueue();
      void terminateScheduler();
      break;
  }
});
