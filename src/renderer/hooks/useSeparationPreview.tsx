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
import { app, batch as batchBridge, dialog } from '../lib/tauri-bridge';
import { requireGsPath } from '../lib/gs-capability';
import {
  DEFAULT_TAC_LIMIT,
  clampLimit,
  compositeRequest,
  plateCacheKey,
  plateProfileComponent,
  prunePlateCache,
  previewDpi,
  aliasIsAllowed,
  moveInSequence,
  inspectPointToPdf,
  readInspection,
  readInventory,
  readSimulation,
  readSimulationProfiles,
  resolveSimulationSource,
  simulationRequest,
  type CacheEntry,
  type CompositeResult,
  type Ink,
  type InkAliases,
  type Inspection,
  type Plate,
  type PlateSet,
  type SimulationProfiles,
  type SimulationRecord,
  type SimulationSource,
} from '../lib/separation-preview';
import { getDocumentProxy } from '../lib/pdfDocCache';

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
  /** What the engine could NOT read while taking that inventory, as engine
   *  messages. Non-empty means a spot may be missing from `plates` and from
   *  every figure measured over them, so the panel says so rather than
   *  presenting the short list as the page's whole ink set. */
  inkUnknown: string[];
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
  /** The press profiles this document can be proofed against. */
  simulationProfiles: SimulationProfiles;
  /** The source the panel is ASKING for. What it renders comes from
   *  `simulation`, which is what the engine says it used. */
  simulationSource: SimulationSource;
  setSimulationSource: (source: SimulationSource) => void;
  /** Which installed press a `bundled` proof runs through, by ICC description
   *  string; empty is the default press. */
  simulationPress: string;
  setSimulationPress: (name: string) => void;
  /** Open the picker and proof through the chosen file. The path goes
   *  straight to the engine — the webview never reads the profile bytes. */
  pickSimulationProfile: () => Promise<void>;
  simulationProfilePath: string;
  paperWhite: boolean;
  setPaperWhite: (on: boolean) => void;
  /** The user's own black-ink choice. Simulating paper white forces the
   *  switch on without overwriting this, so turning paper white off restores
   *  it. */
  blackInk: boolean;
  setBlackInk: (on: boolean) => void;
  /** What the engine says it PROOFED THROUGH, or null while nothing has
   *  answered yet. Never the request: an unhonoured request must not be able
   *  to look honoured. */
  simulation: SimulationRecord | null;
  stats: CompositeResult | null;
  busy: boolean;
  error: string;
  /** Throw the plate cache away. A document change invalidates every plate;
   *  an applied ink edit is a document change. */
  invalidate: () => void;
  rasterFor: (docId: string, pageId: string) => Blob | null;
  /** What the last clicked point resolved to, or null when nothing has been
   *  asked yet. Null is also what an answer the panel could not read comes
   *  back as — never an empty object list, which is a measurement. */
  inspection: Inspection | null;
  inspectBusy: boolean;
  inspectError: string;
  /** Ask what is under one display-normalized point of a page. `viewRotation`
   *  is the canvas's own view-only turn; the page's baked rotation and its
   *  view box are resolved here, so the caller never converts coordinates. */
  inspectAt: (
    docId: string,
    pageId: string,
    u: number,
    v: number,
    viewRotation: number,
  ) => void;
  clearInspection: () => void;
}

/** What one page's last raster left behind for a point query. */
interface InspectTarget {
  sourcePath: string;
  pageNumber: number;
  dir: string;
  plates: Plate[];
}

const PreviewContext = createContext<SeparationPreviewValue | null>(null);

interface RasterEntry {
  /** The composite as the engine wrote it. Held as a BLOB, never an object
   *  URL: the canvas decodes it with `createImageBitmap`, which is the only
   *  decode path this webview honours (see `raster.ts`), and a blob owns no
   *  lifetime there is a revoke to get wrong. */
  image: Blob;
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

  const NO_PROFILES: SimulationProfiles = useMemo(
    () => ({
      document: { present: false, embedded: false, identifier: '', name: '' },
      bundled: { present: false, name: '', default: '', names: [] },
    }),
    [],
  );

