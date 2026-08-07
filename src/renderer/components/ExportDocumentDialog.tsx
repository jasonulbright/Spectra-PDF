import React, { useCallback, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  EXPORT_TARGETS,
  exportParams,
  exportSummary,
  type DocumentExportFormat,
  type ExportDocumentResult,
} from '../lib/export-targets';

// File ▸ Export ▸ Text / Excel / PowerPoint: the three targets the engine
// produces from the document's own text and geometry. Each takes options the
// LibreOffice targets do not, which is why they open a step and the others go
// straight to the save dialog.
//
// This targets a WORKSPACE file, so the engine call is the gated `call` — the
// commit gate flushes pending page edits first and the export reads the bytes
// the user is looking at.

export type { DocumentExportFormat };

const TITLES = {
  txt: 'dialog.exportDoc.title.txt',
  xlsx: 'dialog.exportDoc.title.xlsx',
  pptx: 'dialog.exportDoc.title.pptx',
} as const;

const LAYOUTS = [
  { value: 'reading', key: 'dialog.exportDoc.layout.reading' },
  { value: 'layout', key: 'dialog.exportDoc.layout.layout' },
] as const;

const SHEET_PER = [
  { value: 'table', key: 'dialog.exportDoc.sheetPer.table' },
  { value: 'page', key: 'dialog.exportDoc.sheetPer.page' },
] as const;

const SLIDE_SIZES = [
  { value: 'page', key: 'dialog.exportDoc.slideSize.page' },
  { value: '16:9', key: 'dialog.exportDoc.slideSize.wide' },
  { value: '4:3', key: 'dialog.exportDoc.slideSize.standard' },
] as const;

export function ExportDocumentDialog({
  file,
  format,
  onClose,
  onReviewTables,
}: {
  file: { workingPath: string; name: string };
  format: DocumentExportFormat;
  onClose: () => void;
  /** Hand off to the on-page table review. An offer, not a gate: the Export
   * button beside it still runs the unreviewed export. */
  onReviewTables?: () => void;
}): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call } = useEngine();
  const [pages, setPages] = useState('');
  const [layout, setLayout] = useState('reading');
  const [pageBreaks, setPageBreaks] = useState(false);
  const [sheetPer, setSheetPer] = useState('table');
  const [includeUntabled, setIncludeUntabled] = useState(false);
  const [slideSize, setSlideSize] = useState('page');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportDocumentResult | null>(null);
  // Reentrancy ref taken before the first await (the CreatePdf/convert rule).
  const exportingRef = useRef(false);

  const runExport = useCallback(async () => {
    if (exportingRef.current) return;
    const base = file.name.replace(/\.pdf$/i, '');
    const out = await dialog.saveFile({ defaultPath: `${base}.${EXPORT_TARGETS[format].ext}` });
    if (!out || exportingRef.current) return;
    exportingRef.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const params: Record<string, unknown> = {
        file: file.workingPath,
        output: out,
        ...exportParams(format, {
          pages, layout, pageBreaks, sheetPer, includeUntabled, slideSize,
        }),
      };
      // Only the presentation target rasterises, and only it needs the renderer.
      if (format === 'pptx') params.gs_path = await ensureGsPath();
      setResult((await call('export_document', params)) as unknown as ExportDocumentResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      exportingRef.current = false;
      setBusy(false);
    }
  }, [
    call, file.name, file.workingPath, format, pages, layout, pageBreaks,
    sheetPer, includeUntabled, slideSize,
  ]);

  // Escape/backdrop follow the button's busy discipline (guardedClose rule).
  const guardedClose = busy ? () => {} : onClose;
  const shellRef = useAppModal(guardedClose);

  const summary = result ? exportSummary(format, result) : [];

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
        aria-label={tChrome('dialog.exportDoc.aria')}
        data-testid="export-document-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome(TITLES[format])}</h3>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-xs text-neutral-400 break-all">{file.name}</p>

          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-doc-pages">
              {tChrome('dialog.exportDoc.pages')}
            </label>
            <input
              id="export-doc-pages"
              data-testid="export-doc-pages"
              type="text"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              placeholder={tChrome('dialog.exportDoc.pagesPlaceholder')}
              spellCheck={false}
              value={pages}
              disabled={busy}
              onChange={(e) => setPages(e.target.value)}
            />
          </div>

          {format === 'txt' && (
            <>
              <div>
                <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-doc-layout">
                  {tChrome('dialog.exportDoc.layout')}
                </label>
                <select
                  id="export-doc-layout"
                  data-testid="export-doc-layout"
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={layout}
                  disabled={busy}
                  onChange={(e) => setLayout(e.target.value)}
                >
                  {LAYOUTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tChrome(option.key)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="export-doc-page-breaks"
                  checked={pageBreaks}
                  disabled={busy}
                  onChange={(e) => setPageBreaks(e.target.checked)}
                />
                {tChrome('dialog.exportDoc.pageBreaks')}
              </label>
            </>
          )}

          {format === 'xlsx' && (
            <>
              <div>
                <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-doc-sheet-per">
                  {tChrome('dialog.exportDoc.sheetPer')}
                </label>
                <select
                  id="export-doc-sheet-per"
                  data-testid="export-doc-sheet-per"
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={sheetPer}
                  disabled={busy}
                  onChange={(e) => setSheetPer(e.target.value)}
                >
                  {SHEET_PER.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tChrome(option.key)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="export-doc-include-untabled"
                  checked={includeUntabled}
                  disabled={busy}
                  onChange={(e) => setIncludeUntabled(e.target.checked)}
                />
                {tChrome('dialog.exportDoc.includeUntabled')}
              </label>
              {onReviewTables && (
                <div>
                  <button
                    type="button"
                    data-testid="export-doc-review-tables"
                    className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded text-sm"
                    disabled={busy}
                    onClick={onReviewTables}
                  >
                    {tChrome('dialog.exportDoc.reviewTables')}
                  </button>
                  <p className="mt-1 text-xs text-neutral-400">
                    {tChrome('dialog.exportDoc.reviewTablesHint')}
                  </p>
                </div>
              )}
            </>
          )}

          {format === 'pptx' && (
            <div>
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="export-doc-slide-size">
                {tChrome('dialog.exportDoc.slideSize')}
              </label>
              <select
                id="export-doc-slide-size"
                data-testid="export-doc-slide-size"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={slideSize}
                disabled={busy}
                onChange={(e) => setSlideSize(e.target.value)}
              >
                {SLIDE_SIZES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {tChrome(option.key)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400" data-testid="export-doc-error" aria-live="polite">
              {error}
            </p>
          )}
          {summary.length > 0 && (
            <div className="text-sm break-all" data-testid="export-doc-done" aria-live="polite">
              {summary.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-neutral-800">
          <button
            type="button"
            onClick={guardedClose}
            disabled={busy}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded text-sm"
          >
            {result ? tChrome('dialog.exportDoc.close') : tChrome('dialog.exportDoc.cancel')}
          </button>
          <button
            type="button"
            data-testid="export-doc-run"
            onClick={runExport}
            disabled={busy}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {busy ? tChrome('dialog.exportDoc.exporting') : tChrome('dialog.exportDoc.export')}
          </button>
        </div>
      </div>
    </div>
  );
}
