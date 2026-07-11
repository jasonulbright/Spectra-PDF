import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { getDocumentProxy } from '../../lib/pdfDocCache';
import { buildRedactionRegions } from '../../lib/redaction';
import type { RedactionMark, RedactionRegion } from '../../lib/redaction';
import { buildSignatureAppearance } from '../../lib/signature-placement';
import type { SignaturePlacement } from '../../lib/signature-placement';
import { useEngine } from '../../hooks/useEngine';
import { dialog } from '../../lib/tauri-bridge';
import { SignerSourceFields, EMPTY_SIGNER_SOURCE, signerSourceParams } from '../SignerSourceFields';
import type { SignerSource } from '../SignerSourceFields';
import { useSearchIndex, sourceKeyOf } from '../../search/useSearchIndex';
import { useFind } from '../../search/useFind';
import { normalizeQuery, highlightWords } from '../../search/normalize';
import { FindBar } from './FindBar';
import { buildOcrApplyPayload } from '../../lib/ocr-apply';
import type { OcrApplyPage } from '../../lib/ocr-apply';
import type { OcrWord } from '../../ocr/types';
import { workspacePageNumber } from '../../lib/workspace-commit';
import { TEST_HARNESS_ENABLED, registerCanvasRedaction, registerCanvasSignature, registerCanvasOcr } from '../../testHarness';
import { ContextMenu } from '../ContextMenu';
import type { MenuItem } from '../ContextMenu';
import { Canvas } from './Canvas';
import { DocLayer } from './DocLayer';
import { HeaderLayer } from './HeaderLayer';
import { AddDocGhost, GhostRow } from './DropGhost';
import { deriveDropGhosts } from './ghost-size';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import type { DragSource } from '../../canvas/usePageDrag';
import type { PageAnnotation, PdfBuffer } from '../../state/types';
import type { CanvasTool, StampPreset } from './PageCell';
import { STAMP_PRESETS, ANNOTATION_PALETTE } from './PageCell';
import { CommentSidebar } from './CommentSidebar';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Open the PageInspector overlay. `pageNumber` is the page's workspace
  // position within its file (== the file's page order once pending edits
  // commit, which the opener does first).
  onInspectPage: (path: string, pageNumber: number) => void;
  // Jump to the extract-text panel with the page pre-selected (same
  // workspace-position numbering; the engine gate commits before reading).
  onExtractText: (path: string, pageNumber: number) => void;
  onApplyChanges: () => void;
  // Run the engine's redact on one file — App routes this through
  // performOperation, so the commit gate flushes pending page edits, a
  // snapshot lands on the undo chain, and the buffer reloads after.
  onRedactFile: (path: string, regions: RedactionRegion[]) => Promise<void>;
  // Persist OCR text layers into one file — same performOperation routing as
  // onRedactFile (gate flush -> snapshot -> engine apply_ocr_layer -> reload).
  onApplyOcrLayer: (path: string, pages: OcrApplyPage[]) => Promise<void>;
}

