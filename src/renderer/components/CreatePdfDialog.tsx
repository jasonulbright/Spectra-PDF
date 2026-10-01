import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { app, dialog, file } from '../lib/tauri-bridge';
import { gsBlocked, gsPathIfAvailable, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from './GsRequiredNotice';
import { TEST_HARNESS_ENABLED, registerCreatePdf, type CreatePdfRunOptions } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, type UiKey, type UiPluralKey } from '../i18n';
import {
  KIND_LABEL_KEYS,
  ORIENTATIONS,
  PAGE_SIZES,
  QUALITY_PRESETS,
  type Orientation,
  type PageSize,
  type SourceRow,
  addPaths,
  baseName,
  blankRow,
  captureIdToReleaseOnRowRemoval,
  createLimiter,
  effectiveOutputMode,
  hasThumbnail,
  orderSelection,
  rowFromPath,
  defaultOutputPath,
  hasUnsupported,
  moveRow,
  needsQualityPreset,
  perFileEligible,
  perFileTargets,
  reserveFreeOutput,
  removeRow,
  reorderRows,
  toEngineSources,
  type OutputMode,
  type OutputReservation,
} from '../lib/create-pdf';
import { claimOutputFile, type OutputRootClaim } from '../lib/output-root-claim';
import { contractFailureMessage, isCommandMissing } from '../lib/shell-action';
import { useRowDrag, rowDragClass } from './useRowDrag';
import {
  CLIPBOARD_KIND_LABEL_KEYS,
  clipboardRow,
  clipboardSummary,
  isClipboardFiles,
  type ClipboardKind,
  type ClipboardSourceResult,
} from '../lib/clipboard-source';
import {
  captureFailureNotice,
  outlineFromRows,
  type CaptureResult,
} from '../lib/web-capture';
import { WebCaptureDialog } from './WebCaptureDialog';
import { platformCapability } from '../lib/platform-capabilities';

// File ▸ Create PDF: ONE door for images, Office /
// text / web documents, PostScript and a blank page. A MENU dialog, not a
// tool tile — creating needs no open document (the batch-OCR precedent).
//
// The engine call is callRaw: every source is an EXTERNAL file and the output
// is a new file, never a workspace working copy, so the commit gate must not
// run (and must not side-effect-commit unrelated pending page edits). The
// operation QUEUE is a different thing from the gate, and this does belong in
// it — so the call is wrapped in `track` directly.

interface CreatePdfSourceReport {
  path?: string;
  kind: string;
  pages: number;
  error?: string;
  fonts_substituted?: string[];
}

/** An absent backend command: no later source of the run can succeed. */
class MissingContractError extends Error {}

/** One source of a per-file run: the PDF it became, or why it did not. */
interface PerFileOutcome {
  source: string;
  output?: string;
  error?: string;
}

interface PerFileResult {
  outcomes: PerFileOutcome[];
  /** Sources a Stop left unconverted. */
  stopped: number;
}

interface CreatePdfResult {
  output: string;
  pages: number;
  sources: CreatePdfSourceReport[];
  warnings?: string[];
}

