import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { app, dialog } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import { TEST_HARNESS_ENABLED, registerCombine, type CombineRunOptions } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, type UiKey } from '../i18n';
import {
  KIND_LABEL_KEYS,
  type SourceRow,
  addPaths,
  baseName,
  blankRow,
  defaultOutputPath,
  moveRow,
  removeRow,
  reorderRows,
  toEngineSources,
} from '../lib/create-pdf';
import {
  CONVERTER_LABEL_KEYS,
  type CombineDestination,
  type CombineSourceReport,
  type CombineTarget,
  applyReport,
  clearRowResults,
  combineBlocker,
  isValidPageRange,
  plannedPages,
  rowContribution,
  setRowContributed,
  setRowError,
  setRowPageCount,
  setRowRange,
  supportsPageRange,
} from '../lib/combine';

// Document ▸ Combine Files.
//
// Combine used to be `openFiles()` → the page-tier import, which meant PDFs
// only — a `.docx` cannot enter the page tier. The widening is NOT "let the
// picker take more extensions and hope": non-PDF members are CONVERTED first,
// through the one `create_pdf` door, and only then assembled.
//
// Two targets, and the difference between them is where the assembly happens:
//
//   * A NEW document is one `create_pdf` call over the whole list — so the
//     assembly is the SHIPPED merge and the /AcroForm, outline, struct-tree
//     and embedded-file carries come for free (the structural-page-ops
//     invariant, met by reusing the path that already meets it).
//   * An OPEN document converts each member on its own and hands the results
//     to the EXISTING byte-only `importFilesIntoDoc` path — so combining into
//     a document stays undoable page-tier work with zero new commit paths.
//     A PDF member with no range skips the engine entirely and is imported
//     from its ORIGINAL path, which is what keeps its pages' provenance (a
//     temp copy would make every imported page claim to come from a scratch
//     file that no longer exists).
//
// Engine calls are `callRaw`: every source is an external file and the output
// is a new file or a scratch temp — never a workspace working copy — so the
// commit gate must not run and must not side-effect-commit unrelated pending
// page edits. The operation QUEUE is a different mechanism and this does
// belong in it, so the call is wrapped in `track` directly (the Create PDF
// composition).

interface CombineResult {
  output: string;
  pages: number;
  sources: CombineSourceReport[];
  warnings?: string[];
}

