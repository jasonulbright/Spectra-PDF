// Ported from PDFx src/renderer/src/search/engine.ts (same owner), adapted
// to this app's Workspace/OpenDocument/PageRef model:
//  - pages carry {id, sourceDocId, sourcePageIndex}; the pdf.js proxy for a
//    source comes from the proxies map (usePdfProxies), not a page-embedded
//    handle — reconcile() takes both and simply skips pages whose proxy
//    hasn't loaded yet (it re-runs when proxies change).
//  - NEW invalidatePath(): this app MUTATES files (commits, whole-file ops,
//    undo, OCR-apply itself) — when a file's buffer identity changes, every
//    per-source cache for that path is stale and must drop. PDFx never
//    needed this (it never rewrites its sources).
// Everything else — born-digital extraction, needsOcr detection, OCR
// queueing/concurrency, per-source caching that survives page moves,
// normalized occurrence counting — is PDFx's proven logic, unchanged.
import { countOccurrences, normalizeQuery, normalizeText } from './normalize';
import { extractPageText } from './extract';
import { createOcrClient, type OcrClient } from '../ocr/ocr-client';
import { DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import type { OcrWord } from '../ocr/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument } from '../state/types';

export interface SearchResult {
  pageIds: Set<string>;
  docIds: Set<string>;
  pages: number;
  occurrences: number;
}

export const EMPTY_RESULT: SearchResult = {
  pageIds: new Set(),
  docIds: new Set(),
  pages: 0,
  occurrences: 0,
};

export interface SearchEngine {
  reconcile: (docs: OpenDocument[], proxies: Map<string, PDFDocumentProxy>) => void;
  search: (query: string) => SearchResult;
  /** Per matching page, a short context window around the FIRST match — over
   * the retained normalized page text (Phase 4 § 5.4, the Search panel). Keyed
   * by page id; lowercase (the index stores normalized text). */
  snippetsFor: (query: string) => Map<string, string>;
  setLanguage: (lang: string) => void;
  getOcrWords: (sourceKey: string) => OcrWord[] | undefined;
  /** Source keys (path:pageIndex) that were detected as scanned AND have OCR
   * words available — the input for "Make searchable". */
  ocrReadySources: () => string[];
  invalidatePath: (path: string) => void;
  dispose: () => void;
}

export interface EngineCallbacks {
  onChange: () => void;
  onProgress: (remaining: number, hasScanned: boolean) => void;
  getDocs: () => OpenDocument[];
}

interface OcrJob {
  key: string;
  pdf: PDFDocumentProxy;
  pageIndex: number;
}

const OCR_CONCURRENCY = 2;

export const sourceKeyOf = (page: { sourceDocId: string; sourcePageIndex: number }): string =>
  `${page.sourceDocId}:${page.sourcePageIndex}`;

export function createSearchEngine({ onChange, onProgress, getDocs }: EngineCallbacks): SearchEngine {
  const pageText = new Map<string, string>();
  const sourceBorn = new Map<string, string>();
  const sourceOcr = new Map<string, string>();
  const sourceOcrWords = new Map<string, OcrWord[]>();
  const scanned = new Set<string>();
  const ocrQueued = new Set<string>();
  const ocrQueue: OcrJob[] = [];
  const pagesBySource = new Map<string, Set<string>>();
  const sourceRef = new Map<string, OcrJob>();
  // Per-source generation, bumped whenever a file's bytes change under it
  // (invalidatePath). A recognize() already dispatched to the worker keeps
  // running against the PRE-mutation raster; its result is discarded if the
  // generation moved on — otherwise a stale pass (e.g. the pre-redaction
  // image) could overwrite the fresh one and get persisted as an invisible
  // searchable layer, re-embedding just-removed text. (Review-caught.)
  const sourceGen = new Map<string, number>();
  const genOf = (key: string): number => sourceGen.get(key) ?? 0;

  let ocrInFlight = 0;
  let jobSeq = 0;
  let lang = DEFAULT_OCR_LANGUAGE;
  let client: OcrClient | null = null;
  let reconcileToken = 0;

  const effective = (key: string): string => sourceOcr.get(key) ?? sourceBorn.get(key) ?? '';
  const reportProgress = (): void => onProgress(ocrQueue.length + ocrInFlight, scanned.size > 0);

  function ensureClient(): OcrClient {
    if (!client) {
      client = createOcrClient();
      client.setLanguage(lang);
    }
    return client;
  }

  function applySource(key: string): void {
    const ids = pagesBySource.get(key);
    if (!ids) return;
    const text = effective(key);
    for (const id of ids) pageText.set(id, text);
  }

  function enqueueOcr(job: OcrJob): void {
    if (ocrQueued.has(job.key)) return;
    ocrQueued.add(job.key);
    ocrQueue.push(job);
    reportProgress();
    pumpOcr();
  }

  function pumpOcr(): void {
    while (ocrInFlight < OCR_CONCURRENCY && ocrQueue.length > 0) {
      const job = ocrQueue.shift()!;
      ocrInFlight++;
      reportProgress();
      const jobId = `${++jobSeq}`;
      const jobGen = genOf(job.key); // raster generation this pass ran against
      ensureClient()
        .recognize(job.pdf, job.pageIndex, jobId)
        .then(({ text, words }) => {
          // Discard if the page closed OR the file's bytes changed under this
          // in-flight pass (stale raster — see sourceGen).
          if (!pagesBySource.has(job.key) || genOf(job.key) !== jobGen) return;
          sourceOcr.set(job.key, normalizeText(text));
          sourceOcrWords.set(job.key, words);
          applySource(job.key);
          onChange();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== 'cancelled') console.warn('OCR failed', error);
        })
        .finally(() => {
          ocrInFlight--;
          reportProgress();
          pumpOcr();
        });
    }
  }

  async function runExtraction(
    jobs: { pageId: string; key: string; pdf: PDFDocumentProxy; pageIndex: number }[],
    token: number,
  ): Promise<void> {
    for (const job of jobs) {
      if (token !== reconcileToken) return;
      if (sourceBorn.has(job.key)) {
        pageText.set(job.pageId, effective(job.key));
        if (scanned.has(job.key) && !ocrQueued.has(job.key)) {
          enqueueOcr({ key: job.key, pdf: job.pdf, pageIndex: job.pageIndex });
        }
        onChange();
        continue;
      }
      try {
        const { text, needsOcr } = await extractPageText(job.pdf, job.pageIndex);
        sourceBorn.set(job.key, normalizeText(text));
        if (needsOcr) {
          scanned.add(job.key);
          reportProgress();
          enqueueOcr({ key: job.key, pdf: job.pdf, pageIndex: job.pageIndex });
        }
        pageText.set(job.pageId, effective(job.key));
        onChange();
      } catch (error) {
        console.error(`Failed to index page ${job.pageIndex + 1}`, error);
      }
    }
  }

  return {
    reconcile(docs, proxies) {
      const token = ++reconcileToken;
      const presentPages = new Set<string>();
      const presentKeys = new Set<string>();
      const toExtract: { pageId: string; key: string; pdf: PDFDocumentProxy; pageIndex: number }[] = [];
      let changed = false;

      pagesBySource.clear();
      sourceRef.clear();

      for (const doc of docs) {
        for (const page of doc.pages) {
          const pdf = proxies.get(page.sourceDocId);
          if (!pdf) continue; // proxy not loaded yet — a later reconcile picks it up
          presentPages.add(page.id);
          const key = sourceKeyOf(page);
          presentKeys.add(key);
          let ids = pagesBySource.get(key);
          if (!ids) pagesBySource.set(key, (ids = new Set()));
          ids.add(page.id);
          if (!sourceRef.has(key)) {
            sourceRef.set(key, { key, pdf, pageIndex: page.sourcePageIndex });
          }
          if (pageText.has(page.id)) continue;
          if (sourceBorn.has(key)) {
            pageText.set(page.id, effective(key));
            changed = true;
            if (scanned.has(key) && !ocrQueued.has(key)) {
              enqueueOcr({ key, pdf, pageIndex: page.sourcePageIndex });
            }
          } else {
            toExtract.push({ pageId: page.id, key, pdf, pageIndex: page.sourcePageIndex });
          }
        }
      }

      for (const id of [...pageText.keys()]) {
        if (!presentPages.has(id)) {
          pageText.delete(id);
          changed = true;
        }
      }

      for (const key of [...sourceBorn.keys()]) {
        if (!presentKeys.has(key)) {
          sourceBorn.delete(key);
          sourceOcr.delete(key);
          sourceOcrWords.delete(key);
          scanned.delete(key);
          ocrQueued.delete(key);
        }
      }

      if (ocrQueue.length > 0) {
        for (let i = ocrQueue.length - 1; i >= 0; i--) {
          if (!presentKeys.has(ocrQueue[i].key)) {
            ocrQueued.delete(ocrQueue[i].key);
            ocrQueue.splice(i, 1);
          }
        }
        reportProgress();
      }

      if (changed) onChange();
      if (toExtract.length > 0) void runExtraction(toExtract, token);
    },

    search(query) {
      const q = normalizeQuery(query);
      if (!q) return EMPTY_RESULT;
      const pageIds = new Set<string>();
      let occurrences = 0;
      for (const [pageId, text] of pageText) {
        const count = countOccurrences(text, q);
        if (count > 0) {
          pageIds.add(pageId);
          occurrences += count;
        }
      }
      const docIds = new Set<string>();
      for (const doc of getDocs()) {
        if (doc.pages.some((p) => pageIds.has(p.id))) docIds.add(doc.id);
      }
      return { pageIds, docIds, pages: pageIds.size, occurrences };
    },

    snippetsFor(query) {
      const q = normalizeQuery(query);
      const out = new Map<string, string>();
      if (!q) return out;
      const RADIUS = 40;
      for (const [pageId, text] of pageText) {
        const at = text.indexOf(q);
        if (at === -1) continue;
        const start = Math.max(0, at - RADIUS);
        const end = Math.min(text.length, at + q.length + RADIUS);
        out.set(pageId, (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''));
      }
      return out;
    },

    setLanguage(next) {
      if (next === lang) return;
      lang = next;
      if (client) {
        client.cancelAll();
        client.setLanguage(next);
      }
      sourceOcr.clear();
      sourceOcrWords.clear();
      ocrQueued.clear();
      ocrQueue.length = 0;
      for (const key of scanned) {
        applySource(key);
        const job = sourceRef.get(key);
        if (job) enqueueOcr(job);
      }
      reportProgress();
      onChange();
    },

    getOcrWords(sourceKey) {
      return sourceOcrWords.get(sourceKey);
    },

    ocrReadySources() {
      const out: string[] = [];
      for (const key of scanned) {
        const words = sourceOcrWords.get(key);
        if (words && words.length > 0) out.push(key);
      }
      return out;
    },

    invalidatePath(path) {
      const prefix = `${path}:`;
      // Every source key we might have an IN-FLIGHT recognize() for — bump its
      // generation so that pass's result is discarded when it lands (it ran
      // against the now-stale raster). Union across every map that could hold
      // a key for this path, so an in-flight-only key (extracted, OCR
      // dispatched, not yet resolved) is covered too.
      const affected = new Set<string>();
      for (const key of pagesBySource.keys()) if (key.startsWith(prefix)) affected.add(key);
      for (const key of sourceRef.keys()) if (key.startsWith(prefix)) affected.add(key);
      for (const key of sourceBorn.keys()) if (key.startsWith(prefix)) affected.add(key);
      for (const job of ocrQueue) if (job.key.startsWith(prefix)) affected.add(job.key);
      for (const key of affected) sourceGen.set(key, genOf(key) + 1);

      let dropped = false;
      for (const key of affected) {
        if (sourceBorn.has(key)) dropped = true;
        sourceBorn.delete(key);
        sourceOcr.delete(key);
        sourceOcrWords.delete(key);
        scanned.delete(key);
        ocrQueued.delete(key);
        const ids = pagesBySource.get(key);
        if (ids) for (const id of ids) pageText.delete(id);
      }
      if (ocrQueue.length > 0) {
        for (let i = ocrQueue.length - 1; i >= 0; i--) {
          if (ocrQueue[i].key.startsWith(prefix)) {
            ocrQueued.delete(ocrQueue[i].key);
            ocrQueue.splice(i, 1);
          }
        }
        reportProgress();
      }
      if (dropped) onChange();
    },


    dispose() {
      ocrQueue.length = 0;
      client?.dispose();
      client = null;
    },
  };
}
