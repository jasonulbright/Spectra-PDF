// Ported from PDFx src/renderer/src/search/useSearchIndex.ts (same owner),
// adapted: reconcile takes the proxies map, and a buffer-identity watcher
// invalidates a file's cached text/OCR whenever its bytes change underneath
// (commit, whole-file op, undo, OCR-apply itself) — the same invalidation
// signal redaction marks and signature placements key on.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSearchEngine, type SearchEngine, type SearchResult } from './engine';
import type { SearchOptions } from './normalize';
import { DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import type { OcrWord } from '../ocr/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, OpenFile, PdfBuffer } from '../state/types';

export type { SearchResult } from './engine';
export type { SearchOptions } from './normalize';
export { sourceKeyOf } from './engine';

export interface SearchIndex {
  /** Async: regex-mode scans run in a time-budgeted worker (see engine.ts). */
  search: (query: string, options?: SearchOptions) => Promise<SearchResult>;
  snippetsFor: (query: string, options?: SearchOptions) => Promise<Map<string, string>>;
  version: number;
  ocrRemaining: number;
  hasScanned: boolean;
  ocrLanguage: string;
  setOcrLanguage: (lang: string) => void;
  getOcrWords: (sourceKey: string) => OcrWord[] | undefined;
  ocrReadySources: () => string[];
}

export function useSearchIndex(
  docs: OpenDocument[],
  proxies: Map<string, PDFDocumentProxy>,
  files: ReadonlyMap<string, OpenFile>,
): SearchIndex {
  const [version, setVersion] = useState(0);
  const [ocrRemaining, setOcrRemaining] = useState(0);
  const [hasScanned, setHasScanned] = useState(false);
  const [ocrLanguage, setOcrLanguageState] = useState(DEFAULT_OCR_LANGUAGE);

  const docsRef = useRef(docs);
  docsRef.current = docs;

  const engineRef = useRef<SearchEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createSearchEngine({
      onChange: () => setVersion((v) => v + 1),
      onProgress: (remaining, scanned) => {
        setOcrRemaining(remaining);
        setHasScanned(scanned);
      },
      getDocs: () => docsRef.current,
    });
  }
  const engine = engineRef.current;

  // Buffer-identity invalidation BEFORE reconcile, so a mutated file's pages
  // re-extract instead of serving stale text.
  const lastBuffersRef = useRef<Map<string, PdfBuffer | null>>(new Map());
  useEffect(() => {
    const current = new Map<string, PdfBuffer | null>();
    for (const [path, f] of files) current.set(path, f.buffer);
    const prev = lastBuffersRef.current;
    lastBuffersRef.current = current;
    for (const [path, buf] of current) {
      if (prev.has(path) && prev.get(path) !== buf) engine.invalidatePath(path);
    }
    for (const path of prev.keys()) {
      if (!current.has(path)) engine.invalidatePath(path);
    }
  }, [files, engine]);

  useEffect(() => {
    engine.reconcile(docs, proxies);
  }, [docs, proxies, engine]);

  useEffect(() => {
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [engine]);

  const search = useCallback(
    (query: string, options?: SearchOptions) => engine.search(query, options),
    [engine],
  );
  const snippetsFor = useCallback(
    (query: string, options?: SearchOptions) => engine.snippetsFor(query, options),
    [engine],
  );
  const getOcrWords = useCallback((sourceKey: string) => engine.getOcrWords(sourceKey), [engine]);
  const ocrReadySources = useCallback(() => engine.ocrReadySources(), [engine]);

  const setOcrLanguage = useCallback(
    (lang: string) => {
      setOcrLanguageState(lang);
      engine.setLanguage(lang);
    },
    [engine],
  );

  return {
    search,
    snippetsFor,
    version,
    ocrRemaining,
    hasScanned,
    ocrLanguage,
    setOcrLanguage,
    getOcrWords,
    ocrReadySources,
  };
}