// Stable empties so the "no pending marks" hot path never breaks the layer
// components' memoization when unrelated state changes.
const NO_MARKS: RedactionMark[] = [];
const NO_MARKS_BY_PAGE: ReadonlyMap<string, RedactionMark[]> = new Map();
const NO_PAGE_IDS: ReadonlySet<string> = new Set();
const NO_WORDS_BY_PAGE: ReadonlyMap<string, OcrWord[]> = new Map();

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,
  onInspectPage,
  onExtractText,
  onApplyChanges,
  onRedactFile,
  onApplyOcrLayer,
}: WorkspaceCanvasViewProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const docs = state.workspace.documents;
  const proxies = usePdfProxies(state.files);
  const layout = useMemo(() => computeLayout(docs), [docs]);
  const canvasRef = useRef<CanvasHandle | null>(null);
  const [selected, setSelected] = useState<DragSource | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string; pageId: string } | null>(
    null,
  );
  const [tool, setTool] = useState<CanvasTool>('select');
  // Color picker for the annotation tools: null keeps each tool's own default
  // (yellow highlight, dark freetext, blue ink); a pick applies to whichever
  // tool creates the next annotation, across tool switches.
  const [toolColor, setToolColor] = useState<string | null>(null);
  const [stampPreset, setStampPreset] = useState<StampPreset | null>(null);
  const [showComments, setShowComments] = useState(false);
  // Pending redaction marks — transient view state, deliberately NOT the
  // page-edit tier (see lib/redaction.ts for why). They survive tool
  // switches and in-memory page edits, and die when their file's buffer
  // changes underneath them or the canvas unmounts.
  const [marks, setMarks] = useState<RedactionMark[]>([]);
  const [confirmRedact, setConfirmRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  // Pending visible-signature placement — single, transient, same lifecycle
  // as redaction marks (see lib/signature-placement.ts).
  const [sigPlacement, setSigPlacement] = useState<SignaturePlacement | null>(null);
  const [sigSource, setSigSource] = useState<SignerSource>(EMPTY_SIGNER_SOURCE);
  const [sigPassword, setSigPassword] = useState('');
  const [sigReason, setSigReason] = useState('');
  const [sigLocation, setSigLocation] = useState('');
  const [signingBusy, setSigningBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signDone, setSignDone] = useState<{ signer: string | null; output: string; ok: boolean } | null>(null);
  const { call: engineCall } = useEngine();
  // Find/OCR (2m): index over the open workspace; Ctrl+F opens the bar.
  const searchIndex = useSearchIndex(docs, proxies, state.files);
  const onFindNavigate = useCallback((pageId: string) => {
    canvasRef.current?.centerOn(pageId);
  }, []);
  const find = useFind(searchIndex.search, searchIndex.version, docs, onFindNavigate);
  const [applyingOcr, setApplyingOcr] = useState(false);
  const [ocrApplyError, setOcrApplyError] = useState<string | null>(null);

  // Escape returns to Select from the highlight tool.
  React.useEffect(() => {
    if (tool === 'select') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTool('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  // Ctrl+F opens Find (2m).
  const openFindRef = useRef(find.openFind);
  openFindRef.current = find.openFind;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFindRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onAddAnnotation = useCallback(
    (docId: string, pageId: string, annotation: PageAnnotation) =>
      dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
    [dispatch],
  );

  const onUpdateAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, note: string) =>
      dispatch({ type: 'UPDATE_ANNOTATION', docId, pageId, annotationId, note }),
    [dispatch],
  );

  const onRecolorAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, color: string) =>
      dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
    [dispatch],
  );

  const onRemoveAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string) =>
      dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
    [dispatch],
  );

  // Marks whose page still exists in the workspace — a deleted page's marks
  // drop out of the count and the apply payload rather than being guessed at.
  const liveMarks = useMemo(() => {
    if (marks.length === 0) return NO_MARKS;
    return marks.filter((m) => docs.some((d) => d.pages.some((p) => p.id === m.pageId)));
  }, [marks, docs]);

  const redactionMarksByPage = useMemo(() => {
    if (liveMarks.length === 0) return NO_MARKS_BY_PAGE;
    const map = new Map<string, RedactionMark[]>();
    for (const m of liveMarks) {
      const arr = map.get(m.pageId);
      if (arr) arr.push(m);
      else map.set(m.pageId, [m]);
    }
    return map;
  }, [liveMarks]);

  const onAddRedactionMark = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      setMarks((prev) => [
        ...prev,
        { id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw },
      ]);
    },
    [docs],
  );

  const onRemoveRedactionMark = useCallback(
    (markId: string) => setMarks((prev) => prev.filter((m) => m.id !== markId)),
    [],
  );

  // Single pending placement — drawing again anywhere replaces it.
  const onSetSignaturePlacement = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      setSigPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setSignDone(null);
      setSignError(null);
    },
    [docs],
  );
  const onClearSignaturePlacement = useCallback(() => setSigPlacement(null), []);

  // Placement whose page still exists (a deleted page's placement is inert,
  // surfaced as such rather than guessed at).
  const liveSigPlacement = useMemo(() => {
    if (!sigPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === sigPlacement.pageId)) ? sigPlacement : null;
  }, [sigPlacement, docs]);

  // Invalidate marks when their file's bytes change underneath them (commit,
  // whole-file op, undo, reopen) or the file closes. PageRef ids are
  // positional (`path#pN`), so after a reindex a surviving mark could bind to
  // a DIFFERENT physical page — for a destructive tool, dropping the marks is
  // the only safe answer. Buffer identity is exactly what the indexer keys
  // on, so this fires precisely when the workspace is about to be rebuilt.
  const lastBuffersRef = useRef<Map<string, PdfBuffer | null>>(new Map());
  useEffect(() => {
    const current = new Map<string, PdfBuffer | null>();
    for (const [path, f] of state.files) current.set(path, f.buffer);
    const prev = lastBuffersRef.current;
    lastBuffersRef.current = current;
    const invalidated = new Set<string>();
    for (const [path, buf] of current) {
      if (prev.has(path) && prev.get(path) !== buf) invalidated.add(path);
    }
    for (const path of prev.keys()) {
      if (!current.has(path)) invalidated.add(path); // closed — a later reopen reuses the same positional ids
    }
    if (invalidated.size > 0) {
      setMarks((prevMarks) => prevMarks.filter((m) => !invalidated.has(m.path)));
      setSigPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
    }
  }, [state.files]);

  // Find overlays: matching pages, and per-word boxes where OCR words exist.
  const findMatchPageIds = find.active ? find.result.pageIds : NO_PAGE_IDS;
  const findWordsByPage = useMemo(() => {
    if (!find.active || find.result.pageIds.size === 0) return NO_WORDS_BY_PAGE;
    if (!normalizeQuery(find.matchedQuery)) return NO_WORDS_BY_PAGE;
    const map = new Map<string, OcrWord[]>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (!find.result.pageIds.has(page.id)) continue;
        const words = searchIndex.getOcrWords(sourceKeyOf(page));
        if (!words) continue;
        // Per-token match (multi-word queries would never match a single
        // whitespace-free OCR word otherwise).
        const hits = highlightWords(words, find.matchedQuery);
        if (hits.length > 0) map.set(page.id, hits);
      }
    }
    return map.size > 0 ? map : NO_WORDS_BY_PAGE;
  }, [find.active, find.result, find.matchedQuery, docs, searchIndex]);

  const ocrReady = searchIndex.ocrReadySources();

  const applyingOcrRef = useRef(false);
  const handleApplyOcr = useCallback(async (): Promise<string[]> => {
    if (applyingOcrRef.current) return [];
    applyingOcrRef.current = true;
    setApplyingOcr(true);
    setOcrApplyError(null);
    try {
      const sources = searchIndex.ocrReadySources();
      const { files: payloads, skippedSources } = await buildOcrApplyPayload(
        docs,
        sources,
        searchIndex.getOcrWords,
        async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        },
      );
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onApplyOcrLayer(payload.path, payload.pages);
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // A source dropped between the ready-snapshot and its turn (page
      // closed/moved, or its OCR invalidated mid-run) must be surfaced, not
      // silently skipped — the user thinks every scanned page was persisted.
      if (skippedSources.length > 0) {
        failures.push(`${skippedSources.length} scanned page(s) skipped (no longer available)`);
      }
      if (payloads.length === 0 && skippedSources.length === 0) {
        failures.push('no OCR-ready pages to apply');
      }
      if (failures.length > 0) {
        setOcrApplyError(`Applying OCR text failed — ${failures.join('; ')}`);
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOcrApplyError(`Applying OCR text failed — ${msg}`);
      return [msg];
    } finally {
      applyingOcrRef.current = false;
      setApplyingOcr(false);
    }
  }, [docs, state.files, searchIndex, onApplyOcrLayer]);

  // Harness bridge (e2e): drive OCR-apply without depending on the FindBar
  // button's async-gated visibility (same pattern as redaction/signature).
  const applyOcrRef = useRef(handleApplyOcr);
  applyOcrRef.current = handleApplyOcr;
  const ocrReadyCountRef = useRef(0);
  ocrReadyCountRef.current = ocrReady.length;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasOcr({
      readyCount: () => ocrReadyCountRef.current,
      apply: () => applyOcrRef.current(),
    });
    return () => registerCanvasOcr(null);
  }, []);

  // Convert every live mark into engine regions and redact file by file.
  // Geometry (crop-intersected box + baked /Rotate) is read from the CURRENT
  // buffer's pdf.js proxy — the same bytes the marks were drawn against; the
  // commit gate then materializes pending page edits before the engine reads
  // the file, so workspace page numbers and composed rotations line up with
  // what lands on disk. Resolves with per-file failure messages (empty =
  // success) — the confirm button surfaces them in the error banner, the test
  // harness rethrows them.
  // Ref, not just state: two clicks in the same tick both read a stale
  // `redacting === false` (same failure mode as the commit-race double-click,
  // see the punchlist's reentrancy tripwire note).
  const applyingRef = useRef(false);
  const applyMarks = useCallback(async (): Promise<string[]> => {
    const toApply = liveMarks;
    if (toApply.length === 0 || applyingRef.current) return [];
    applyingRef.current = true;
    setRedacting(true);
    setRedactError(null);
    try {
      const { files: payloads } = await buildRedactionRegions(docs, toApply, async (page) => {
        const f = state.files.get(page.sourceDocId);
        if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
        const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        return {
          box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
          bakedRotate: p.rotate,
        };
      });
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onRedactFile(payload.path, payload.regions);
          const applied = new Set(payload.markIds);
          setMarks((prev) => prev.filter((m) => !applied.has(m.id)));
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        setRedactError(`Redaction failed — ${failures.join('; ')}. Those marks are still pending.`);
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedactError(`Redaction failed — ${msg}. The marks are still pending.`);
      return [msg];
    } finally {
      applyingRef.current = false;
      setRedacting(false);
    }
  }, [liveMarks, docs, state.files, onRedactFile]);

  // Sign the placement's file, visible stamp at the drawn box. Geometry is
  // read from the CURRENT buffer's proxy (same contract as applyMarks); the
  // engine gate then flushes pending page edits before sign_pdf reads the
  // file, so the output contains what the user sees. The input file itself is
  // NEVER modified — signing writes a new file.
  const signingRef = useRef(false);
  const applySignature = useCallback(async (): Promise<void> => {
    const placement = liveSigPlacement;
    if (!placement || signingRef.current) return;
    // Synchronous validation only above this line. The reentrancy ref MUST be
    // taken before the FIRST await (review-caught; same double-click class as
    // the punchlist's applyMarks tripwire) — a second click during
    // buildSignatureAppearance or the native save dialog would otherwise
    // start an overlapping sign flow.
    const resolved = signerSourceParams(sigSource);
    if (resolved.error) {
      setSignError(resolved.error);
      return;
    }
    if (!sigPassword && sigSource.mode === 'pfx') {
      setSignError('Enter the signer password.');
      return;
    }
    signingRef.current = true;
    setSigningBusy(true);
    setSignError(null);
    try {
      const built = await buildSignatureAppearance(docs, placement, async (page) => {
        const f = state.files.get(page.sourceDocId);
        if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
        const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
      });
      if (!built) {
        setSignError('The page this signature was placed on no longer exists.');
        return;
      }
      const file = state.files.get(built.path);
      if (!file) {
        setSignError('The file this signature was placed on is no longer open.');
        return;
      }
      const baseName = (built.path.split(/[\\/]/).pop() ?? 'document').replace(/\.pdfx?$/i, '');
      const dest = await dialog.saveFile({ defaultPath: `${baseName}-signed.pdf` });
      if (!dest) return; // cancelled — the finally still clears the password
      const res = (await engineCall('sign_pdf', {
        file: file.workingPath,
        output: dest,
        ...resolved.params!,
        password: sigPassword,
        ...(sigReason.trim() ? { reason: sigReason.trim() } : {}),
        ...(sigLocation.trim() ? { location: sigLocation.trim() } : {}),
        appearance: built.appearance,
      })) as unknown as { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean };
      setSignDone({ signer: res.signer, output: res.output, ok: res.valid && res.intact && res.covers_whole_document });
      setSigPlacement(null);
      setTool('select');
    } catch (err) {
      setSignError(err instanceof Error ? err.message : String(err));
    } finally {
      // Clear the secret from state on EVERY exit — success, failure, or a
      // cancelled save dialog (review-caught: a cancel used to strand the
      // typed password in state, pre-filling later unrelated attempts).
      setSigPassword('');
      signingRef.current = false;
      setSigningBusy(false);
    }
  }, [liveSigPlacement, sigSource, sigPassword, sigReason, sigLocation, docs, state.files, engineCall]);

  // Harness bridge (e2e builds only): redaction marks live here, out of the
  // reducer's reach, so the canvas registers its own handlers while mounted.
  // Refs keep the registration stable across renders.
  const applyMarksRef = useRef(applyMarks);
  applyMarksRef.current = applyMarks;
  const harnessAddMarkRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => { markId: string; docId: string; pageId: string } | null
  >(() => null);
  harnessAddMarkRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return null;
    const id = crypto.randomUUID();
    setMarks((prev) => [
      ...prev,
      { id, path: doc.path, pageId: page.id, rect, rotationAtDraw: page.rotation },
    ]);
    return { markId: id, docId: doc.id, pageId: page.id };
  };
  const liveMarksRef = useRef(liveMarks);
  liveMarksRef.current = liveMarks;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasRedaction({
      addMarkToFirstPage: (rect) => harnessAddMarkRef.current(rect),
      apply: () => applyMarksRef.current(),
      clear: () => setMarks([]),
      count: () => liveMarksRef.current.length,
    });
    return () => registerCanvasRedaction(null);
  }, []);

  // Same bridge for the visible-signature placement (rubber band + native
  // dialogs aren't WebDriver-drivable). The harness places on the first page
  // and reads back the CONVERTED appearance via the real conversion path.
  const liveSigRef = useRef(liveSigPlacement);
  liveSigRef.current = liveSigPlacement;
  const harnessPlaceSigRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceSigRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    setSigPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  const harnessBuildSigRef = useRef<
    () => Promise<{ path: string; appearance: { page: number; rect: [number, number, number, number] } } | null>
  >(async () => null);
  harnessBuildSigRef.current = async () => {
    const placement = liveSigPlacement;
    if (!placement) return null;
    return buildSignatureAppearance(docs, placement, async (page) => {
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
      const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
      const p = await proxy.getPage(page.sourcePageIndex + 1);
      const [vx0, vy0, vx1, vy1] = p.view;
      return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
    });
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSignature({
      placeOnFirstPage: (rect) => harnessPlaceSigRef.current(rect),
      buildAppearance: () => harnessBuildSigRef.current(),
      clear: () => setSigPlacement(null),
      has: () => liveSigRef.current != null,
    });
    return () => registerCanvasSignature(null);
  }, []);

  const movePageInto = useCallback(
    (source: DragSource, targetDocId: string, index: number) => {
      dispatch({
        type: 'MOVE_PAGE',
        fromDocId: source.docId,
        toDocId: targetDocId,
        pageId: source.pageId,
        toIndex: index,
      });
      setSelected({ docId: targetDocId, pageId: source.pageId });
    },
    [dispatch],
  );

  const movePageToNewDoc = useCallback(
    (source: DragSource, docIndex: number) => {
      const sourceDoc = docs.find((d) => d.id === source.docId);
      if (!sourceDoc) return;
      const newDocId = crypto.randomUUID();
      const newName = uniqueDocName(
        sourceDoc.name,
        new Set(docs.filter((d) => d.id !== source.docId || d.pages.length > 1).map((d) => d.name)),
      );
      dispatch({
        type: 'MOVE_PAGE_TO_NEW_DOC',
        fromDocId: source.docId,
        pageId: source.pageId,
        docIndex,
        newDocId,
        newName,
      });
      setSelected({ docId: newDocId, pageId: source.pageId });
    },
    [dispatch, docs],
  );

  const drag = usePageDrag({ layout, canvasRef, movePageInto, movePageToNewDoc });

  const onSelectPage = useCallback(
    (docId: string, pageId: string) => setSelected({ docId, pageId }),
    [],
  );

  const onOpenPage = useCallback(
    (docId: string, pageId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const pageNumber = workspacePageNumber(docs, doc, pageId);
      if (pageNumber != null) onInspectPage(doc.path, pageNumber);
    },
    [docs, onInspectPage],
  );

  const onPageContextMenu = useCallback(
    (docId: string, pageId: string, e: React.MouseEvent) => {
      setSelected({ docId, pageId });
      setMenu({ x: e.clientX, y: e.clientY, docId, pageId });
    },
    [],
  );

  const rotateBy = useCallback(
    (docId: string, pageId: string, delta: 90 | 270) => {
      const page = docs.find((d) => d.id === docId)?.pages.find((p) => p.id === pageId);
      if (!page) return;
      const rotation = (((page.rotation + delta) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
      dispatch({ type: 'ROTATE_PAGE_REF', docId, pageId, rotation });
    },
    [dispatch, docs],
  );

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return [];
    const doc = docs.find((d) => d.id === menu.docId);
    if (!doc) return [];
    const fileHasOnePage =
      docs.filter((d) => d.path === doc.path).reduce((sum, d) => sum + d.pages.length, 0) <= 1;
    return [
      {
        label: 'Open',
        onClick: () => {
          const pageNumber = workspacePageNumber(docs, doc, menu.pageId);
          if (pageNumber != null) onInspectPage(doc.path, pageNumber);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      { label: 'Rotate right 90°', onClick: () => rotateBy(menu.docId, menu.pageId, 90) },
      { label: 'Rotate left 90°', onClick: () => rotateBy(menu.docId, menu.pageId, 270) },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Extract text…',
        onClick: () => {
          const pageNumber = workspacePageNumber(docs, doc, menu.pageId);
          if (pageNumber != null) onExtractText(doc.path, pageNumber);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Delete page',
        danger: true,
        // A file's last page can't be deleted (0-page PDFs can't exist) —
        // closing the file is the right gesture for that.
        disabled: fileHasOnePage,
        onClick: () => dispatch({ type: 'DELETE_PAGE_REF', docId: menu.docId, pageId: menu.pageId }),
      },
    ];
  }, [menu, docs, dispatch, onInspectPage, onExtractText, rotateBy]);

  const onMoveDoc = useCallback(
    (docId: string, direction: -1 | 1) => dispatch({ type: 'REORDER_DOCS', docId, direction }),
    [dispatch],
  );

  const onRemoveDoc = useCallback(
    (docId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const siblings = docs.filter((d) => d.path === doc.path);
      if (siblings.length === 1) onCloseFile(doc.path);
      else dispatch({ type: 'REMOVE_DOC', docId });
    },
    [dispatch, docs, onCloseFile],
  );

  const onRenameDoc = useCallback(
    (docId: string, name: string) => {
      const taken = new Set(docs.filter((d) => d.id !== docId).map((d) => d.name));
      dispatch({ type: 'RENAME_DOC', docId, name: uniqueDocName(name.trim(), taken) });
    },
    [dispatch, docs],
  );

  const { intoDocId, intoIndex, betweenIndex, ghostSize, betweenPages } = deriveDropGhosts(
    docs,
    drag.draggingPage,
    drag.dropTarget,
  );

  const dirty = state.pageDirtyPaths.length > 0;

  if (docs.length === 0) {
    return (
      <div className="canvas-view flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-neutral-400 mb-1">No documents open</p>
          <p className="text-sm text-neutral-500 mb-4">
            Drop PDF files anywhere, or open them to lay them out here
          </p>
          <button
            onClick={onOpenFiles}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            Open PDF
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'canvas-view flex-1 flex flex-col relative overflow-hidden' +
        (drag.committing ? ' committing' : '') +
        (drag.draggingPage ? ' dragging' : '') +
        (tool !== 'select' ? ' annotating' : '')
      }
    >
      <Canvas
        ref={canvasRef}
        contentWidth={layout.contentWidth}
        contentHeight={layout.contentHeight}
        slotHeight={layout.slotHeight}
        dragging={drag.draggingPage !== null}
        onSettle={() => setRenderVersion((v) => v + 1)}
        onBackgroundClick={() => setSelected(null)}
        overlay={
          <HeaderLayer
            items={layout.items}
            betweenIndex={betweenIndex}
            onMove={onMoveDoc}
            onRemove={onRemoveDoc}
            onRename={onRenameDoc}
          />
        }
      >
        <DocLayer
          items={layout.items}
          proxies={proxies}
          renderVersion={renderVersion}
          selected={selected}
          collapsedId={drag.collapsedId}
          draggingPage={drag.draggingPage}
          intoDocId={intoDocId}
          intoIndex={intoIndex}
          intoGhostWidth={ghostSize.width}
          intoGhostHeight={ghostSize.height}
          betweenIndex={betweenIndex}
          onSelectPage={onSelectPage}
          onOpenPage={onOpenPage}
          tool={tool}
          annotationColor={toolColor ?? undefined}
          stampPreset={stampPreset}
          redactionMarksByPage={redactionMarksByPage}
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          onPageContextMenu={onPageContextMenu}
          onPagePointerDown={drag.onPagePointerDown}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onAddRedactionMark={onAddRedactionMark}
          onRemoveRedactionMark={onRemoveRedactionMark}
          onSetSignaturePlacement={onSetSignaturePlacement}
          onClearSignaturePlacement={onClearSignaturePlacement}
        />
        {drag.dropTarget?.kind === 'between' && (
          <div
            className="canvas-doc ghost-doc"
            style={{
              left: 0,
              top: betweenSlotY(layout, drag.dropTarget.docIndex),
              width: MIN_DOC_WIDTH,
            }}
          >
            <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
          </div>
        )}
        <div
          className="canvas-doc"
          style={{ left: 0, top: betweenSlotY(layout, layout.items.length), width: MIN_DOC_WIDTH }}
        >
          <AddDocGhost width={MIN_DOC_WIDTH} onClick={onOpenFiles} />
        </div>
      </Canvas>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {/* Floating controls: tool toggle + zoom cluster + pending page-edit commit */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 z-30">
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Select and drag pages"
            onClick={() => setTool('select')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'select' ? 'bg-neutral-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Select
          </button>
          <button
            data-testid="tool-highlight"
            title="Drag a box on a page to highlight (Esc to exit)"
            onClick={() => setTool(tool === 'highlight' ? 'select' : 'highlight')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'highlight' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Highlight
          </button>
          <button
            data-testid="tool-freetext"
            title="Drag a box on a page to add text (Esc to exit)"
            onClick={() => setTool(tool === 'freetext' ? 'select' : 'freetext')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'freetext' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Text
          </button>
          <button
            data-testid="tool-ink"
            title="Draw freehand on a page (Esc to exit)"
            onClick={() => setTool(tool === 'ink' ? 'select' : 'ink')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'ink' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Draw
          </button>
          <button
            data-testid="tool-stamp"
            title="Click a page to place a stamp (Esc to exit)"
            onClick={() => setTool(tool === 'stamp' ? 'select' : 'stamp')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'stamp' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Stamp
          </button>
          <button
            data-testid="tool-redact"
            title="Drag a box on a page to mark it for redaction (Esc to exit)"
            onClick={() => setTool(tool === 'redact' ? 'select' : 'redact')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'redact' ? 'bg-red-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Redact
          </button>
          <button
            data-testid="tool-signature"
            title="Drag a box on a page to place a visible signature (Esc to exit)"
            onClick={() => setTool(tool === 'signature' ? 'select' : 'signature')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'signature' ? 'bg-violet-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Sign
          </button>
        </div>
        {tool === 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Stamp preset"
          >
            {STAMP_PRESETS.map((p) => (
              <button
                key={p.label}
                data-testid={`stamp-preset-${p.label.toLowerCase()}`}
                onClick={() => setStampPreset(stampPreset?.label === p.label ? null : p)}
                title={p.label}
                className="px-2 py-0.5 text-[10px] font-bold rounded-full"
                style={{
                  color: p.color,
                  border: `1px solid ${p.color}`,
                  backgroundColor: stampPreset?.label === p.label ? `${p.color}33` : 'transparent',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <button
          data-testid="toggle-find"
          title="Find in documents (Ctrl+F)"
          onClick={() => (find.open ? find.closeFind() : find.openFind())}
          className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${find.open ? 'bg-blue-600 text-white border-blue-600' : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Find
        </button>
        <button
          data-testid="toggle-comments"
          title="Show annotation notes"
          onClick={() => setShowComments((v) => !v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${showComments ? 'bg-blue-600 text-white border-blue-600' : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Comments
        </button>
        {tool !== 'select' && tool !== 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Annotation color"
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                data-testid={`annot-color-${c.slice(1)}`}
                onClick={() => setToolColor(toolColor === c ? null : c)}
                title={c}
                className="w-4 h-4 rounded-full"
                style={{
                  backgroundColor: c,
                  outline: toolColor === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        )}
        {liveMarks.length > 0 && (
          <>
            <button
              data-testid="redact-apply-btn"
              disabled={redacting}
              onClick={() => setConfirmRedact(true)}
              className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              {redacting
                ? 'Redacting…'
                : `Redact ${liveMarks.length} region${liveMarks.length === 1 ? '' : 's'}`}
            </button>
            <button
              data-testid="redact-clear-btn"
              disabled={redacting}
              onClick={() => setMarks([])}
              title="Clear all pending redaction marks"
              className="px-3 py-1.5 text-xs bg-neutral-800/90 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              Clear
            </button>
          </>
        )}
        {dirty && (
          <button
            data-testid="apply-page-edits-btn"
            onClick={onApplyChanges}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-full font-medium shadow-lg"
          >
            Apply changes
          </button>
        )}
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Zoom out"
            onClick={() => canvasRef.current?.zoomOut()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            −
          </button>
          <button
            title="Fit to view"
            onClick={() => canvasRef.current?.reset()}
            className="px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            Fit
          </button>
          <button
            title="Zoom in"
            onClick={() => canvasRef.current?.zoomIn()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            +
          </button>
        </div>
      </div>

      {showComments && (
        <CommentSidebar
          docs={docs}
          onSelectPage={onSelectPage}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onClose={() => setShowComments(false)}
        />
      )}

      {find.open && (
        <FindBar
          query={find.query}
          result={find.result}
          matchCount={find.matchPages.length}
          current={find.current}
          ocrRemaining={searchIndex.ocrRemaining}
          hasScanned={searchIndex.hasScanned}
          ocrLanguage={searchIndex.ocrLanguage}
          canApplyOcr={ocrReady.length > 0}
          applyingOcr={applyingOcr}
          onQuery={find.setQuery}
          onOcrLanguage={searchIndex.setOcrLanguage}
          onNext={find.next}
          onPrev={find.prev}
          onApplyOcr={() => void handleApplyOcr()}
          onClose={find.closeFind}
        />
      )}
      {ocrApplyError && (
        <div
          data-testid="ocr-apply-error"
          className="absolute top-16 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{ocrApplyError}</span>
          <button onClick={() => setOcrApplyError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}

      {liveSigPlacement && (
        <div
          data-testid="sign-canvas-form"
          className="absolute bottom-4 left-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">Sign with a visible stamp</div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            The stamp is drawn at the box you placed; the signed copy is written to a NEW file —
            this file is left unchanged.
          </p>
          <SignerSourceFields value={sigSource} onChange={setSigSource} idPrefix="canvas-sign" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Password</span>
            <input
              data-testid="canvas-sign-password"
              type="password"
              value={sigPassword}
              onChange={(e) => setSigPassword(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Reason</span>
            <input
              type="text"
              value={sigReason}
              placeholder="optional"
              onChange={(e) => setSigReason(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Location</span>
            <input
              type="text"
              value={sigLocation}
              placeholder="optional"
              onChange={(e) => setSigLocation(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          {signError && <div data-testid="canvas-sign-error" className="text-xs text-red-400">{signError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setSigPlacement(null);
                setSigPassword('');
                setSignError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="canvas-sign-apply"
              onClick={() => void applySignature()}
              disabled={signingBusy}
              className="px-2.5 py-1 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded font-medium"
            >
              {signingBusy ? 'Signing…' : 'Sign & Save…'}
            </button>
          </div>
        </div>
      )}

      {signDone && (
        <div
          data-testid="canvas-sign-done"
          className={`absolute bottom-4 left-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 rounded text-xs shadow-lg border ${
            signDone.ok
              ? 'bg-green-600/15 border-green-600/40 text-green-200'
              : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
          }`}
        >
          <span className="flex-1">
            Signed as <strong>{signDone.signer ?? '(unknown)'}</strong>
            {signDone.ok
              ? ' — valid, covers the whole document. '
              : ' — but the signature did not verify as expected. '}
            Saved to {signDone.output}
          </span>
          <button onClick={() => setSignDone(null)} className="hover:text-white">×</button>
        </div>
      )}

      {redactError && (
        <div
          data-testid="redact-error"
          className="absolute bottom-16 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{redactError}</span>
          <button
            onClick={() => setRedactError(null)}
            className="text-red-300 hover:text-red-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Redaction is the one canvas action that destroys file content, so it
          alone gets an explicit confirm step. */}
      {confirmRedact && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={() => setConfirmRedact(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[420px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">Redact content</h3>
            </div>
            <div className="px-5 py-4 text-sm text-neutral-300 space-y-2">
              <p>
                Permanently remove the content under {liveMarks.length} marked region
                {liveMarks.length === 1 ? '' : 's'} across{' '}
                {new Set(liveMarks.map((m) => m.pageId)).size} page
                {new Set(liveMarks.map((m) => m.pageId)).size === 1 ? '' : 's'}?
              </p>
              <p className="text-xs text-neutral-400">
                Text and images under each region are removed from the file's content, not just
                covered. Undo can restore the file while it stays open; once saved, the content is
                gone for good.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-neutral-800">
              <button
                data-testid="redact-cancel-btn"
                onClick={() => setConfirmRedact(false)}
                className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                Cancel
              </button>
              <button
                data-testid="redact-confirm-btn"
                onClick={() => {
                  setConfirmRedact(false);
                  void applyMarks();
                }}
                className="px-3 py-1 text-xs text-white bg-red-600 hover:bg-red-500 rounded font-medium"
              >
                Redact
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