export function CombineDialog({
  onClose,
  onOpenResult,
  destinations,
  workingDirFor,
  onAppend,
  initialPaths,
}: {
  onClose: () => void;
  /** Open a newly created PDF through the normal open funnel. Rejection is
   * surfaced IN the dialog — a fire-and-forget open loses failures once the
   * dialog has closed (the Create PDF review catch). */
  onOpenResult: (path: string) => Promise<void>;
  /** The documents the user can add pages to — real, showable documents
   * only; a byte-only import ghost is never one of them. */
  destinations: readonly CombineDestination[];
  /** Where scratch conversions for an append may be written: the directory
   * holding that document's working copy, which exists by construction and
   * is inside the fs capability's scope. Null when there is no working copy. */
  workingDirFor: (docId: string) => string | null;
  /** Import the converted members into a document, at its end. */
  onAppend: (docId: string, paths: string[]) => Promise<void>;
  /** Sources the dialog opens pre-populated with — a drop on the window
   * while Combine is open lands here (drop-to-combine). */
  initialPaths?: readonly string[];
}): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();
  const { track } = useOperationQueue();
  const [rows, setRows] = useState<SourceRow[]>(() => addPaths([], initialPaths ?? []));
  const [target, setTarget] = useState<CombineTarget>(
    destinations.length > 0 ? 'append' : 'new',
  );
  const [destinationId, setDestinationId] = useState<string>(destinations[0]?.docId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CombineResult | null>(null);
  const [appended, setAppended] = useState<{ pages: number; name: string } | null>(null);
  const dragFrom = useRef<number | null>(null);
  // Ref, not state: the reentrancy window opens BEFORE any state update lands
  // (the whole native save-dialog round trip), so a second click reads a stale
  // busy=false closure and BOTH runs proceed — the convertingRef discipline,
  // carried over verbatim from Create PDF because it was regression there.
  const combiningRef = useRef(false);

  // A drop that arrives while the dialog is already open must still land.
  // Keyed by a SERIALISED list, not by array identity: the parent rebuilds the
  // array every render, and a Windows path contains spaces so a naive join is
  // also unsound. `addPaths` skips what is listed, so a repeat is a no-op.
  const seedKey = JSON.stringify(initialPaths ?? []);
  useEffect(() => {
    const seeded = JSON.parse(seedKey) as string[];
    if (seeded.length === 0) return;
    setRows((prev) => addPaths(prev, seeded));
  }, [seedKey]);

  const destination = useMemo(
    () => destinations.find((d) => d.docId === destinationId) ?? null,
    [destinations, destinationId],
  );

  // Page counts for PDF members, probed once each. It is what makes the range
  // field a choice rather than a guess — and `get_page_count` is a pure read
  // on an EXTERNAL file, so it goes through callRaw (no gate, no queue line).
  const probedRef = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    const pending = rows.filter(
      (row) =>
        row.kind === 'pdf' &&
        row.path !== undefined &&
        row.pageCount === undefined &&
        !probedRef.current.has(row.id),
    );
    if (pending.length === 0) return;
    for (const row of pending) probedRef.current.add(row.id);
    void (async () => {
      for (const row of pending) {
        try {
          const info = (await callRaw('get_page_count', { file: row.path })) as { pages: number };
          if (cancelled) return;
          setRows((prev) => setRowPageCount(prev, row.id, info.pages));
        } catch (err) {
          if (cancelled) return;
          // An unreadable PDF is a REFUSED row, not a row with no count —
          // otherwise it sits there looking fine until the run fails.
          setRows((prev) =>
            setRowError(prev, row.id, err instanceof Error ? err.message : String(err)),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, callRaw]);

  const blockerKey = combineBlocker(rows, target, destination);
  const planned = useMemo(() => plannedPages(rows), [rows]);

  const addSources = useCallback(async () => {
    const picked = await dialog.pickCreatePdfSources();
    if (picked.length > 0) {
      setRows((prev) => addPaths(prev, picked));
      setError(null);
      setResult(null);
      setAppended(null);
    }
  }, []);

  const addBlank = useCallback(() => {
    setRows((prev) => [...prev, blankRow()]);
    setError(null);
    setResult(null);
    setAppended(null);
  }, []);

  /** Both converters resolve up front: which arms a run needs depends on the
   * LIST, and asking per row would stall the run half-way through it. */
  const toolPaths = useCallback(
    async () => {
      const [gsPath, sofficePath] = await Promise.all([ensureGsPath(), app.getSofficePath()]);
      return { gs_path: gsPath, soffice_path: sofficePath };
    },
    [],
  );

  const combineIntoNew = useCallback(
    async (sourceRows: readonly SourceRow[], out: string): Promise<CombineResult | null> => {
      const tools = await toolPaths();
      // `skip`, not `refuse`: Combine reports per-row state and lets the user
      // decide, and a skipped row is NEVER silent — it comes back carrying its
      // own error, which `applyReport` puts on the row.
      const r = (await track('create_pdf', { file: out }, () =>
        callRaw('create_pdf', {
          sources: toEngineSources(sourceRows),
          output: out,
          on_unsupported: 'skip',
          ...tools,
        }),
      )) as unknown as CombineResult;
      setRows((prev) => applyReport(prev, r.sources ?? []));
      setResult(r);
      return r;
    },
    [callRaw, track, toolPaths],
  );

  const combineIntoOpen = useCallback(
    async (sourceRows: readonly SourceRow[], docId: string, name: string): Promise<number> => {
      const dir = workingDirFor(docId);
      if (dir === null) throw new Error(tChrome('dialog.combine.noWorkingCopy'));
      const sep = dir.includes('\\') ? '\\' : '/';
      const tools = await toolPaths();
      const produced: string[] = [];
      let pages = 0;
      for (const row of sourceRows) {
        const spec = (row.pages ?? '').trim();
        if (row.kind === 'pdf' && spec === '' && row.path) {
          try {
            // Counted exactly, not "as far as the probe happened to get" — a
            // run started before the background probe settled would otherwise
            // report fewer pages than it added.
            let count = row.pageCount;
            if (typeof count !== 'number') {
              const info = (await callRaw('get_page_count', { file: row.path })) as {
                pages: number;
              };
              count = info.pages;
              const settled = count;
              setRows((prev) => setRowPageCount(prev, row.id, settled));
            }
            produced.push(row.path);
            pages += count;
            const contributed = count;
            setRows((prev) => setRowContributed(prev, row.id, contributed));
          } catch (err) {
            setRows((prev) =>
              setRowError(prev, row.id, err instanceof Error ? err.message : String(err)),
            );
          }
          continue;
        }
        const temp = `${dir}${sep}combine-${crypto.randomUUID()}.pdf`;
        try {
          const r = (await track('create_pdf', { file: temp }, () =>
            callRaw('create_pdf', {
              sources: toEngineSources([row]),
              output: temp,
              ...tools,
            }),
          )) as unknown as CombineResult;
          produced.push(temp);
          pages += r.pages;
          setRows((prev) => setRowContributed(prev, row.id, r.pages));
        } catch (err) {
          // Per-member isolation, the same contract the `skip` run has: the
          // row says why and the rest of the combine still happens.
          setRows((prev) =>
            setRowError(prev, row.id, err instanceof Error ? err.message : String(err)),
          );
        }
      }
      if (produced.length === 0) {
        throw new Error(tChrome('dialog.combine.nothingConverted'));
      }
      await onAppend(docId, produced);
      setAppended({ pages, name });
      return pages;
    },
    [callRaw, track, toolPaths, workingDirFor, onAppend],
  );

  const run = useCallback(
    async (
      sourceRows: readonly SourceRow[],
      options: CombineRunOptions,
    ): Promise<{ output: string; pages: number } | null> => {
      if (combiningRef.current) return null;
      // The blocker is checked HERE, not only where the button is disabled:
      // the harness reaches this function directly, and a gate that only the
      // button honours is a gate the e2e cannot prove.
      const runTarget = options.target ?? target;
      const runDocId = options.docId ?? destinationId;
      const runDestination = destinations.find((d) => d.docId === runDocId) ?? null;
      if (combineBlocker(sourceRows, runTarget, runDestination) !== null) return null;
      combiningRef.current = true;
      setBusy(true);
      setError(null);
      setResult(null);
      setAppended(null);
      setRows((prev) => clearRowResults(prev));
      try {
        if (runTarget === 'append') {
          const pages = await combineIntoOpen(
            sourceRows,
            runDocId,
            runDestination?.name ?? '',
          );
          return { output: '', pages };
        }
        const r = await combineIntoNew(sourceRows, options.output ?? '');
        return r === null ? null : { output: r.output, pages: r.pages };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        combiningRef.current = false;
        setBusy(false);
      }
    },
    [combineIntoNew, combineIntoOpen, destinationId, destinations, target],
  );

  const combine = useCallback(async () => {
    // The ref is the guard (see its comment); state only drives the UI.
    if (blockerKey !== null || combiningRef.current) return;
    if (target === 'append') {
      await run(rows, { target: 'append', docId: destinationId });
      return;
    }
    const suggested = defaultOutputPath(rows) ?? 'combined.pdf';
    const out = await dialog.saveFile({ defaultPath: suggested });
    if (!out || combiningRef.current) return;
    await run(rows, { target: 'new', output: out });
  }, [blockerKey, target, rows, destinationId, run]);

  // Harness bridge: native pickers are undrivable by WebDriver, so e2e injects
  // the source LIST and the output and runs the REAL path. Injected sources go
  // through the SAME `addPaths` a picked list does.
  const harnessRef = useRef({ run });
  harnessRef.current = { run };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCombine({
      run: (sources, output, options) => {
        const injected = sources.reduce<SourceRow[]>(
          (acc, source) =>
            source === '__blank__' ? [...acc, blankRow()] : addPaths(acc, [source]),
          [],
        );
        const ranged = (options?.ranges ?? []).reduce(
          (acc, spec, index) =>
            spec && injected[index] ? setRowRange(acc, injected[index].id, spec) : acc,
          injected,
        );
        setRows(ranged);
        if (options?.target === 'append') setTarget('append');
        if (options?.docId) setDestinationId(options.docId);
        return harnessRef.current.run(ranged, { ...options, output });
      },
    });
    return () => registerCombine(null);
  }, []);

  // Escape/backdrop obey the same busy discipline as the Close button — a
  // combine has no cancel, and closing mid-call abandons an in-flight engine
  // job (the BatchOcr guardedClose rule).
  const guardedClose = busy ? () => {} : onClose;

  return (
    <Shell onClose={guardedClose}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="combine-pick"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={() => void addSources()}
            disabled={busy}
          >
            {tChrome('dialog.combine.addFiles')}
          </button>
          <button
            type="button"
            data-testid="combine-add-blank"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={addBlank}
            disabled={busy}
          >
            {tChrome('dialog.combine.addBlank')}
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-neutral-400" data-testid="combine-empty">
            {tChrome('dialog.combine.empty')}
          </p>
        ) : (
          <ul
            className="flex flex-col border border-neutral-800 rounded divide-y divide-neutral-800 max-h-64 overflow-y-auto"
            data-testid="combine-list"
            aria-label={tChrome('dialog.combine.listLabel')}
          >
            {rows.map((row, index) => {
              const contribution = rowContribution(row);
              const rangeOk = isValidPageRange(row.pages ?? '');
              return (
                <li
                  key={row.id}
                  data-testid="combine-row"
                  data-kind={row.kind || 'unsupported'}
                  data-state={row.kind === '' ? 'unsupported' : row.error ? 'error' : 'ready'}
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
                  className="flex flex-col gap-0.5 px-2 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
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
                    {supportsPageRange(row) && (
                      <input
                        type="text"
                        data-testid="combine-row-range"
                        aria-label={tChrome('dialog.combine.pagesAria', {
                          name: baseName(row.path ?? ''),
                        })}
                        placeholder={tChrome('dialog.combine.pagesAll')}
                        className={`w-20 px-1.5 py-0.5 bg-neutral-800 border rounded text-xs ${
                          rangeOk ? 'border-neutral-700' : 'border-red-500'
                        }`}
                        value={row.pages ?? ''}
                        disabled={busy}
                        onChange={(e) => setRows((prev) => setRowRange(prev, row.id, e.target.value))}
                      />
                    )}
                    <button
                      type="button"
                      data-testid="combine-row-up"
                      aria-label={tChrome('dialog.createPdf.moveUp')}
                      className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                      disabled={busy || index === 0}
                      onClick={() => setRows((prev) => moveRow(prev, row.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-testid="combine-row-down"
                      aria-label={tChrome('dialog.createPdf.moveDown')}
                      className="px-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                      disabled={busy || index === rows.length - 1}
                      onClick={() => setRows((prev) => moveRow(prev, row.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      data-testid="combine-row-remove"
                      aria-label={tChrome('dialog.createPdf.remove')}
                      className="px-1 text-neutral-400 hover:text-red-400 disabled:opacity-30"
                      disabled={busy}
                      onClick={() => setRows((prev) => removeRow(prev, row.id))}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2 ps-1 text-[10px]">
                    <span className="text-neutral-500" data-testid="combine-row-converter">
                      {row.kind
                        ? tChrome(CONVERTER_LABEL_KEYS[row.kind] as UiKey)
                        : tChrome('dialog.combine.viaNothing')}
                    </span>
                    {contribution !== null && (
                      <span className="text-neutral-500" data-testid="combine-row-pages">
                        {tChromeCount('dialog.combine.pageCount', contribution)}
                      </span>
                    )}
                    {row.error && (
                      <span className="text-red-400 truncate" data-testid="combine-row-error">
                        {row.error}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs text-neutral-400 mb-1">
            {tChrome('dialog.combine.target')}
          </legend>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="radio"
              name="combine-target"
              data-testid="combine-target-new"
              checked={target === 'new'}
              disabled={busy}
              onChange={() => setTarget('new')}
            />
            {tChrome('dialog.combine.targetNew')}
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              type="radio"
              name="combine-target"
              data-testid="combine-target-append"
              checked={target === 'append'}
              disabled={busy || destinations.length === 0}
              onChange={() => setTarget('append')}
            />
            {tChrome('dialog.combine.targetAppend')}
          </label>
          {target === 'append' &&
            (destinations.length === 0 ? (
              <p className="text-xs text-neutral-500 ps-6" data-testid="combine-no-destination">
                {tChrome('dialog.combine.noDestinations')}
              </p>
            ) : (
              <select
                data-testid="combine-destination"
                aria-label={tChrome('dialog.combine.destination')}
                className="ms-6 px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={destinationId}
                disabled={busy}
                onChange={(e) => setDestinationId(e.target.value)}
              >
                {destinations.map((d) => (
                  <option key={d.docId} value={d.docId}>
                    {tChromeCount('dialog.combine.destinationOption', d.pages, { name: d.name })}
                  </option>
                ))}
              </select>
            ))}
        </fieldset>

        <p className="text-xs text-neutral-400" data-testid="combine-planned" aria-live="polite">
          {planned.known
            ? tChromeCount('dialog.combine.planned', planned.pages)
            : tChrome('dialog.combine.plannedUnknown')}
        </p>

        {blockerKey !== null && rows.length > 0 && (
          <p className="text-sm text-amber-400" data-testid="combine-blocked" aria-live="polite">
            {tChrome(blockerKey as UiKey)}
          </p>
        )}

        {error && (
          <p className="text-sm text-red-400" data-testid="combine-error" aria-live="polite">
            {error}
          </p>
        )}

        {result && (
          <div aria-live="polite">
            <p className="text-sm break-all" data-testid="combine-done">
              {tChromeCount('dialog.combine.done', result.pages, { path: result.output })}
            </p>
            {(result.warnings ?? []).map((warning) => (
              <p key={warning} className="text-xs text-amber-400 mt-1" data-testid="combine-warning">
                {warning}
              </p>
            ))}
          </div>
        )}

        {appended && (
          <p className="text-sm" data-testid="combine-appended" aria-live="polite">
            {tChromeCount('dialog.combine.appended', appended.pages, { name: appended.name })}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {result && (
            <button
              type="button"
              data-testid="combine-open"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
              disabled={busy}
              onClick={() => {
                // Close only when the open SETTLES — a failure surfaces here
                // instead of dying as an unhandled rejection after unmount.
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
            data-testid="combine-run"
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            disabled={blockerKey !== null || busy}
            onClick={() => void combine()}
          >
            {tChrome(busy ? 'dialog.combine.combining' : 'dialog.combine.combine')}
          </button>
          <button
            type="button"
            data-testid="combine-close"
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

function Shell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
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
        aria-label={tChrome('dialog.combine.title')}
        data-testid="combine-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[600px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.combine.title')}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}
