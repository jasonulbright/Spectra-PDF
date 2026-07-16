import React, { useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { app } from '../lib/tauri-bridge';
import { useAppModal } from '../hooks/useAppModal';
import { runCommitGate } from '../lib/commit-gate';
import { ensureGsPath } from '../panels/SettingsPanel';
import {
  buildPrintParams,
  copiesError,
  pageRangeError,
  MAX_COPIES,
  type FitMode,
} from '../lib/print-params';

// File ▸ Print… (Ctrl+P) — M-P, § 3.4. Printer picker (real winspool
// enumeration), page range, copies, fit/actual. Complete without a preview —
// § 3.4's explicit call: the dialog is a finished feature without one, as
// many shipping PDF tools' are.
//
// The job itself is the engine's `print` (bundled Ghostscript mswinpr2,
// arm's-length subprocess like compress/grayscale). `call` is trackable, so
// the commit gate flushes pending page edits before gs reads the working
// copy — what prints is what the page counter says, not the stale bytes.

export interface PrintDialogProps {
  onClose: () => void;
}

export function PrintDialog({ onClose }: PrintDialogProps): React.JSX.Element {
  const { activeFile } = useActiveFile();
  const { call } = useEngine();

  const [printers, setPrinters] = useState<string[] | null>(null);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [printer, setPrinter] = useState('');
  const [copies, setCopies] = useState('1');
  const [rangeMode, setRangeMode] = useState<'all' | 'custom'>('all');
  const [rangeText, setRangeText] = useState('');
  const [fit, setFit] = useState<FitMode>('fit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the gate has run, pageCount may describe bytes the pending page
  // edits are about to rewrite — hold validation until the number is true.
  const [gated, setGated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // FLUSH FIRST (the PropertiesDialog rule): the page count this dialog
      // validates ranges against — and the bytes gs will read — must include
      // pending page-tier edits. `call('print')` gates again at submit;
      // gating on open makes the NUMBERS right, not just the job.
      try {
        await runCommitGate();
      } catch (e: unknown) {
        if (!cancelled) setError(`Could not apply pending edits: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!cancelled) setGated(true);
      try {
        const list = await app.listPrinters();
        if (cancelled) return;
        setPrinters(list.printers);
        if (list.printers.length > 0) {
          setPrinter(list.default ?? list.printers[0]);
        }
      } catch (e: unknown) {
        if (!cancelled) setPrinterError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The command's `when` requires a showable document, but a file can close
  // underneath an open dialog.
  if (!activeFile) {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-neutral-400" data-testid="print-no-file">
          No document is open.
        </p>
      </Shell>
    );
  }

  const pageCount = activeFile.pageCount;
  const rangeErr = gated && rangeMode === 'custom' ? pageRangeError(rangeText, pageCount) : null;
  const copiesErr = copiesError(copies);
  const noPrinters = printers !== null && printers.length === 0;
  const canPrint =
    !busy && gated && printer !== '' && !rangeErr && !copiesErr &&
    (rangeMode === 'all' || rangeText.trim() !== '');

  const handlePrint = async (): Promise<void> => {
    if (!canPrint || !activeFile) return;
    setBusy(true);
    setError(null);
    try {
      await call('print', buildPrintParams({
        file: activeFile.workingPath,
        printer,
        gsPath: await ensureGsPath(),
        pages: rangeMode === 'custom' ? rangeText : '',
        copies: Number(copies.trim()),
        fit,
      }));
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="print-printer">Printer</label>
          {printerError ? (
            <p className="text-sm text-red-400" data-testid="print-printer-error">
              Could not list printers: {printerError}
            </p>
          ) : noPrinters ? (
            <p className="text-sm text-neutral-400" data-testid="print-no-printers">
              No printers are installed.
            </p>
          ) : (
            <select
              id="print-printer"
              data-testid="print-printer"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={printer}
              disabled={printers === null}
              onChange={(e) => setPrinter(e.target.value)}
            >
              {printers === null && <option value="">Looking for printers…</option>}
              {(printers ?? []).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>

        <fieldset>
          <legend className="block text-sm text-neutral-400 mb-1">Pages</legend>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="print-range"
                data-testid="print-range-all"
                checked={rangeMode === 'all'}
                onChange={() => setRangeMode('all')}
              />
              All ({pageCount} page{pageCount === 1 ? '' : 's'})
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="print-range"
                data-testid="print-range-custom"
                checked={rangeMode === 'custom'}
                onChange={() => setRangeMode('custom')}
              />
              Pages:
            </label>
            <input
              data-testid="print-range-input"
              className="flex-1 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50"
              placeholder="e.g. 1-3, 5"
              value={rangeText}
              disabled={rangeMode !== 'custom'}
              onFocus={() => setRangeMode('custom')}
              onChange={(e) => setRangeText(e.target.value)}
            />
          </div>
          {rangeErr && (
            <p className="text-xs text-red-400 mt-1" data-testid="print-range-error">{rangeErr}</p>
          )}
        </fieldset>

        <div className="flex gap-6">
          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="print-copies">Copies</label>
            <input
              id="print-copies"
              data-testid="print-copies"
              type="number"
              min={1}
              max={MAX_COPIES}
              className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
            />
            {copiesErr && (
              <p className="text-xs text-red-400 mt-1" data-testid="print-copies-error">{copiesErr}</p>
            )}
          </div>

          <fieldset>
            <legend className="block text-sm text-neutral-400 mb-1">Scale</legend>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="print-fit"
                  data-testid="print-fit-fit"
                  checked={fit === 'fit'}
                  onChange={() => setFit('fit')}
                />
                Fit to paper
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="print-fit"
                  data-testid="print-fit-actual"
                  checked={fit === 'actual'}
                  onChange={() => setFit('actual')}
                />
                Actual size
              </label>
            </div>
          </fieldset>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="print-error">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            data-testid="print-cancel"
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
          >
            Cancel
          </button>
          <button
            data-testid="print-submit"
            disabled={!canPrint}
            onClick={() => void handlePrint()}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
          >
            {busy ? 'Printing…' : 'Print'}
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
        aria-label="Print"
        data-testid="print-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Print</h3>
          <button
            data-testid="print-close"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            Close
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