  const [inks, setInks] = useState<Ink[]>([]);
  const [inkUnknown, setInkUnknown] = useState<string[]>([]);
  const [families, setFamilies] = useState<readonly string[]>(['']);
  const [simulationProfiles, setSimulationProfiles] = useState<SimulationProfiles>(NO_PROFILES);
  const [simulationSource, setSimulationSource] = useState<SimulationSource>('none');
  const [simulationProfilePath, setSimulationProfilePath] = useState('');
  // Which installed press a `bundled` proof runs through, by ICC description
  // string. Empty is the default press, so a panel that never offers the
  // picker still proofs through a NAMED press.
  const [simulationPress, setSimulationPress] = useState('');
  const [paperWhite, setPaperWhite] = useState(false);
  const [blackInk, setBlackInk] = useState(false);
  const [simulation, setSimulation] = useState<SimulationRecord | null>(null);
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

  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectError, setInspectError] = useState('');

  const plateCache = useRef(new Map<string, CacheEntry<PlateSet>>());
  const rasterRef = useRef(new Map<string, RasterEntry>());
  // The plate set each page last rastered to, so a click reads the same
  // plates the composite under the pointer was drawn from.
  const inspectRef = useRef(new Map<string, InspectTarget>());
  // The click a request was issued for. A later click supersedes an earlier
  // one: the answers can arrive out of order, and the readout must be the
  // point the user is looking at rather than whichever engine call finished
  // last.
  const inspectSeq = useRef(0);

  const publish = useCallback(() => setRasters([...rasterRef.current.values()]), []);

  const releaseAll = useCallback(() => {
    rasterRef.current.clear();
    inspectRef.current.clear();
    setRasters([]);
  }, []);

  const clearInspection = useCallback(() => {
    inspectSeq.current += 1;
    setInspection(null);
    setInspectError('');
    setInspectBusy(false);
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
    rasterRef.current.delete(key);
  }
  for (const pageId of [...inspectRef.current.keys()]) {
    if (!livePageIds.has(pageId)) inspectRef.current.delete(pageId);
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
      setInkUnknown([]);
      setFamilies(['']);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_inks', { file: inventoryPath });
        if (cancelled) return;
        const inventory = readInventory(res);
        setInks(inventory.inks);
        setInkUnknown(inventory.unknown);
        setFamilies(inventory.color_families);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armed, inventoryPath, generation, call]);

  // Which presses this document can be proofed against, and which one the
  // panel opens on. A read of the working file, so it runs through the GATED
  // call for the same reason the inventory does.
  useEffect(() => {
    if (!armed || !inventoryPath) {
      setSimulationProfiles(NO_PROFILES);
      setSimulationSource('none');
      setSimulationProfilePath('');
      setSimulation(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const gsPath = await requireGsPath();
        const res = await call('list_simulation_profiles', {
          file: inventoryPath,
          gs_path: gsPath,
          icc_dir: await app.getIccPath(),
        });
        if (cancelled) return;
        const offered = readSimulationProfiles(res);
        setSimulationProfiles(offered);
        setSimulationProfilePath('');
        setSimulationPress('');
        setSimulationSource(
          resolveSimulationSource({
            document: offered.document.embedded,
            picked: false,
            bundled: false,
          }),
        );
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armed, inventoryPath, generation, call, NO_PROFILES]);

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
        const gsPath = await requireGsPath();
        // A field carrying no appearance rasters through the device's own
        // synthesis without these, so the plates would show a value the
        // document does not state.
        const fontDir = await app.getEditFontPath();
        const iccDir = await app.getIccPath();
        const request = simulationRequest(
          simulationSource,
          simulationSource === 'bundled' ? simulationPress : simulationProfilePath,
          paperWhite,
          blackInk,
        );
        // A profile change is a re-raster and a switch flip is only a
        // re-composite: the separation device ignores the destination
        // profile, so the plates move with the profile only where the page
        // has to be colour-managed before it is separated.
        const profileComponent = plateProfileComponent(request, families);
        for (const target of wanted) {
          if (cancelled) return;
          const key = plateCacheKey(
            target.docId, target.pageId, target.dpi, overprint, profileComponent,
          );
          let set = plateCache.current.get(key)?.value;
          if (!set) {
            const res = await call('render_separations', {
              file: target.sourcePath,
              page: target.pageNumber,
              dpi: target.dpi,
              gs_path: gsPath,
              overprint,
              simulation: request,
              font_dir: fontDir,
              icc_dir: iccDir,
            });
            if (cancelled) return;
            if (!livePageIds.has(target.pageId)) continue;
            set = res as unknown as PlateSet;
            plateCache.current.set(key, { pageId: target.pageId, value: set });
          }
          if (target.current) {
            setPlates(set.plates);
            setCoverage(set.coverage ?? {});
          }
          inspectRef.current.set(target.pageId, {
            sourcePath: target.sourcePath,
            pageNumber: target.pageNumber,
            dir: set.dir,
            plates: set.plates,
          });
          // Compositing reads the cached plates, and the document's own tint
          // transforms only through what the raster already cached beside
          // them. It stays off the gated path deliberately: gating it would
          // commit the user's pending page edits on every ink checkbox.
          const composite = (await callRaw('composite_separations', {
            dir: set.dir,
            inks: compositeRequest(set.plates, hidden, densities, aliases),
            limit_pct: limitPct,
            alarm,
            simulation: request,
            gs_path: gsPath,
            icc_dir: iccDir,
          })) as unknown as CompositeResult;
          if (cancelled) return;
          if (target.current) {
            setStats(composite);
            setSimulation(readSimulation(composite));
          }
          const bytes = await batchBridge.readFileBuffer(composite.png);
          if (cancelled) return;
          rasterRef.current.set(key, {
            image: new Blob([bytes], { type: 'image/png' }),
            docId: target.docId,
            pageId: target.pageId,
          });
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
  }, [armed, wantedKey, overprint, hidden, densities, aliases, limitPct, alarm, generation,
    simulationSource, simulationProfilePath, simulationPress, paperWhite, blackInk, families]);

  // A plate the sequence has never seen joins the end of it, so an ink the
  // document adds is listed rather than silently sorted to the front.
  useEffect(() => {
    setSequence((prev) => {
      const known = new Set(prev);
      const added = plates.map((p) => p.name).filter((name) => !known.has(name));
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, [plates]);

  // Leaving the mode drops the images. The viewer's own raster was never
  // overwritten, so the page comes back with no re-render.
  useEffect(() => {
    if (!armed) {
      releaseAll();
      setStats(null);
      setSimulation(null);
      clearInspection();
    }
  }, [armed, releaseAll, clearInspection]);

  // A re-raster retires the plate set the readout was measured against, so
  // the answer goes with it rather than standing beside a picture it no
  // longer describes.
  useEffect(() => {
    clearInspection();
  }, [wantedKey, overprint, generation, simulationSource, simulationProfilePath,
    simulationPress, paperWhite, blackInk, clearInspection]);

  const inspectAt = useCallback(
    (docId: string, pageId: string, u: number, v: number, viewRotation: number) => {
      const target = inspectRef.current.get(pageId);
      if (!target) return;
      const doc = documents.find((d) => d.id === docId);
      const pageRef = doc?.pages.find((p) => p.id === pageId);
      if (!pageRef) return;
      const source = state.files.get(pageRef.sourceDocId);
      if (!source?.buffer) return;
      const buffer = source.buffer;
      const ticket = (inspectSeq.current += 1);
      setInspectBusy(true);
      setInspectError('');
      void (async () => {
        try {
          const proxy = await getDocumentProxy(pageRef.sourceDocId, buffer);
          const p = await proxy.getPage(pageRef.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          const [x, y] = inspectPointToPdf(
            u,
            v,
            viewRotation,
            { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            (p.rotate + pageRef.rotation) % 360,
          );
          const gsPath = await requireGsPath();
          const res = await call('inspect_point', {
            file: target.sourcePath,
            page: target.pageNumber,
            x,
            y,
            plates: target.plates,
            plates_dir: target.dir,
            gs_path: gsPath,
          });
          if (inspectSeq.current !== ticket) return;
          setInspection(readInspection(res));
        } catch (e: unknown) {
          if (inspectSeq.current !== ticket) return;
          setInspection(null);
          setInspectError(e instanceof Error ? e.message : String(e));
        } finally {
          if (inspectSeq.current === ticket) setInspectBusy(false);
        }
      })();
    },
    [call, documents, state.files],
  );

  useEffect(() => releaseAll, [releaseAll]);

  const rasterFor = useCallback(
    (docId: string, pageId: string): Blob | null => {
      if (!armed) return null;
      const hit = rasters.find((r) => r.docId === docId && r.pageId === pageId);
      return hit ? hit.image : null;
    },
    [armed, rasters],
  );

  const pickSimulationProfile = useCallback(async () => {
    const picked = await dialog.pickIccFile();
    if (!picked) return;
    setSimulationProfilePath(picked);
    setSimulationSource('file');
  }, []);

  const value = useMemo<SeparationPreviewValue>(
    () => ({
      armed, setArmed, inks, inkUnknown, plates, coverage, hidden, toggleInk, showAllInks,
      hideAllInks, densities, setDensity, aliases, setAlias, sequence, moveInk, limitPct,
      setLimitPct, alarm, setAlarm, overprint, setOverprint, simulationProfiles,
      simulationSource, setSimulationSource, pickSimulationProfile, simulationProfilePath,
      simulationPress, setSimulationPress,
      paperWhite, setPaperWhite, blackInk, setBlackInk, simulation, stats, busy, error,
      invalidate, rasterFor, inspection, inspectBusy, inspectError, inspectAt,
      clearInspection,
    }),
    [armed, setArmed, inks, inkUnknown, plates, coverage, hidden, toggleInk, showAllInks,
      hideAllInks, densities, setDensity, aliases, setAlias, sequence, moveInk, limitPct,
      setLimitPct, alarm, overprint, simulationProfiles, simulationSource,
      pickSimulationProfile, simulationProfilePath, simulationPress, paperWhite, blackInk,
      simulation,
      stats, busy, error, invalidate, rasterFor, inspection, inspectBusy, inspectError,
      inspectAt, clearInspection],
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
export function useSeparationRaster(docId: string, pageId: string): Blob | null {
  const value = useContext(PreviewContext);
  return value ? value.rasterFor(docId, pageId) : null;
}

/** The point query, for the canvas, or null where the provider does not wrap
 *  the surface. */
export function useSeparationInspector(): SeparationPreviewValue['inspectAt'] | null {
  const value = useContext(PreviewContext);
  return value ? value.inspectAt : null;
}
