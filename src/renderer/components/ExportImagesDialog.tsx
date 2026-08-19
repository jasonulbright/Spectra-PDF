import React, { useCallback, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { gsBlocked, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from './GsRequiredNotice';
import { TEST_HARNESS_ENABLED, registerExportImages } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';

// File ▸ Export ▸ Images… (image half): render pages of the ACTIVE
// document to PNG/JPEG (one file per page) or a multi-page TIFF, on the
// bundled Ghostscript rasterizer. A dialog is required because the export has
// format, DPI, range, and grayscale options.
//
// Unlike CreatePdfDialog this targets a WORKSPACE file, so the engine call is
// the gated `call` — the commit gate flushes pending page edits first and the
// rendered images match what the user sees on canvas.

const FORMATS = [
  { value: 'png', key: 'dialog.exportImages.fmt.png' },
  { value: 'jpeg', key: 'dialog.exportImages.fmt.jpeg' },
  { value: 'tiff', key: 'dialog.exportImages.fmt.tiff' },
] as const;

const DPIS = [72, 96, 150, 300, 600];

interface ExportImagesResult {
  outputs: string[];
  format: string;
  dpi: number;
  pages_rendered: number;
}

export function ExportImagesDialog({
  file,
  onClose,
}: {
  /** The active file's working copy + display name (App passes both). */
  file: { workingPath: string; name: string };
  onClose: () => void;
}): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call } = useEngine();
  const [format, setFormat] = useState('png');
  const [dpi, setDpi] = useState(150);
  const [pages, setPages] = useState('');
  const [gray, setGray] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportImagesResult | null>(null);
  const gs = useGsCapability();
  // Reentrancy ref taken before the first await (the CreatePdf/convert rule).
  const exportingRef = useRef(false);

  const runExport = useCallback(
    async (out: string, opts: { format: string; dpi: number; pages: string; gray: boolean }) => {
      if (exportingRef.current) return null;
      exportingRef.current = true;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const r = (await call('export_images', {
          file: file.workingPath,
          output: out,
          fmt: opts.format,
          dpi: opts.dpi,
          pages: opts.pages,
          gray: opts.gray,
          gs_path: await requireGsPath(),
        })) as unknown as ExportImagesResult;
        setResult(r);
        return r;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        exportingRef.current = false;
        setBusy(false);
      }
    },
    [call, file.workingPath],
  );

  const exportImages = useCallback(async () => {
    if (exportingRef.current) return;
    const ext = format === 'png' ? 'png' : format === 'jpeg' ? 'jpg' : 'tiff';
    const base = file.name.replace(/\.pdf$/i, '');
    const out = await dialog.saveFile({ defaultPath: `${base}.${ext}` });
    if (!out || exportingRef.current) return;
    await runExport(out, { format, dpi, pages, gray });
  }, [file.name, format, dpi, pages, gray, runExport]);

  // Harness bridge: the native save dialog is undrivable — e2e injects the
  // destination and runs the REAL gated export path.
  const harnessRef = useRef({ runExport });
  harnessRef.current = { runExport };
  React.useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerExportImages({
      run: (out, opts) =>
        harnessRef.current
          .runExport(out, { format: opts?.format ?? 'png', dpi: opts?.dpi ?? 72, pages: opts?.pages ?? '', gray: !!opts?.gray })
          .then((r) => r),
    });
    return () => registerExportImages(null);
  }, []);

  // Escape/backdrop follow the button's busy discipline (guardedClose rule).
  const guardedClose = busy ? () => {} : onClose;
  const shellRef = useAppModal(guardedClose);

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={guardedClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.exportImages.aria')}
        data-testid="export-images-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.exportImages.title')}</h3>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-xs text-neutral-400 break-all">{file.name}</p>

          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-images-format">
              {tChrome('dialog.exportImages.format')}
            </label>
            <select
              id="export-images-format"
              data-testid="export-images-format"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={format}
              disabled={busy}
              onChange={(e) => setFormat(e.target.value)}
            >
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {tChrome(f.key)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-images-dpi">
                {tChrome('dialog.exportImages.resolution')}
              </label>
              <select
                id="export-images-dpi"
                data-testid="export-images-dpi"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={dpi}
                disabled={busy}
                onChange={(e) => setDpi(Number(e.target.value))}
              >
                {DPIS.map((d) => (
                  <option key={d} value={d}>
                    {tChrome('dialog.exportImages.dpiOption', { dpi: tNumber(d) })}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-images-pages">
                {tChrome('dialog.exportImages.pages')}
              </label>
              <input
                id="export-images-pages"
                data-testid="export-images-pages"
                type="text"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                placeholder={tChrome('dialog.exportImages.pagesPlaceholder')}
                spellCheck={false}
                value={pages}
                disabled={busy}
                onChange={(e) => setPages(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="export-images-gray"
              checked={gray}
              disabled={busy}
              onChange={(e) => setGray(e.target.checked)}
            />
            {tChrome('dialog.exportImages.grayscale')}
          </label>

          {error && (
            <p className="text-sm text-red-400" data-testid="export-images-error" aria-live="polite">
              {error}
            </p>
          )}
          {result && (
            <p className="text-sm break-all" data-testid="export-images-done" aria-live="polite">
              {/* One whole message; the target is a single path or a
                  pluralised file COUNT, resolved before interpolation. */}
              {tChromeCount('dialog.exportImages.done', result.pages_rendered, {
                target:
                  result.outputs.length === 1
                    ? result.outputs[0]
                    : tChromeCount('dialog.exportImages.fileCount', result.outputs.length),
              })}
            </p>
          )}

          <GsRequiredNotice capability={gs} testId="export-images-gs" />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="export-images-run"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy || gsBlocked(gs)}
              onClick={() => void exportImages()}
            >
              {tChrome(busy ? 'dialog.exportImages.exporting' : 'dialog.exportImages.export')}
            </button>
            <button
              type="button"
              data-testid="export-images-close"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
              onClick={onClose}
              disabled={busy}
            >
              {tChrome('dialog.common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
