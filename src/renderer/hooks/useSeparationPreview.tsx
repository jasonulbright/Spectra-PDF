import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { showableDocuments } from '../state/selectors';
import { useEngine } from './useEngine';
import { batch as batchBridge } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import {
  DEFAULT_TAC_LIMIT,
  clampLimit,
  compositeRequest,
  plateCacheKey,
  prunePlateCache,
  previewDpi,
  aliasIsAllowed,
  moveInSequence,
  orderInks,
  type CacheEntry,
  type CompositeResult,
  type Ink,
  type InkAliases,
  type Plate,
  type PlateSet,
} from '../lib/separation-preview';

/**
 * The separation preview's live state.
 *
 * The pages around the one being read raster through the separation device
 * and stand in for the viewer's own raster while the mode is armed — no RGB
 * device simulates overprint and none can show a single plate, so the preview
 * owns a raster path. Everything that DECIDES what to show lives in
 * `lib/separation-preview.ts`; this holds the engine calls, the plate cache
 * and the object URLs.
 */
export interface SeparationPreviewValue {
  armed: boolean;
  setArmed: (armed: boolean) => void;
  /** The document's whole colorant inventory, including `/All` and `/None`. */
  inks: Ink[];
  /** The plates the current page actually rasterized to — the toggle list. */
  plates: Plate[];
  coverage: Record<string, number>;
  hidden: ReadonlySet<string>;
  toggleInk: (name: string) => void;
  showAllInks: () => void;
  hideAllInks: () => void;
  densities: ReadonlyMap<string, number>;
  setDensity: (name: string, density: number) => void;
  /** Preview aliases: which ink each colorant is DRAWN as. The document is
   *  untouched — the applied alias is the Ink Manager's own door. */
  aliases: InkAliases;
  setAlias: (source: string, target: string | null) => void;
  /** Print sequence — an application setting, not a document key. It orders
   *  the plate list and the compositing. */
  sequence: readonly string[];
  moveInk: (name: string, delta: number) => void;
  limitPct: number;
  setLimitPct: (limit: number) => void;
  alarm: boolean;
  setAlarm: (on: boolean) => void;
  overprint: boolean;
  setOverprint: (on: boolean) => void;
  stats: CompositeResult | null;
  busy: boolean;
  error: string;
  /** Throw the plate cache away. A document change invalidates every plate;
   *  an applied ink edit is a document change. */
  invalidate: () => void;
  rasterFor: (docId: string, pageId: string) => string | null;
}

const PreviewContext = createContext<SeparationPreviewValue | null>(null);

interface RasterEntry {
  url: string;
  docId: string;
  pageId: string;
}

/** The page being read, plus one either side — the window a scroll walks. */
const NEIGHBOURHOOD = 1;

interface WantedPage {
  docId: string;
  pageId: string;
  sourcePath: string;
  pageNumber: number;
  dpi: number;
  current: boolean;
}