export function CreatePdfDialog({
  onClose,
  onOpenResult,
  initialPaths,
  initialOutputMode,
  autoStart,
  onOpenAll,
}: {
  onClose: () => void;
  /** Open the created PDF through the normal open funnel; rejection is
   * surfaced IN the dialog (the fire-and-forget shape lost failures once
   * the dialog had closed — regression). */
  onOpenResult: (path: string, options?: { recognize?: boolean }) => Promise<void>;
  /** Sources the dialog opens pre-populated with — a drop of non-PDF files
   * on the window lands here rather than doing nothing. */
  initialPaths?: readonly string[];
  /** The output mode a seed asks for; null leaves the current mode. */
  initialOutputMode?: OutputMode | null;
  /** Open every PDF a per-file run built, through the normal open funnel. */
  onOpenAll: (paths: string[]) => Promise<void>;
  /** The acquisition to start on, when the dialog was opened from one of the
   * File ▸ Create siblings rather than from Create PDF itself. */
  autoStart?: 'clipboard' | 'web' | null;
}): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();
  const { track } = useOperationQueue();
  const [rows, setRows] = useState<SourceRow[]>(() => addPaths([], orderSelection(initialPaths ?? [])));
  const [pageSize, setPageSize] = useState<PageSize>('auto');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [margin, setMargin] = useState('0');
  const [preset, setPreset] = useState('printer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<CreatePdfResult | null>(null);
  const [showWebCapture, setShowWebCapture] = useState(false);
  // What each clipboard row actually carried, keyed by row id — the summary
  // line ("Image, 1200 x 800") is about the PAYLOAD and cannot be recovered
  // from the scratch path.
  const [clipboardInfo, setClipboardInfo] = useState<Record<string, ClipboardSourceResult>>({});
  const clipboardScratchPaths = useRef(new Set<string>());
  const webCaptureIds = useRef(new Set<string>());
  const clipboardDialogMounted = useRef(true);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [outputMode, setOutputMode] = useState<OutputMode>(initialOutputMode ?? 'single');
  const [perFile, setPerFile] = useState<PerFileResult | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  // Ref, not state: convert()'s reentrancy window opens BEFORE any state
  // updates land (the whole native save-dialog round trip) — a second
  // click read a stale busy=false closure, both clicks awaited the SAME
  // serialized dialog promise, and BOTH ran the conversion
  // (regression; the committingTextRef discipline).
  const convertingRef = useRef(false);

  React.useEffect(() => {
    clipboardDialogMounted.current = true;
    const clipboardPaths = clipboardScratchPaths.current;
    const captureIds = webCaptureIds.current;
    return () => {
      clipboardDialogMounted.current = false;
      for (const path of clipboardPaths) {
        void app.discardClipboardSource(path).catch(() => {});
      }
      clipboardPaths.clear();
      for (const captureId of captureIds) {
        void app.discardWebCapture(captureId).catch(() => {});
      }
      captureIds.clear();
    };
  }, []);

  const releaseClipboardScratch = useCallback((path: string) => {
    void app.discardClipboardSource(path).then(
      () => clipboardScratchPaths.current.delete(path),
      () => {},
    );
  }, []);

  // A drop that arrives while the dialog is ALREADY open must still land —
  // `initialPaths` seeds the first render, and this merges every later seed.
  // `addPaths` skips what is already listed, so a repeated seed is a no-op.
  // Keyed by a SERIALISED list, not by array identity: the parent rebuilds the
  // array on every render, and a Windows path contains spaces, so a naive join
  // would also be an unsound key.
  const seedKey = JSON.stringify(initialPaths ?? []);
  React.useEffect(() => {
    const seeded = JSON.parse(seedKey) as string[];
    if (seeded.length === 0) return;
    setRows((prev) => addPaths(prev, orderSelection(seeded)));
  }, [seedKey]);
  // A File Explorer seed names its mode; a drop or a menu open does not.
  React.useEffect(() => {
    if (initialOutputMode) setOutputMode(initialOutputMode);
  }, [seedKey, initialOutputMode]);
  const mode = effectiveOutputMode(outputMode, rows);

  const gs = useGsCapability();
  // `needsQualityPreset` is true for exactly the PostScript rows, which are
  // the only ones Ghostscript distils. Images, Office documents and PDFs are
  // built by other tools, so an absent interpreter refuses those SOURCES and
  // leaves the dialog working for every other list.
  const psRows = useMemo(() => needsQualityPreset(rows), [rows]);
  const psRefused = psRows && gsBlocked(gs);
  const showQuality = psRows && !gsBlocked(gs);
  const blocked = rows.length === 0 || hasUnsupported(rows) || psRefused;

  const addSources = useCallback(async () => {
    const picked = await dialog.pickCreatePdfSources();
    if (picked.length > 0) {
      setRows((prev) => addPaths(prev, orderSelection(picked)));
      setError(null);
      setNotice(null);
      setResult(null);
    }
  }, []);

  const addBlank = useCallback(() => {
    setRows((prev) => [...prev, blankRow()]);
    setError(null);
    setNotice(null);
    setResult(null);
  }, []);

  // The clipboard payload becomes an ORDINARY source row: Rust writes it to a
  // scratch file whose extension the engine already accepts, so nothing here
  // converts and nothing in the engine had to learn what a clipboard is.
  const addClipboard = useCallback(async () => {
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const read = await app.readClipboardSource();
      if (isClipboardFiles(read)) {
        if (clipboardDialogMounted.current) {
          setRows((prev) => addPaths(prev, orderSelection(read.files)));
        }
        return null;
      }
      const clip = read;
      if (!clipboardDialogMounted.current) {
        void app.discardClipboardSource(clip.path).catch(() => {});
        return null;
      }
      clipboardScratchPaths.current.add(clip.path);
      const row = clipboardRow(clip);
      setClipboardInfo((prev) => ({ ...prev, [row.id]: clip }));
      setRows((prev) => [...prev, row]);
      return clip;
    } catch (err) {
      if (clipboardDialogMounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return null;
    }
  }, []);

  const releaseWebCapture = useCallback((captureId: string) => {
    void app.discardWebCapture(captureId).then(
      () => webCaptureIds.current.delete(captureId),
      () => {},
    );
  }, []);

  const removeSourceRow = useCallback((rowId: string) => {
    const clipboardSource = clipboardInfo[rowId];
    if (clipboardSource) {
      releaseClipboardScratch(clipboardSource.path);
      setClipboardInfo((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }
    const captureId = captureIdToReleaseOnRowRemoval(rows, rowId);
    if (captureId) releaseWebCapture(captureId);
    setRows((prev) => removeRow(prev, rowId));
  }, [rows, clipboardInfo, releaseClipboardScratch, releaseWebCapture]);

  const reorder = useCallback(
    (from: number, to: number) => setRows((prev) => reorderRows(prev, from, to)),
    [],
  );
  const { drag, startRowDrag } = useRowDrag(listRef, '[data-testid="create-pdf-row"]', reorder);

  // A capture arrives as one row per captured page, in capture order, each
  // carrying the title its bookmark will use. Partial-crawl status moves to
  // this dialog because the capture sub-dialog closes after handing rows up.
  const addCaptured = useCallback((capture: CaptureResult) => {
    const failureNotice = captureFailureNotice(capture.failures);
    setError(failureNotice
      ? [
          ...failureNotice.examples,
          ...(failureNotice.omitted > 0 ? ['…'] : []),
        ].join('\n')
      : null);
    setNotice(
      capture.truncated
        ? tChromeCount('dialog.webCapture.truncated', capture.pages.length)
        : null,
    );
    setResult(null);
    if (capture.pages.length > 0) webCaptureIds.current.add(capture.captureId);
    setRows((prev) => [
      ...prev,
      ...capture.pages.map((page) => ({
        ...rowFromPath(page.path),
        origin: 'web' as const,
        captureId: capture.captureId,
        captureUrl: page.url,
        captureTitle: page.title,
      })),
    ]);
    setShowWebCapture(false);
  }, []);

  // The File ▸ Create sibling that opened this dialog starts its own
  // acquisition. ONCE per mount, through a ref: re-reading the clipboard on a
  // re-render would add the same payload twice, and `addPaths`'s duplicate
  // suppression cannot see it — every read writes a NEW scratch file.
  const startedRef = useRef(false);
  const autoStartRef = useRef({ addClipboard });
  autoStartRef.current = { addClipboard };
  React.useEffect(() => {
    if (!autoStart || startedRef.current) return;
    startedRef.current = true;
    if (autoStart === 'clipboard') void autoStartRef.current.addClipboard();
    else setShowWebCapture(true);
  }, [autoStart]);

  const convertTo = useCallback(
    async (sourceRows: readonly SourceRow[], out: string, options: CreatePdfRunOptions) => {
      if (convertingRef.current) return null;
      convertingRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      setResult(null);
      setPerFile(null);
      let claim: OutputRootClaim | null = null;
      try {
        claim = await claimOutputFile(out);
        if (!claim.granted) {
          setError(claim.message);
          return null;
        }
        // Both converters resolve up front: which arms a run needs depends on
        // the LIST, and asking per row would stall the conversion mid-way.
        const [gsPath, sofficePath] = await Promise.all([
          needsQualityPreset(sourceRows) ? requireGsPath() : gsPathIfAvailable(),
          app.getSofficePath(),
        ]);
        const params = {
          sources: toEngineSources(sourceRows),
          output: out,
          page_size: options.pageSize ?? 'auto',
          orientation: options.orientation ?? 'auto',
          margin_pt: options.marginPt ?? 0,
          gs_path: gsPath,
          soffice_path: sofficePath,
          distill_preset: options.preset ?? 'printer',
        };
        const r = (await track('create_pdf', { file: out }, () =>
          callRaw('create_pdf', params),
        )) as unknown as CreatePdfResult;
        // The captured link structure lands as bookmarks, through the SHIPPED
        // set_outline. Offsets come from what each source ACTUALLY
        // contributed, so a captured site mixed with local files still gets
        // its bookmarks on the pages the captures landed on. A failure here
        // is reported and never discards the document that was built.
        const outline = outlineFromRows(
          sourceRows,
          (r.sources ?? []).map((row) => row.pages),
        );
        if (outline.length > 0) {
          try {
            await callRaw('set_outline', { file: out, outline, output: out });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
        setResult(r);
        return r;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        await claim?.release();
        convertingRef.current = false;
        setBusy(false);
      }
    },
    [callRaw, track],
  );

  // One engine call per source, each output beside its source under a name
  // nothing occupies, held by a claim on that name for the write. A failed
  // source is reported on its own row and the run goes on; Stop takes effect
  // between sources, never inside an engine call.
  const convertPerFile = useCallback(
    async (sourceRows: readonly SourceRow[], options: CreatePdfRunOptions): Promise<PerFileResult | null> => {
      if (convertingRef.current) return null;
      convertingRef.current = true;
      stopRef.current = false;
      setStopping(false);
      setBusy(true);
      setError(null);
      setNotice(null);
      setResult(null);
      setPerFile(null);
      const targets = perFileTargets(sourceRows);
      const freeName = async (path: string): Promise<string> => {
        try {
          return await app.freeOutputPath(path);
        } catch (err) {
          throw isCommandMissing(err, 'free_output_path')
            ? new MissingContractError(contractFailureMessage(err, 'free_output_path'), { cause: err })
            : err;
        }
      };
      const claimName = (path: string) => claimOutputFile(path);
      try {
        const [gsPath, sofficePath] = await Promise.all([
          needsQualityPreset(sourceRows) ? requireGsPath() : gsPathIfAvailable(),
          app.getSofficePath(),
        ]);
        const outcomes: PerFileOutcome[] = [];
        for (const [index, target] of targets.entries()) {
          if (stopRef.current) break;
          setProgress({ current: index + 1, total: targets.length });
          const source = target.row.path as string;
          let reservation: OutputReservation | null = null;
          try {
            reservation = await reserveFreeOutput(target.desired, freeName, claimName);
            const out = reservation.out;
            await track('create_pdf', { file: out }, () =>
              callRaw('create_pdf', {
                sources: toEngineSources([target.row]),
                output: out,
                page_size: options.pageSize ?? 'auto',
                orientation: options.orientation ?? 'auto',
                margin_pt: options.marginPt ?? 0,
                gs_path: gsPath,
                soffice_path: sofficePath,
                distill_preset: options.preset ?? 'printer',
              }),
            );
            outcomes.push({ source, output: out });
          } catch (err) {
            // Every later source would fail the same way.
            if (err instanceof MissingContractError) throw err;
            outcomes.push({ source, error: err instanceof Error ? err.message : String(err) });
          } finally {
            await reservation?.release();
          }
          setPerFile({ outcomes: [...outcomes], stopped: 0 });
        }
        const finished = { outcomes, stopped: targets.length - outcomes.length };
        setPerFile(finished);
        return finished;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setProgress(null);
        convertingRef.current = false;
        setBusy(false);
      }
    },
    [callRaw, track],
  );

  const runOptions = useCallback((): CreatePdfRunOptions => {
    const marginPt = Number.parseFloat(margin);
    return {
      pageSize,
      orientation,
      marginPt: Number.isFinite(marginPt) && marginPt >= 0 ? marginPt : 0,
      preset,
    };
  }, [margin, pageSize, orientation, preset]);

  const convert = useCallback(async () => {
    // The ref is the guard (see its comment); state only drives the UI.
    if (blocked || convertingRef.current) return;
    if (mode === 'perFile') {
      await convertPerFile(rows, runOptions());
      return;
    }
    const suggested = defaultOutputPath(rows) ?? 'document.pdf';
    const out = await dialog.saveFile({ defaultPath: suggested });
    if (!out || convertingRef.current) return;
    await convertTo(rows, out, runOptions());
  }, [blocked, mode, rows, runOptions, convertTo, convertPerFile]);

  const stop = useCallback(() => {
    stopRef.current = true;
    setStopping(true);
  }, []);

  const openAll = (paths: string[]) => {
    setBusy(true);
    onOpenAll(paths)
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };
  const builtOutputs = (perFile?.outcomes ?? [])
    .map((o) => o.output)
    .filter((o): o is string => o !== undefined);
  const failedCount = (perFile?.outcomes ?? []).filter((o) => o.error !== undefined).length;

  // Harness bridge: native pickers are undrivable by WebDriver — e2e injects
  // the source LIST and runs the REAL conversion path. `addPaths` is the same
  // function the picker's result goes through, so an injected list and a
  // picked one cannot diverge.
  const harnessRef = useRef({ convertTo, addClipboard, rows });
  harnessRef.current = { convertTo, addClipboard, rows };
  React.useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCreatePdf({
      run: (sources, out, options) => {
        const injected = sources.reduce<SourceRow[]>(
          (acc, source) => (source === '__blank__' ? [...acc, blankRow()] : addPaths(acc, [source])),
          [],
        );
        setRows(injected);
        return harnessRef.current
          .convertTo(injected, out, options ?? {})
          .then((r) => (r === null ? null : { output: r.output, pages: r.pages }));
      },
      addClipboard: () =>
        harnessRef.current
          .addClipboard()
          .then((clip) =>
            clip === null ? null : { path: clip.path, kind: clip.kind, format: clip.format },
          ),
      convertCurrent: (out, options) =>
        harnessRef.current
          .convertTo(harnessRef.current.rows, out, options ?? {})
          .then((r) => (r === null ? null : { output: r.output, pages: r.pages })),
    });
    return () => registerCreatePdf(null);
  }, []);

  // Close only when the open SETTLES — a failure (output deleted/locked since
  // conversion) surfaces here instead of dying as an unhandled rejection after
  // unmount.
  const openResult = (path: string, recognize: boolean) => {
    setBusy(true);
    onOpenResult(path, { recognize })
      .then(() => onClose())
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  // Escape/backdrop obey the same busy discipline as the Close button —
  // a conversion has no cancel, and closing mid-call abandons an in-flight
  // engine job (the BatchOcr guardedClose rule; regression
  // when only the button was gated).
  const guardedClose = busy ? () => {} : onClose;

  return (
    <Shell onClose={guardedClose}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="create-pdf-pick"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={() => void addSources()}
            disabled={busy}
          >
            {tChrome('dialog.createPdf.addFiles')}
          </button>
          {platformCapability('clipboardRead') && (
          <button
            type="button"
            data-testid="create-pdf-add-clipboard"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={() => void addClipboard()}
            disabled={busy}
          >
            {tChrome('dialog.createPdf.addClipboard')}
          </button>
          )}
          {platformCapability('webCapture') && (
          <button
            type="button"
            data-testid="create-pdf-add-web"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={() => setShowWebCapture(true)}
            disabled={busy}
          >
            {tChrome('dialog.createPdf.addWebPage')}
          </button>
          )}
          <button
            type="button"
            data-testid="create-pdf-add-blank"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={addBlank}
            disabled={busy}
          >
            {tChrome('dialog.createPdf.addBlank')}
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-neutral-400" data-testid="create-pdf-empty">
            {tChrome('dialog.createPdf.empty')}
          </p>
        ) : (
          <ul
            className="flex flex-col border border-neutral-800 rounded divide-y divide-neutral-800 max-h-56 overflow-y-auto"
            ref={listRef}
            data-testid="create-pdf-list"
            aria-label={tChrome('dialog.createPdf.listLabel')}
          >
            {rows.map((row, index) => (
              <li
                key={row.id}
                data-testid="create-pdf-row"
                data-kind={row.kind || 'unsupported'}
                data-dragging={drag?.from === index ? 'yes' : undefined}
                className={'flex items-center gap-2 px-2 py-1.5 text-xs ' + rowDragClass(drag, index)}
              >
                <span
                  data-testid="create-pdf-row-grip"
                  aria-hidden="true"
                  title={tChrome('dialog.createPdf.dragHandle')}
                  className={`shrink-0 px-0.5 text-neutral-500 select-none touch-none ${busy ? '' : 'cursor-grab hover:text-neutral-300'}`}
                  onPointerDown={busy ? undefined : (e) => startRowDrag(e, index)}
                >
                  ⋮⋮
                </span>
                <RowThumbnail row={row} />
                <span
                  className={
                    'shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ' +
                    (row.kind === 'postscript' && gsBlocked(gs)
                      ? 'bg-amber-900/40 text-amber-200'
                      : 'bg-neutral-800 text-neutral-400')
                  }
                  data-gs-refused={row.kind === 'postscript' && gsBlocked(gs) ? 'yes' : undefined}
                >
                  {row.kind
                    ? tChrome(KIND_LABEL_KEYS[row.kind] as UiKey)
                    : tChrome('dialog.createPdf.kindUnsupported')}
                </span>
                <span
                  className={`flex-1 min-w-0 ${row.kind ? 'text-neutral-300' : 'text-red-400'}`}
                  title={row.origin === 'web' ? (row.captureUrl ?? '') : (row.path ?? '')}
                >
                  <span className="block truncate" data-testid="create-pdf-row-name">{rowName(row)}</span>
                  {rowDetail(row, clipboardInfo[row.id]) && (
                    <span
                      className="block truncate text-[10px] text-neutral-500"
                      data-testid="create-pdf-row-detail"
                    >
                      {rowDetail(row, clipboardInfo[row.id])}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  data-testid="create-pdf-row-up"
                  aria-label={tChrome('dialog.createPdf.moveUp')}
                  className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-60"
                  disabled={busy || index === 0}
                  onClick={() => setRows((prev) => moveRow(prev, row.id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-testid="create-pdf-row-down"
                  aria-label={tChrome('dialog.createPdf.moveDown')}
                  className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-60"
                  disabled={busy || index === rows.length - 1}
                  onClick={() => setRows((prev) => moveRow(prev, row.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  data-testid="create-pdf-row-remove"
                  aria-label={tChrome('dialog.createPdf.remove')}
                  className="px-1 text-neutral-400 hover:text-red-400 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => removeSourceRow(row.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {hasUnsupported(rows) && (
          <p className="text-sm text-red-400" data-testid="create-pdf-unsupported" aria-live="polite">
            {tChrome('dialog.createPdf.unsupportedRow')}
          </p>
        )}

        {perFileEligible(rows) && (
          <fieldset className="flex flex-col gap-1.5" data-testid="create-pdf-output-mode">
            <legend className="text-xs text-neutral-400 mb-1">
              {tChrome('dialog.createPdf.outputMode')}
            </legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="radio"
                  name="create-pdf-output-mode"
                  data-testid="create-pdf-output-single"
                  checked={mode === 'single'}
                  disabled={busy}
                  onChange={() => setOutputMode('single')}
                />
                {tChrome('dialog.createPdf.outputMode.single')}
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="radio"
                  name="create-pdf-output-mode"
                  data-testid="create-pdf-output-perfile"
                  checked={mode === 'perFile'}
                  disabled={busy}
                  onChange={() => setOutputMode('perFile')}
                />
                {tChrome('dialog.createPdf.outputMode.perFile')}
              </label>
            </div>
            {mode === 'perFile' && (
              <p className="text-xs text-neutral-500" data-testid="create-pdf-perfile-hint">
                {tChrome('dialog.createPdf.perFileHint')}
              </p>
            )}
          </fieldset>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs text-neutral-400 mb-1" htmlFor="create-pdf-page-size">
              {tChrome('dialog.createPdf.pageSize')}
            </label>
            <select
              id="create-pdf-page-size"
              data-testid="create-pdf-page-size"
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
              value={pageSize}
              disabled={busy}
              onChange={(e) => setPageSize(e.target.value as PageSize)}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {tChrome(`dialog.createPdf.pageSize.${size}` as UiKey)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1" htmlFor="create-pdf-orientation">
              {tChrome('dialog.createPdf.orientation')}
            </label>
            <select
              id="create-pdf-orientation"
              data-testid="create-pdf-orientation"
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
              value={orientation}
              disabled={busy || pageSize === 'auto'}
              onChange={(e) => setOrientation(e.target.value as Orientation)}
            >
              {ORIENTATIONS.map((value) => (
                <option key={value} value={value}>
                  {tChrome(`dialog.createPdf.orientation.${value}` as UiKey)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1" htmlFor="create-pdf-margin">
              {tChrome('dialog.createPdf.margin')}
            </label>
            <input
              id="create-pdf-margin"
              data-testid="create-pdf-margin"
              type="number"
              min={0}
              step={1}
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
              value={margin}
              disabled={busy || pageSize === 'auto'}
              onChange={(e) => setMargin(e.target.value)}
            />
          </div>
        </div>

        {/* The quality preset is a `distill` parameter and means nothing for an
            image, an Office file or a blank page — so it appears only when a
            PostScript source is actually in the list. */}
        {showQuality && (
          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="create-pdf-preset">
              {tChrome('dialog.createPdf.quality')}
            </label>
            <select
              id="create-pdf-preset"
              data-testid="create-pdf-preset"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={preset}
              disabled={busy}
              onChange={(e) => setPreset(e.target.value)}
            >
              {QUALITY_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {tChrome(`dialog.createPdf.preset.${value}` as UiKey)}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-400 whitespace-pre-line break-words" data-testid="create-pdf-error" aria-live="polite">
            {error}
          </p>
        )}
        {notice && (
          <p className="text-xs text-amber-400" data-testid="create-pdf-notice" aria-live="polite">
            {notice}
          </p>
        )}

        {result && (
          <div aria-live="polite">
            <p className="text-sm break-all" data-testid="create-pdf-done">
              {/* One whole message — the path rides as an interpolation
                  rather than sitting in a trailing span the wording would
                  have to wrap around. */}
              {tChromeCount('dialog.createPdf.done', result.pages, { path: result.output })}
            </p>
            {(result.warnings ?? []).map((warning) => (
              <p key={warning} className="text-xs text-amber-400 mt-1" data-testid="create-pdf-warning">
                {warning}
              </p>
            ))}
          </div>
        )}

        {progress && (
          <p className="text-xs text-neutral-400" data-testid="create-pdf-progress" aria-live="polite">
            {tChrome('dialog.createPdf.perFileProgress', progress)}
          </p>
        )}

        {perFile && (
          <div aria-live="polite" data-testid="create-pdf-perfile-result">
            <p className="text-sm" data-testid="create-pdf-perfile-summary">
              {tChromeCount('dialog.createPdf.perFileDone', builtOutputs.length)}
            </p>
            {failedCount > 0 && (
              <p className="text-sm text-red-400" data-testid="create-pdf-perfile-failed">
                {tChromeCount('dialog.createPdf.perFileFailed', failedCount)}
              </p>
            )}
            {perFile.stopped > 0 && (
              <p className="text-xs text-amber-400" data-testid="create-pdf-perfile-stopped">
                {tChromeCount('dialog.createPdf.perFileStopped', perFile.stopped)}
              </p>
            )}
            <ul className="mt-1 flex flex-col gap-0.5 max-h-32 overflow-y-auto text-xs">
              {perFile.outcomes.map((outcome) => (
                <li
                  key={outcome.source}
                  data-testid="create-pdf-perfile-row"
                  data-state={outcome.output !== undefined ? 'built' : 'failed'}
                  data-output={outcome.output}
                  className={'break-all ' + (outcome.output !== undefined ? 'text-neutral-300' : 'text-red-400')}
                >
                  {outcome.output !== undefined
                    ? tChrome('dialog.common.route', {
                      source: baseName(outcome.source),
                      dest: outcome.output,
                    })
                    : tChrome('canvas.common.fileFailure', {
                      name: baseName(outcome.source),
                      message: outcome.error ?? '',
                    })}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {perFile && !busy && builtOutputs.length > 0 && (
            <button
              type="button"
              data-testid="create-pdf-open-all"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
              onClick={() => openAll(builtOutputs)}
            >
              {tChrome('dialog.createPdf.openAll')}
            </button>
          )}
          {progress && (
            <button
              type="button"
              data-testid="create-pdf-stop"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-60 rounded font-medium"
              disabled={stopping}
              onClick={stop}
            >
              {tChrome('dialog.batch.stop')}
            </button>
          )}
          {result && (
            <>
              <button
                type="button"
                data-testid="create-pdf-open-ocr"
                className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
                disabled={busy}
                onClick={() => openResult(result.output, true)}
              >
                {tChrome('dialog.createPdf.openAndOcr')}
              </button>
              <button
                type="button"
                data-testid="create-pdf-open"
                className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
                disabled={busy}
                onClick={() => openResult(result.output, false)}
              >
                {tChrome('dialog.common.open')}
              </button>
            </>
          )}
          {psRefused && <GsRequiredNotice capability={gs} testId="create-pdf-gs" />}
          <button
            type="button"
            data-testid="create-pdf-convert"
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
            disabled={blocked || busy}
            onClick={() => void convert()}
          >
            {tChrome(
              busy
                ? 'dialog.createPdf.converting'
                : mode === 'perFile'
                  ? 'dialog.createPdf.convertPerFile'
                  : 'dialog.createPdf.convert',
            )}
          </button>
          <button
            type="button"
            data-testid="create-pdf-close"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={onClose}
            disabled={busy}
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
      </div>
      {showWebCapture && (
        <WebCaptureDialog onClose={() => setShowWebCapture(false)} onCaptured={addCaptured} />
      )}
    </Shell>
  );
}

/**
 * What a row is CALLED. A picked file is its own basename; a clipboard row is
 * what arrived (a scratch name like `clipboard-1755…-0.dib` is not a thing a
 * user recognises); a captured page is the title the page gave itself.
 */
function rowName(row: SourceRow): string {
  if (row.kind === 'blank') return tChrome('dialog.createPdf.blankPage');
  if (row.origin === 'web') return (row.captureTitle ?? '').trim() || (row.captureUrl ?? '');
  if (row.origin === 'clipboard') {
    return tChrome(
      CLIPBOARD_KIND_LABEL_KEYS[(row.clipboardKind ?? 'text') as ClipboardKind] as UiKey,
    );
  }
  return baseName(row.path ?? '');
}

/**
 * The second line: how much arrived, or where a captured page came from.
 *
 * A separate string rather than an interpolation into the name — the two are
 * different facts and joining them would be the banned concatenation with
 * extra steps.
 */
function rowDetail(row: SourceRow, clip: ClipboardSourceResult | undefined): string {
  if (row.origin === 'web') return row.captureUrl ?? '';
  if (row.origin === 'clipboard' && clip) {
    const summary = clipboardSummary(clip);
    return summary.count === undefined
      ? tChrome(summary.key as UiKey, summary.params)
      : tChromeCount(summary.key as UiPluralKey, summary.count, summary.params);
  }
  return '';
}

/** Largest image read for a list thumbnail; a bigger one is never read and
 * shows an empty tile. */
const MAX_THUMBNAIL_BYTES = 24 * 1024 * 1024;
/** Thumbnail reads in flight at once, across every row. */
const thumbnailReads = createLimiter(3);

function RowThumbnail({ row }: { row: SourceRow }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const path = hasThumbnail(row) ? (row.path ?? null) : null;
  React.useEffect(() => {
    if (!path) return;
    let live = true;
    let objectUrl: string | null = null;
    void thumbnailReads(() => file.readExternalBufferCapped(path, MAX_THUMBNAIL_BYTES), () => live).then(
      (bytes) => {
        if (!live || !bytes || bytes.byteLength === 0) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setUrl(objectUrl);
      },
      () => {},
    );
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [path]);
  return (
    <span className="shrink-0 w-10 h-10 flex items-center justify-center bg-neutral-800 rounded overflow-hidden">
      {url && (
        <img
          src={url}
          alt=""
          data-testid="create-pdf-row-thumb"
          draggable={false}
          className="max-w-full max-h-full object-contain"
        />
      )}
    </span>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.createPdf.title')}
        data-testid="create-pdf-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.createPdf.title')}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}
