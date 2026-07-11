// Ported from PDFx src/renderer/src/app/useFind.ts (same owner), extended
// with ordered match-page navigation (next/prev + centerOn jumps) — PDFx
// filters its grid; this canvas navigates the camera instead.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchResult } from './engine';
import { EMPTY_RESULT } from './engine';
import type { OpenDocument } from '../state/types';

const DEBOUNCE_MS = 150;

export interface Find {
  open: boolean;
  query: string;
  result: SearchResult;
  matchedQuery: string;
  active: boolean;
  /** Match pages in workspace order. */
  matchPages: string[];
  /** Index into matchPages of the current navigation target (-1 = none). */
  current: number;
  setQuery: (query: string) => void;
  openFind: () => void;
  closeFind: () => void;
  next: () => void;
  prev: () => void;
}

export function useFind(
  search: (query: string) => SearchResult,
  version: number,
  docs: OpenDocument[],
  onNavigate: (pageId: string) => void,
): Find {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [matchedQuery, setMatchedQuery] = useState('');
  const [current, setCurrent] = useState(-1);

  const active = open && query.trim().length > 0;

  useEffect(() => {
    if (!active) {
      setResult(EMPTY_RESULT);
      setMatchedQuery('');
      setCurrent(-1);
      return;
    }
    const timer = setTimeout(() => {
      setResult(search(query));
      setMatchedQuery(query);
      setCurrent(-1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, query, search]);

  // Re-run when the index grows (OCR results landing) without resetting the
  // user's navigation position.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      setResult(search(query));
      setMatchedQuery(query);
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
  const closeFind = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  return { open, query, result, matchedQuery, active, matchPages, current, setQuery, openFind, closeFind, next, prev };
}
