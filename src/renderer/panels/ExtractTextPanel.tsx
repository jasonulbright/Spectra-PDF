import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOwnedDocumentRun } from '../hooks/useOwnedDocumentRun';
import { useReadAppState } from '../state/AppStateProvider';
import { runCommitGate } from '../lib/commit-gate';
import { canvasTextRequestCurrent, textExtractionDisplayCurrent,
  type CanvasTextRequest, type TextExtractionDisplay } from '../lib/extract-text-owner';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

export function ExtractTextPanel({ initialRequest, onConsumeInitialRequest }: {
  initialRequest?: CanvasTextRequest | null;
  onConsumeInitialRequest?: (request: CanvasTextRequest) => void;
} = {}): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles, state } = useActiveFile();
  const readState = useReadAppState();
  const { call, saveFile } = useEngine();
  const beginRun = useOwnedDocumentRun(activeFile);
  const [pageInput, setPageInput] = useState('all');
  const [preview, setPreview] = useState<TextExtractionDisplay | null>(null);
  const [notice, setNotice] = useState<(TextExtractionDisplay & { dirtyAllowed?: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const inputEpoch = useRef(0);
  const selectionRef = useRef(pageInput);
  selectionRef.current = pageInput;
  const changePages = useCallback((value: string) => {
    inputEpoch.current++;
    selectionRef.current = value;
    setPageInput(value);
    setPreview(null);
    setNotice(null);
  }, []);
  // Derived during render, not cleared only by a later effect: B never gets a
  // frame containing A's text or success message. Input changes also invalidate.
  const text = textExtractionDisplayCurrent(preview, state, pageInput) ? preview.value : '';
  const status = textExtractionDisplayCurrent(notice, state, pageInput, notice?.dirtyAllowed) ? notice.value : '';

  const perform = useCallback(async (save: boolean, request?: CanvasTextRequest) => {
    if (request && !canvasTextRequestCurrent(request, readState())) return;
    const run = beginRun();
    if (!run) return;
    const selection = request ? String(request.page) : pageInput;
    if (request) changePages(selection);
    const epoch = inputEpoch.current;
    const pages: number[] | 'all' = selection.trim().toLowerCase() === 'all' ? 'all'
      : selection.split(',').map(s => Number(s.trim()));
    const assertCurrent = () => {
      run.assertCurrent();
      if (inputEpoch.current !== epoch || selectionRef.current !== selection)
        throw new Error(tChrome('app.history.changed'));
    };
    const publishNotice = (value: string) => setNotice({ file: run.source, selection, value });
    setBusy(true);
    if (!save) setPreview(null);
    try {
      if (pages !== 'all' && (!pages.length || pages.some(page => !Number.isInteger(page) || page < 1)))
        throw new Error(tChrome('panel.extractText.pagesLabel'));
      await run.prepare(runCommitGate);
      assertCurrent();
      if (save) {
        // Reserve the source BEFORE the picker, then prove it again inside the
        // shared engine lock. Save retains the File menu's one export producer.
        const dest = await saveFile(`${run.source.name.replace(/\.pdf$/i, '')}.txt`);
        if (!dest) return;
        assertCurrent();
        publishNotice(tChrome('panel.extractText.saving'));
        const result = await call('export_document', {
          file: run.source.workingPath, output: dest, fmt: 'txt', pages,
        }, { assertCurrent });
        assertCurrent();
        publishNotice(tChrome('panel.extractText.saved', { chars: result.characters, path: result.output }));
      } else {
        publishNotice(tChrome('panel.extractText.extracting'));
        const result = await call('extract_text', { file: run.source.workingPath, pages }, { assertCurrent });
        assertCurrent();
        setPreview({ file: run.source, selection, value: result.text });
        publishNotice(request
          ? tChrome('panel.extractText.doneOne', { chars: result.length, page: request.page })
          : tChrome('panel.extractText.done', { chars: result.length, pages: result.pages_extracted }));
      }
    } catch (error: unknown) {
      if (run.visible() && inputEpoch.current === epoch) {
        // A same-session revision refusal should be visible on that session,
        // but a late failure must not label an unrelated document or input.
        const file = readState().files.get(run.source.path);
        if (file) setNotice({ file, selection, dirtyAllowed: true, value: tChrome('panel.common.error', {
          message: error instanceof Error ? error.message : String(error),
        }) });
      }
    } finally { run.finish(); setBusy(false); }
  }, [beginRun, call, changePages, pageInput, readState, saveFile]);

  const handleExtract = useCallback(() => perform(false), [perform]);
  const handleSave = useCallback(() => perform(true), [perform]);
  const handleCopy = useCallback(async () => {
    if (!textExtractionDisplayCurrent(preview, readState(), selectionRef.current)) return;
    const source = preview;
    try {
      await navigator.clipboard.writeText(source.value);
      if (textExtractionDisplayCurrent(source, readState(), selectionRef.current))
        setNotice({ ...source, value: tChrome('panel.extractText.copied') });
    } catch (error: unknown) {
      if (textExtractionDisplayCurrent(source, readState(), selectionRef.current))
        setNotice({ ...source, value: tChrome('panel.common.error', {
          message: error instanceof Error ? error.message : String(error),
        }) });
    }
  }, [preview, readState]);

  const consumed = useRef<CanvasTextRequest | null>(null);
  useEffect(() => {
    // A request received during another run is retained, then either proved
    // against its original view or discarded; it never rebinds to the new tab.
    if (!initialRequest || consumed.current === initialRequest || busy) return;
    consumed.current = initialRequest;
    onConsumeInitialRequest?.(initialRequest);
    void perform(false, initialRequest);
  }, [initialRequest, busy, onConsumeInitialRequest, perform]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.extractText.open')} />;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span></div>
      <div className="flex items-end gap-3">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.extractText.pagesLabel')}</label>
          <input data-testid="extract-text-pages" type="text" value={pageInput} onChange={(e) => changePages(e.target.value)}
            aria-label={tChrome('panel.extractText.pagesAria')}
            className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <button data-testid="extract-text-run" onClick={handleExtract} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium">
          {busy ? tChrome('panel.extractText.extractingBtn') : tChrome('panel.extractText.extract')}
        </button>
        {text && <button data-testid="extract-text-copy" onClick={handleCopy} className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium">{tChrome('panel.extractText.copy')}</button>}
        <button onClick={handleSave} disabled={busy} data-testid="extract-text-save" className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm font-medium">{tChrome('panel.extractText.save')}</button>
      </div>
      {text && (
        <textarea data-testid="extract-text-result" readOnly value={text} className="flex-1 min-h-[200px] px-3 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm font-mono text-neutral-300 resize-none focus:outline-none" />
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
