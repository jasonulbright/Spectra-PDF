// Ported from PDFx src/renderer/src/app/useFind.ts (same owner), extended
// with ordered match-page navigation (next/prev + centerOn jumps) — PDFx
// filters its grid; this canvas navigates the camera instead.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchResult } from './engine';
import { EMPTY_RESULT } from './engine';
import type { SearchOptions } from './normalize';
import type { OpenDocument } from '../state/types';

const DEBOUNCE_MS = 150;

export interface Find {
  open: boolean;
  query: string;
  result: SearchResult;
  matchedQuery: string;
  /** The advanced modes (regex/case/whole-word) IN EFFECT for `result` — used
   * by the OCR-word highlighter so its boxes agree with the reported hits. */
  matchedOptions: SearchOptions;
  options: SearchOptions;
  /** Toggle one advanced Find mode. */
  toggleOption: (key: keyof SearchOptions) => void;
  active: boolean;
  /** Match pages in workspace order. */
  matchPages: string[];
  /** Index into matchPages of the current navigation target (-1 = none). */
  current: number;
  setQuery: (query: string) => void;
  openFind: () => void;
  /** Open the bar seeded with a query and (optionally) jump to a page — the
   * Search nav panel drives this so a result click highlights via the same
   * tested find path (Phase 4 M3.3). */
  openWith: (query: string, pageId?: string, options?: SearchOptions) => void;
  closeFind: () => void;
  next: () => void;
  prev: () => void;
}

export function useFind(
  search: (query: string, options?: SearchOptions) => SearchResult,
  version: number,
  docs: OpenDocument[],
  onNavigate: (pageId: string) => void,
): Find {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [matchedQuery, setMatchedQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [matchedOptions, setMatchedOptions] = useState<SearchOptions>({});
  const [current, setCurrent] = useState(-1);

  const active = open && query.trim().length > 0;

  const toggleOption = useCallback((key: keyof SearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Re-run on query OR mode change (a mode toggle must re-search immediately).
  useEffect(() => {
    if (!active) {
      setResult(EMPTY_RESULT);
      setMatchedQuery('');
      setMatchedOptions({});
      setCurrent(-1);
      return;
    }
    const timer = setTimeout(() => {
      setResult(search(query, options));
      setMatchedQuery(query);
      setMatchedOptions(options);
      setCurrent(-1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, query, options, search]);

  // Re-run when the index grows (OCR results landing) without resetting the
  // user's navigation position.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      setResult(search(query, options));
      setMatchedQuery(query);
      setMatchedOptions(options);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const matchPages = useMemo(() => {
    if (result.pageIds.size === 0) return [];
    const ordered: string[] = [];
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (result.pageIds.has(page.id)) ordered.push(page.id);
      }
    }
    return ordered;
  }, [result, docs]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (matchPages.length === 0) return;
      setCurrent((prev) => {
        const next = prev < 0 ? (delta === 1 ? 0 : matchPages.length - 1) : (prev + delta + matchPages.length) % matchPages.length;
        onNavigate(matchPages[next]);
        return next;
      });
    },
    [matchPages, onNavigate],
  );

  const openFind = useCallback(() => setOpen(true), []);
  const openWith = useCallback(
    (q: string, pageId?: string, opts?: SearchOptions) => {
      setOpen(true);
      setQuery(q);
      if (opts) setOptions(opts); // adopt the Search panel's modes so highlights agree
      if (pageId) onNavigate(pageId);
    },
    [onNavigate],
  );
  const closeFind = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  return { open, query, result, matchedQuery, matchedOptions, options, toggleOption, active, matchPages, current, setQuery, openFind, openWith, closeFind, next, prev };
}
