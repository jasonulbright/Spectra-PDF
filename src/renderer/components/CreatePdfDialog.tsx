import React, { useCallback, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import { TEST_HARNESS_ENABLED, registerCreatePdf } from '../testHarness';

// File ▸ Create PDF from PostScript… (Phase 8, architecture/23): the
// Distiller job on the bundled Ghostscript. A MENU dialog, not a tool
// tile — distilling needs no open document (the batch-OCR precedent, for
// the same tile-gating reason). The engine call is callRaw: the source is
// an external file, never a workspace working copy, so the commit gate
// must not run (and must not side-effect-commit unrelated pending edits).
//
// Quality presets speak Distiller's vocabulary in the UI and gs names on
// the wire (engine/distill.py maps them to -dPDFSETTINGS).

const PRESETS: { value: string; label: string }[] = [
  { value: 'screen', label: 'Smallest Size (72 dpi)' },
  { value: 'ebook', label: 'eBook (150 dpi)' },
  { value: 'printer', label: 'Print Quality (300 dpi)' },
  { value: 'prepress', label: 'Press Quality' },
  { value: 'default', label: 'Standard (Ghostscript defaults)' },
];

interface DistillResult {
  output: string;
  pages: number;
  eps: boolean;
}

export function CreatePdfDialog({
  onClose,
  onOpenResult,
}: {
  onClose: () => void;
  /** Open the created PDF through the normal open funnel; rejection is
   * surfaced IN the dialog (the fire-and-forget shape lost failures once
   * the dialog had closed — review-caught). */
  onOpenResult: (path: string) => Promise<void>;
}): React.JSX.Element {
  const { callRaw } = useEngine();
  const [source, setSource] = useState<string | null>(null);
  const [preset, setPreset] = useState('printer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DistillResult | null>(null);
  // Ref, not state: convert()'s reentrancy window opens BEFORE any state
  // updates land (the whole native save-dialog round trip) — a second
  // click read a stale busy=false closure, both clicks awaited the SAME
  // serialized dialog promise, and BOTH ran the conversion
  // (review-caught; the committingTextRef discipline).
  const convertingRef = useRef(false);

  const pickSource = useCallback(async () => {
    const picked = await dialog.pickPostScript();
    if (picked) {
      setSource(picked);
      setError(null);
      setResult(null);
    }
  }, []);

  const convertTo = useCallback(
    async (src: string, out: string, chosenPreset: string) => {
      if (convertingRef.current) return null;
      convertingRef.current = true;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const gsPath = await ensureGsPath();
        const r = (await callRaw('distill', {
          file: src,
          output: out,
          preset: chosenPreset,
          gs_path: gsPath,
        })) as unknown as DistillResult;
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
    [callRaw],
  );

  const convert = useCallback(async () => {
    // The ref is the guard (see its comment); state only drives the UI.
    if (!source || convertingRef.current) return;
    const defaultOut = source.replace(/\.(ps|eps)$/i, '') + '.pdf';
    const out = await dialog.saveFile({ defaultPath: defaultOut });
    if (!out || convertingRef.current) return;
    await convertTo(source, out, preset);
  }, [source, preset, convertTo]);

  // Harness bridge: native pickers are undrivable by WebDriver — e2e
  // injects the paths and runs the REAL conversion path.
  const harnessRef = useRef({ convertTo });
  harnessRef.current = { convertTo };
  React.useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCreatePdf({
      run: (src, out, chosenPreset) =>
        harnessRef.current.convertTo(src, out, chosenPreset ?? 'printer').then((r) => r !== null),
    });
    return () => registerCreatePdf(null);
  }, []);

  // Escape/backdrop obey the same busy discipline as the Close button —
  // distill has no cancel, and closing mid-call abandons an in-flight
  // engine job (the BatchOcr guardedClose rule; review-caught CRITICAL
  // when only the button was gated).
  const guardedClose = busy ? () => {} : onClose;

  return (
    <Shell onClose={guardedClose}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div>
          <button
            type="button"
            data-testid="create-pdf-pick"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={() => void pickSource()}
            disabled={busy}
          >
            Choose PostScript File…
          </button>
          <p className="text-xs text-neutral-400 mt-2 break-all" data-testid="create-pdf-source">
            {source ?? 'No file chosen (.ps or .eps)'}
          </p>
        </div>

        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="create-pdf-preset">
            Quality
          </label>
          <select
            id="create-pdf-preset"
            data-testid="create-pdf-preset"
            className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
            value={preset}
            disabled={busy}
            onChange={(e) => setPreset(e.target.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="create-pdf-error" aria-live="polite">
            {error}
          </p>
        )}

        {result && (
          <p className="text-sm" data-testid="create-pdf-done" aria-live="polite">
            Created {result.pages} page{result.pages === 1 ? '' : 's'} →{' '}
            <span className="break-all">{result.output}</span>
          </p>
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
              Open
            </button>
          )}
          <button
            type="button"
            data-testid="create-pdf-convert"
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            disabled={!source || busy}
            onClick={() => void convert()}
          >
            {busy ? 'Converting…' : 'Convert…'}
          </button>
          <button
            type="button"
            data-testid="create-pdf-close"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={onClose}
            disabled={busy}
          >
            Close
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
        aria-label="Create PDF from PostScript"
        data-testid="create-pdf-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Create PDF from PostScript</h3>
        </div>
        {children}
      </div>
    </div>
  );
}