export function SeparationPreviewProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { call, callRaw } = useEngine();

  const armed = state.ui.tool === 'outputpreview';

  const [inks, setInks] = useState<Ink[]>([]);
  const [plates, setPlates] = useState<Plate[]>([]);
  const [coverage, setCoverage] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [densities, setDensities] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [aliases, setAliases] = useState<InkAliases>(() => new Map());
  const [sequence, setSequence] = useState<readonly string[]>([]);
  const [limitPct, setLimitPctState] = useState(DEFAULT_TAC_LIMIT);
  const [alarm, setAlarm] = useState(false);
  const [overprint, setOverprint] = useState(true);
  const [stats, setStats] = useState<CompositeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [rasters, setRasters] = useState<readonly RasterEntry[]>([]);

  const plateCache = useRef(new Map<string, CacheEntry<PlateSet>>());
  const rasterRef = useRef(new Map<string, RasterEntry>());

  const publish = useCallback(() => setRasters([...rasterRef.current.values()]), []);

  const releaseAll = useCallback(() => {
    for (const entry of rasterRef.current.values()) URL.revokeObjectURL(entry.url);
    rasterRef.current.clear();
    setRasters([]);
  }, []);

  const invalidate = useCallback(() => {
    plateCache.current.clear();
    releaseAll();
    setPlates([]);
    setCoverage({});
    setStats(null);
    setGeneration((n) => n + 1);
  }, [releaseAll]);

  const documents = showableDocuments(state);
  const currentPageId = state.ui.currentPageId;

  // Prune anything keyed by a page the workspace no longer has. Synchronous
  // and before the render effect's first await: a page id is
  // generation-tagged, so an entry under a retired id can never re-bind and
  // would otherwise show one page's separations under another's.
  const livePageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const doc of documents) for (const page of doc.pages) ids.add(page.id);
    return ids;
  }, [documents]);
  for (const key of prunePlateCache(plateCache.current, livePageIds)) {
    const entry = rasterRef.current.get(key);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      rasterRef.current.delete(key);
    }
  }

  // The pages to raster: the one being read and its neighbours, each resolved
  // to the file its bytes come from (a composed document's pages need not
  // share one source).
  const wanted = useMemo<WantedPage[]>(() => {
    if (!armed) return [];
    let doc = documents.find((d) => d.pages.some((p) => p.id === currentPageId));
    let centre = doc ? doc.pages.findIndex((p) => p.id === currentPageId) : 0;
    if (!doc) {
      doc = documents[0];
      centre = 0;
    }
    if (!doc) return [];
    const out: WantedPage[] = [];
    for (let i = centre - NEIGHBOURHOOD; i <= centre + NEIGHBOURHOOD; i += 1) {
      const page = doc.pages[i];
      if (!page) continue;
      const source = state.files.get(page.sourceDocId);
      if (!source) continue;
      out.push({
        docId: doc.id,
        pageId: page.id,
        sourcePath: source.workingPath,
        pageNumber: page.sourcePageIndex + 1,
        dpi: previewDpi(page.width, page.height),
        current: i === centre,
      });
    }
    return out;
  }, [armed, documents, currentPageId, state.files]);

  const inventoryPath = wanted.find((w) => w.current)?.sourcePath ?? '';
  const wantedKey = wanted.map((w) => `${w.pageId}:${w.dpi}`).join('|');

  const setLimitPct = useCallback((value: number) => setLimitPctState(clampLimit(value)), []);

  const setArmed = useCallback(
    (next: boolean) => {
      dispatch({ type: 'UI_SET_TOOL', tool: next ? 'outputpreview' : 'select' });
    },
    [dispatch],
  );

  const toggleInk = useCallback((name: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const showAllInks = useCallback(() => setHidden(new Set<string>()), []);
  const hideAllInks = useCallback(() => {
    setHidden(new Set(plates.map((p) => p.name)));
  }, [plates]);

  const setDensity = useCallback((name: string, density: number) => {
    setDensities((prev) => new Map(prev).set(name, density));
  }, []);

  const moveInk = useCallback((name: string, delta: number) => {
    setSequence((prev) => moveInSequence(prev, name, delta));
  }, []);

  const setAlias = useCallback((source: string, target: string | null) => {
    setAliases((prev) => {
      const next = new Map(prev);
      if (target === null) next.delete(source);
      else if (aliasIsAllowed(prev, source, target)) next.set(source, target);
      return next;
    });
  }, []);

  // The ink inventory. A read of the working file, so it runs through the
  // GATED call: the preview shows the document as it will print, which means
  // the bytes on disk must already carry the pending page edits.
  useEffect(() => {
    if (!armed || !inventoryPath) {
      setInks([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_inks', { file: inventoryPath });
        if (!cancelled) setInks((res as unknown as { inks?: Ink[] }).inks ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armed, inventoryPath, generation, call]);

  // Raster and composite the wanted pages. Plates cache per page, resolution
  // and overprint, so an ink toggle re-composites and never re-runs the
  // device.
  useEffect(() => {
    if (!armed || wanted.length === 0) return;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setError('');
      try {
        const gsPath = await ensureGsPath();
        for (const target of wanted) {
          if (cancelled) return;
          const key = plateCacheKey(target.docId, target.pageId, target.dpi, overprint);
          let set = plateCache.current.get(key)?.value;
          if (!set) {
            const res = await call('render_separations', {
              file: target.sourcePath,
              page: target.pageNumber,
              dpi: target.dpi,
              gs_path: gsPath,
              overprint,
            });
            if (cancelled) return;
            if (!livePageIds.has(target.pageId)) continue;
            set = res as unknown as PlateSet;
            plateCache.current.set(key, { pageId: target.pageId, value: set });
          }
          if (target.current) {
            setPlates(set.plates);
            setCoverage(set.coverage ?? {});
            setSequence((prev) => {
              const known = new Set(prev);
              const added = set!.plates.map((p) => p.name).filter((n) => !known.has(n));
              return added.length > 0 ? [...prev, ...added] : prev;
            });
          }
          // Compositing touches no PDF — it reads the cached plates. It stays
          // off the gated path deliberately: gating it would commit the
          // user's pending page edits on every ink checkbox.
          const composite = (await callRaw('composite_separations', {
            dir: set.dir,
            inks: compositeRequest(orderInks(set.plates, sequence), hidden, densities, aliases),
            limit_pct: limitPct,
            alarm,
          })) as unknown as CompositeResult;
          if (cancelled) return;
          if (target.current) setStats(composite);
          const bytes = await batchBridge.readFileBuffer(composite.png);
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
          const previous = rasterRef.current.get(key);
          if (previous) URL.revokeObjectURL(previous.url);
          rasterRef.current.set(key, { url, docId: target.docId, pageId: target.pageId });
          publish();
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `wantedKey` stands for the page window: the array's identity changes on
    // every state tick and would restart the run for the same pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, wantedKey, overprint, hidden, densities, aliases, sequence, limitPct, alarm, generation]);

  // Leaving the mode drops the images. The viewer's own raster was never
  // overwritten, so the page comes back with no re-render.
  useEffect(() => {
    if (!armed) {
      releaseAll();
      setStats(null);
    }
  }, [armed, releaseAll]);

  useEffect(() => releaseAll, [releaseAll]);

  const rasterFor = useCallback(
    (docId: string, pageId: string): string | null => {
      if (!armed) return null;
      const hit = rasters.find((r) => r.docId === docId && r.pageId === pageId);
      return hit ? hit.url : null;
    },
    [armed, rasters],
  );

  const value = useMemo<SeparationPreviewValue>(
    () => ({
      armed, setArmed, inks, plates, coverage, hidden, toggleInk, showAllInks, hideAllInks,
      densities, setDensity, aliases, setAlias, sequence, moveInk, limitPct, setLimitPct,
      alarm, setAlarm, overprint, setOverprint, stats, busy, error, invalidate, rasterFor,
    }),
    [armed, setArmed, inks, plates, coverage, hidden, toggleInk, showAllInks, hideAllInks,
      densities, setDensity, aliases, setAlias, sequence, moveInk, limitPct, setLimitPct,
      alarm, overprint, stats, busy, error, invalidate, rasterFor],
  );

  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

/** The preview's state, for the panel. */
export function useSeparationPreview(): SeparationPreviewValue {
  const value = useContext(PreviewContext);
  if (!value) throw new Error('the separation preview is read outside its provider');
  return value;
}

/** The separation raster for one page, or null when nothing stands in for the
 *  viewer's own. Returns null outside the provider: the canvas also renders
 *  in surfaces the provider does not wrap. */
export function useSeparationRaster(docId: string, pageId: string): string | null {
  const value = useContext(PreviewContext);
  return value ? value.rasterFor(docId, pageId) : null;
}
