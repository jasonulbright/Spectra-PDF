import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { app, dialog } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import { TEST_HARNESS_ENABLED, registerCreatePdf, type CreatePdfRunOptions } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, type UiKey } from '../i18n';
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
  defaultOutputPath,
  hasUnsupported,
  moveRow,
  needsQualityPreset,
  removeRow,
  reorderRows,
  toEngineSources,
} from '../lib/create-pdf';

// File ▸ Create PDF (P22, architecture/41): ONE door for images, Office /
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
}: {
  onClose: () => void;
  /** Open the created PDF through the normal open funnel; rejection is
   * surfaced IN the dialog (the fire-and-forget shape lost failures once
   * the dialog had closed — review-caught). */
  onOpenResult: (path: string) => Promise<void>;
  /** Sources the dialog opens pre-populated with — a drop of non-PDF files
   * on the window lands here rather than doing nothing. */
  initialPaths?: readonly string[];
}): React.JSX.Element {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();
  const { track } = useOperationQueue();
  const [rows, setRows] = useState<SourceRow[]>(() => addPaths([], initialPaths ?? []));
  const [pageSize, setPageSize] = useState<PageSize>('auto');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [margin, setMargin] = useState('0');
  const [preset, setPreset] = useState('printer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatePdfResult | null>(null);
  const dragFrom = useRef<number | null>(null);
  // Ref, not state: convert()'s reentrancy window opens BEFORE any state
  // updates land (the whole native save-dialog round trip) — a second
  // click read a stale busy=false closure, both clicks awaited the SAME
  // serialized dialog promise, and BOTH ran the conversion
  // (review-caught; the committingTextRef discipline).
  const convertingRef = useRef(false);

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
    setRows((prev) => addPaths(prev, seeded));
  }, [seedKey]);

  const showQuality = useMemo(() => needsQualityPreset(rows), [rows]);
  const blocked = rows.length === 0 || hasUnsupported(rows);

  const addSources = useCallback(async () => {
    const picked = await dialog.pickCreatePdfSources();
    if (picked.length > 0) {
      setRows((prev) => addPaths(prev, picked));
      setError(null);
      setResult(null);
    }
  }, []);

  const addBlank = useCallback(() => {
    setRows((prev) => [...prev, blankRow()]);
    setError(null);
    setResult(null);
  }, []);

  const convertTo = useCallback(
    async (sourceRows: readonly SourceRow[], out: string, options: CreatePdfRunOptions) => {
      if (convertingRef.current) return null;
      convertingRef.current = true;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        // Both converters resolve up front: which arms a run needs depends on
        // the LIST, and asking per row would stall the conversion mid-way.
        const [gsPath, sofficePath] = await Promise.all([ensureGsPath(), app.getSofficePath()]);
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
        setResult(r);
        return r;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        convertingRef.current = false;
        setBusy(false);
      }
    },
    [callRaw, track],
  );

  const convert = useCallback(async () => {
    // The ref is the guard (see its comment); state only drives the UI.
    if (blocked || convertingRef.current) return;
    const suggested = defaultOutputPath(rows) ?? 'document.pdf';
    const out = await dialog.saveFile({ defaultPath: suggested });
    if (!out || convertingRef.current) return;
    const marginPt = Number.parseFloat(margin);
    await convertTo(rows, out, {
      pageSize,
      orientation,
      marginPt: Number.isFinite(marginPt) && marginPt >= 0 ? marginPt : 0,
      preset,
    });
  }, [blocked, rows, margin, pageSize, orientation, preset, convertTo]);

  // Harness bridge: native pickers are undrivable by WebDriver — e2e injects
  // the source LIST and runs the REAL conversion path. `addPaths` is the same
  // function the picker's result goes through, so an injected list and a
  // picked one cannot diverge.
  const harnessRef = useRef({ convertTo });
  harnessRef.current = { convertTo };
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
    });
    return () => registerCreatePdf(null);
  }, []);

  // Escape/backdrop obey the same busy discipline as the Close button —
  // a conversion has no cancel, and closing mid-call abandons an in-flight
  // engine job (the BatchOcr guardedClose rule; review-caught CRITICAL
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
            data-testid="create-pdf-list"
            aria-label={tChrome('dialog.createPdf.listLabel')}
          >
            {rows.map((row, index) => (
              <li
                key={row.id}
                data-testid="create-pdf-row"
                data-kind={row.kind || 'unsupported'}
                draggable={!busy}
                onDragStart={() => {
                  dragFrom.current = index;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFrom.current;
                  dragFrom.current = null;
                  if (from !== null) setRows((prev) => reorderRows(prev, from, index));
                }}
                className="flex items-center gap-2 px-2 py-1.5 text-xs"
              >
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 text-[10px] uppercase tracking-wide">
                  {row.kind
                    ? tChrome(KIND_LABEL_KEYS[row.kind] as UiKey)
                    : tChrome('dialog.createPdf.kindUnsupported')}
                </span>
                <span
                  className={`flex-1 truncate ${row.kind ? 'text-neutral-300' : 'text-red-400'}`}
                  title={row.path ?? ''}
                >
                  {row.kind === 'blank'
                    ? tChrome('dialog.createPdf.blankPage')
                    : baseName(row.path ?? '')}
                </span>
                <button
                  type="button"
                  data-testid="create-pdf-row-up"
                  aria-label={tChrome('dialog.createPdf.moveUp')}
                  className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  disabled={busy || index === 0}
                  onClick={() => setRows((prev) => moveRow(prev, row.id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-testid="create-pdf-row-down"
                  aria-label={tChrome('dialog.createPdf.moveDown')}
                  className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  disabled={busy || index === rows.length - 1}
                  onClick={() => setRows((prev) => moveRow(prev, row.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  data-testid="create-pdf-row-remove"
                  aria-label={tChrome('dialog.createPdf.remove')}
                  className="px-1 text-neutral-400 hover:text-red-400 disabled:opacity-30"
                  disabled={busy}
                  onClick={() => setRows((prev) => removeRow(prev, row.id))}
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
          <p className="text-sm text-red-400" data-testid="create-pdf-error" aria-live="polite">
            {error}
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

        <div className="flex justify-end gap-2 pt-1">
          {result && (
            <button
              type="button"
              data-testid="create-pdf-open"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
              disabled={busy}
              onClick={() => {
                // Close only when the open SETTLES — a failure (output
                // deleted/locked since conversion) surfaces here instead
                // of dying as an unhandled rejection after unmount.
                setBusy(true);
                onOpenResult(result.output)
                  .then(() => onClose())
                  .catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {tChrome('dialog.common.open')}
            </button>
          )}
          <button
            type="button"
            data-testid="create-pdf-convert"
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            disabled={blocked || busy}
            onClick={() => void convert()}
          >
            {tChrome(busy ? 'dialog.createPdf.converting' : 'dialog.createPdf.convert')}
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
    </Shell>
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
