// The corpus search engine, built on this app's Workspace/OpenDocument/
// PageRef model:
//  - pages carry {id, sourceDocId, sourcePageIndex}; the pdf.js proxy for a
//    source comes from the proxies map (usePdfProxies), not a page-embedded
//    handle — reconcile() takes both and simply skips pages whose proxy
//    hasn't loaded yet (it re-runs when proxies change).
//  - invalidatePath(): this app MUTATES files (commits, whole-file ops,
//    undo, OCR-apply itself) — when a file's buffer identity changes, every
//    per-source cache for that path is stale and must drop. A reader that
//    never rewrites its sources has no equivalent requirement.
// Born-digital extraction, needsOcr detection, OCR queueing/concurrency,
// per-source caching that survives page moves, and normalized occurrence
// counting are all handled here.
import { normalizeIndexText, type SearchOptions } from './normalize';
import { runCorpusSearch } from './search-core';
import {
  createRegexSearchRunner,
  type RegexSearchResult,
  type SearchWorkerFactory,
} from './search-worker-client';
import { extractPageText } from './extract';
import { DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import type { OcrResult, OcrWord } from '../ocr/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument } from '../state/types';

export interface SearchResult {
  pageIds: Set<string>;
  docIds: Set<string>;
  pages: number;
  occurrences: number;
  /** Set when the search couldn't produce results — an uncompilable regex, or
   * a regex whose scan blew the time budget. The UI surfaces it instead of
   * showing a bare "No results". Null for a valid search. */
  error: string | null;
  /** Which kind of failure `error` describes, so the UI can name it correctly
   * ("Invalid pattern" vs "Pattern too slow"). Null when there is no error. */
  errorKind: 'invalid' | 'timeout' | null;
}

export const EMPTY_RESULT: SearchResult = {
  pageIds: new Set(),
  docIds: new Set(),
  pages: 0,
  occurrences: 0,
  error: null,
  errorKind: null,
};

export interface SearchEngine {
  /** `workingPaths` maps a page's `sourceDocId` (which IS the files-map key)
   * to that file's on-disk working copy — what the engine recognizer reads. */
  reconcile: (
    docs: OpenDocument[],
    proxies: Map<string, PDFDocumentProxy>,
    workingPaths: ReadonlyMap<string, string>,
  ) => void;
  /** Async because REGEX-mode scans run in a worker with a time budget (a
   * pathological pattern would otherwise hang the render thread with no
   * cancellation point). Literal / case / whole-word queries are still scanned
   * synchronously and resolve immediately. */
  search: (query: string, options?: SearchOptions) => Promise<SearchResult>;
  /** Per matching page, a short context window around the FIRST match — over
   * the retained normalized page text (the Search panel). Keyed
   * by page id; original case (the index preserves case). Shares the
   * one scan with `search`, so the two can never disagree. */
  snippetsFor: (query: string, options?: SearchOptions) => Promise<Map<string, string>>;
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
  /** Injection seam for the regex search worker (there is no DOM test
   * environment here). Omitted in the app — the default factory builds the
   * real worker, and returns null on a host without `Worker`, in which case
   * the regex scan falls back to the synchronous path. */
  createSearchWorker?: SearchWorkerFactory;
  /** Recognise ONE page through the engine (native Tesseract). Injected rather
   * than imported for the same reason `BatchIo` is: there is no DOM test
   * environment here, and the engine bridge is a React hook. Omitted in tests
   * — the default refuses, so a test that reaches OCR fails loudly instead of
   * silently indexing nothing. */
  recognize?: (path: string, pageIndex: number, lang: string) => Promise<OcrResult>;
}

interface OcrJob {
  key: string;
  pdf: PDFDocumentProxy;
  pageIndex: number;
  /** The on-disk working copy. Recognition is an ENGINE call now (native
   * Tesseract, one recognizer for every surface), and the engine reads a PATH
   * rather than a pdf.js proxy. */
  path: string;
}

const OCR_CONCURRENCY = 2;

export const sourceKeyOf = (page: { sourceDocId: string; sourcePageIndex: number }): string =>
  `${page.sourceDocId}:${page.sourcePageIndex}`;

export function createSearchEngine({
  onChange,
  onProgress,
  getDocs,
  createSearchWorker,
  recognize = () => {
    throw new Error('search engine: no recognizer was injected');
  },
}: EngineCallbacks): SearchEngine {
  const pageText = new Map<string, string>();
  // Bumped on every pageText mutation. The worker holds its own copy of the
  // corpus (so a keystroke ships only the query); this is what tells the
  // client its copy is stale and must be re-seeded.
  let corpusVersion = 0;
  const setPageText = (pageId: string, text: string): void => {
    pageText.set(pageId, text);
    corpusVersion++;
  };
  const dropPageText = (pageId: string): void => {
    if (pageText.delete(pageId)) corpusVersion++;
  };
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
  let lang = DEFAULT_OCR_LANGUAGE;
  let reconcileToken = 0;

  const regexRunner = createRegexSearchRunner(createSearchWorker);
  // One in-flight scan per (query, options, corpus) — `search` and
  // `snippetsFor` are called as a pair by the Search panel and must not run
  // (or, for regex, round-trip to the worker) twice for the same question.
  let scanKey = '';
  let scanPromise: Promise<RegexSearchResult> | null = null;

  function scan(query: string, options: SearchOptions): Promise<RegexSearchResult> {
    const key = `${corpusVersion}\u0000${JSON.stringify(options)}\u0000${query}`;
    if (scanPromise && scanKey === key) return scanPromise;
    const sync = (): RegexSearchResult => ({
      ...runCorpusSearch(pageText, query, options),
      timedOut: false,
    });
    let next: Promise<RegexSearchResult>;
    if (options.regex) {
      // Off-thread, time-budgeted. A null result means no worker could be
      // created (non-browser host) — scan here rather than lose the feature.
      next = regexRunner
        .run(() => [...pageText], corpusVersion, query, options)
        .then((result) => result ?? sync());
    } else {
      next = Promise.resolve(sync());
    }
    scanKey = key;
    scanPromise = next;
    return next;
  }

  const effective = (key: string): string => sourceOcr.get(key) ?? sourceBorn.get(key) ?? '';
  const reportProgress = (): void => onProgress(ocrQueue.length + ocrInFlight, scanned.size > 0);

  function applySource(key: string): void {
    const ids = pagesBySource.get(key);
    if (!ids) return;
    const text = effective(key);
    for (const id of ids) setPageText(id, text);
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
      const jobGen = genOf(job.key); // raster generation this pass ran against
      // Native Tesseract via the engine. `callRaw` (no commit gate) is
      // deliberate and matches what the WASM recognizer did: it rasterised the
      // in-memory buffer, and the working copy's bytes equal that buffer until
      // a commit. Gating here would side-effect-commit the user's pending page
      // edits during a BACKGROUND index.
      recognize(job.path, job.pageIndex, lang)
        .then(({ text, words }) => {
          // Discard if the page closed OR the file's bytes changed under this
          // in-flight pass (stale raster — see sourceGen).
          if (!pagesBySource.has(job.key) || genOf(job.key) !== jobGen) return;
          sourceOcr.set(job.key, normalizeIndexText(text));
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
    jobs: { pageId: string; key: string; pdf: PDFDocumentProxy; pageIndex: number; path: string }[],
    token: number,
  ): Promise<void> {
    for (const job of jobs) {
      if (token !== reconcileToken) return;
      if (sourceBorn.has(job.key)) {
        setPageText(job.pageId, effective(job.key));
        if (scanned.has(job.key) && !ocrQueued.has(job.key)) {
          enqueueOcr({ key: job.key, pdf: job.pdf, pageIndex: job.pageIndex, path: job.path });
        }
        onChange();
        continue;
      }
      try {
        const { text, needsOcr } = await extractPageText(job.pdf, job.pageIndex);
        sourceBorn.set(job.key, normalizeIndexText(text));
        if (needsOcr) {
          scanned.add(job.key);
          reportProgress();
          enqueueOcr({ key: job.key, pdf: job.pdf, pageIndex: job.pageIndex, path: job.path });
        }
        setPageText(job.pageId, effective(job.key));
        onChange();
      } catch (error) {
        console.error(`Failed to index page ${job.pageIndex + 1}`, error);
      }
    }
  }

  return {
    reconcile(docs, proxies, workingPaths) {
      const token = ++reconcileToken;
      const presentPages = new Set<string>();
      const presentKeys = new Set<string>();
      const toExtract: { pageId: string; key: string; pdf: PDFDocumentProxy; pageIndex: number; path: string }[] = [];
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
          const workingPath = workingPaths.get(page.sourceDocId) ?? '';
          if (!sourceRef.has(key)) {
            sourceRef.set(key, { key, pdf, pageIndex: page.sourcePageIndex, path: workingPath });
          }
          if (pageText.has(page.id)) continue;
          if (sourceBorn.has(key)) {
            setPageText(page.id, effective(key));
            changed = true;
            if (scanned.has(key) && !ocrQueued.has(key)) {
              enqueueOcr({ key, pdf, pageIndex: page.sourcePageIndex, path: workingPath });
            }
          } else {
            toExtract.push({ pageId: page.id, key, pdf, pageIndex: page.sourcePageIndex, path: workingPath });
          }
        }
      }

      for (const id of [...pageText.keys()]) {
        if (!presentPages.has(id)) {
          dropPageText(id);
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

    async search(query, options = {}) {
      const { hits, error, timedOut } = await scan(query, options);
      if (error) {
        return {
          ...EMPTY_RESULT,
          pageIds: new Set(),
          docIds: new Set(),
          error,
          errorKind: timedOut ? ('timeout' as const) : ('invalid' as const),
        };
      }
      if (hits.length === 0) return EMPTY_RESULT;
      const pageIds = new Set<string>();
      let occurrences = 0;
      for (const hit of hits) {
        pageIds.add(hit.pageId);
        occurrences += hit.count;
      }
      const docIds = new Set<string>();
      for (const doc of getDocs()) {
        if (doc.pages.some((p) => pageIds.has(p.id))) docIds.add(doc.id);
      }
      return { pageIds, docIds, pages: pageIds.size, occurrences, error: null, errorKind: null };
    },

    async snippetsFor(query, options = {}) {
      const { hits } = await scan(query, options);
      const out = new Map<string, string>();
      for (const hit of hits) out.set(hit.pageId, hit.snippet);
      return out;
    },

    setLanguage(next) {
      if (next === lang) return;
      lang = next;
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
        if (ids) for (const id of ids) dropPageText(id);
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
      regexRunner.dispose();
      scanPromise = null;
    },
  };
}
