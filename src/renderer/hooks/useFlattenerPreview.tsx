import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { showableDocuments } from '../state/selectors';
import { useEngine } from './useEngine';
import { app } from '../lib/tauri-bridge';
import {
  DEFAULT_FLATTEN_BALANCE,
  DEFAULT_FLATTEN_DPI,
  FLATTEN_CATEGORIES,
  NO_OUTLINES,
  clampBalance,
  clampDpi,
  highlightRects,
  outlinesArmed,
  pageReport,
  type FlattenCategory,
  type FlattenReport,
  type HighlightRect,
  type OutlineOptions,
  type OutlineReport,
} from '../lib/flattener';

/**
 * The flattener preview's live state.
 *
 * The classification is a READ: it says which objects a flatten at the chosen
 * balance would rasterize, before anything is rewritten. Everything that
 * decides what to draw lives in `lib/flattener.ts`; this holds the engine call
 * and the armed mode.
 *
 * It is a mode for the same reason the separation preview is one — a highlight
 * left armed by a closed tool would go silently live on the next document, and
 * routing through `openTool` is what disarms it.
 */
export interface FlattenerPreviewValue {
  armed: boolean;
  setArmed: (armed: boolean) => void;
  report: FlattenReport | null;
  balance: number;
  setBalance: (balance: number) => void;
  dpi: number;
  setDpi: (dpi: number) => void;
  shown: ReadonlySet<FlattenCategory>;
  toggleCategory: (category: FlattenCategory) => void;
  /** The two outline conversions, and what they would do to this document. */
  outlines: OutlineOptions;
  setOutlines: (options: OutlineOptions) => void;
  outlineReport: OutlineReport | null;
  busy: boolean;
  error: string;
  /** Throw the classification away — an applied flatten is a document change. */
  invalidate: () => void;
  rectsFor: (docId: string, pageId: string) => HighlightRect[];
}

const FlattenerContext = createContext<FlattenerPreviewValue | null>(null);

const NO_RECTS: HighlightRect[] = [];

/** A document id and a page id as one map key. The separator is a character
 *  neither half can contain — a path can hold almost anything else — and it is
 *  written as an escape so the source file stays diffable text. */
function pageKey(docId: string, pageId: string): string {
  return `${docId}\u0000${pageId}`;
}

export function FlattenerPreviewProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { call } = useEngine();

  // Two independent things, and conflating them made the panel unreadable
  // until the marks were switched on: `armed` decides whether the page carries
  // HIGHLIGHTS, `open` decides whether the classification is READ at all. The
  // panel states what a flatten would do the moment it is opened, because that
  // report is what the balance and the apply button are judged from.
  const armed = state.ui.tool === 'flattenpreview';
  const open = state.ui.activeOp === 'flattener' || armed;

  const [report, setReport] = useState<FlattenReport | null>(null);
  const [balance, setBalanceState] = useState(DEFAULT_FLATTEN_BALANCE);
  const [dpi, setDpiState] = useState(DEFAULT_FLATTEN_DPI);
  const [shown, setShown] = useState<ReadonlySet<FlattenCategory>>(
    () => new Set<FlattenCategory>(FLATTEN_CATEGORIES),
  );
  const [outlines, setOutlines] = useState<OutlineOptions>(NO_OUTLINES);
  const [outlineReport, setOutlineReport] = useState<OutlineReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);

  const documents = showableDocuments(state);

  const setArmed = useCallback(
    (next: boolean) => {
      dispatch({ type: 'UI_SET_TOOL', tool: next ? 'flattenpreview' : 'select' });
    },
    [dispatch],
  );

  const setBalance = useCallback((value: number) => setBalanceState(clampBalance(value)), []);
  const setDpi = useCallback((value: number) => setDpiState(clampDpi(value)), []);

  const toggleCategory = useCallback((category: FlattenCategory) => {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const invalidate = useCallback(() => {
    setReport(null);
    setOutlineReport(null);
    setGeneration((n) => n + 1);
  }, []);

  // The document whose pages the panel classifies: the one the reading view is
  // in. A composed document's pages can come from several files, so the
  // classification is keyed to the ACTIVE file's own path and page numbers.
  const activeFile = state.activeFileId !== null ? state.files.get(state.activeFileId) : undefined;
  const sourcePath = activeFile?.workingPath ?? '';

  useEffect(() => {
    if (!open || !sourcePath) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setError('');
      try {
        // A read of the working file, so it goes through the GATED call: the
        // preview describes the document as it will flatten, which means the
        // bytes on disk must already carry the pending page edits.
        const res = await call('list_transparency', {
          file: sourcePath,
          balance,
          dpi,
        });
        if (!cancelled) setReport(res as unknown as FlattenReport);
      } catch (e: unknown) {
        if (!cancelled) {
          setReport(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sourcePath, balance, dpi, generation, call]);

  // The conversion report is its own read, and it runs only when one of the
  // two options is armed: it opens every font in the document, which is work
  // no flatten that is not converting anything should pay for.
  const armedOutlines = outlinesArmed(outlines);
  useEffect(() => {
    if (!open || !sourcePath || !armedOutlines) {
      setOutlineReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_outlines', {
          file: sourcePath,
          font_dir: await app.getEditFontPath(),
        });
        if (!cancelled) setOutlineReport(res as unknown as OutlineReport);
      } catch (e: unknown) {
        if (!cancelled) {
          setOutlineReport(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sourcePath, armedOutlines, generation, call]);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setOutlineReport(null);
      setError('');
    }
  }, [open]);

  // Every showable page, resolved to the 1-based page number in the file the
  // report describes. A page from another file has no entry, so its highlight
  // set is empty rather than another file's.
  const pageNumbers = useMemo(() => {
    const out = new Map<string, number>();
    if (state.activeFileId === null) return out;
    for (const doc of documents) {
      for (const page of doc.pages) {
        if (page.sourceDocId !== state.activeFileId) continue;
        out.set(pageKey(doc.id, page.id), page.sourcePageIndex + 1);
      }
    }
    return out;
  }, [documents, state.activeFileId]);

  const rectsFor = useCallback(
    (docId: string, pageId: string): HighlightRect[] => {
      if (!armed || !report) return NO_RECTS;
      const number = pageNumbers.get(pageKey(docId, pageId));
      if (number === undefined) return NO_RECTS;
      return highlightRects(pageReport(report, number), shown);
    },
    [armed, report, pageNumbers, shown],
  );

  const value = useMemo<FlattenerPreviewValue>(
    () => ({
      armed, setArmed, report, balance, setBalance, dpi, setDpi, shown,
      toggleCategory, outlines, setOutlines, outlineReport, busy, error,
      invalidate, rectsFor,
    }),
    [armed, setArmed, report, balance, setBalance, dpi, setDpi, shown,
      toggleCategory, outlines, outlineReport, busy, error, invalidate,
      rectsFor],
  );

  return <FlattenerContext.Provider value={value}>{children}</FlattenerContext.Provider>;
}

/** The preview's state, for the panel. */
export function useFlattenerPreview(): FlattenerPreviewValue {
  const value = useContext(FlattenerContext);
  if (!value) throw new Error('the flattener preview is read outside its provider');
  return value;
}

/** The highlight rectangles for one page, empty when nothing is armed.
 *  Returns empty outside the provider: the canvas also renders in surfaces the
 *  provider does not wrap. */
export function useFlattenerRegions(docId: string, pageId: string): HighlightRect[] {
  const value = useContext(FlattenerContext);
  return value ? value.rectsFor(docId, pageId) : NO_RECTS;
}
