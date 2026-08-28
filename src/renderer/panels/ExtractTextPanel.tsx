import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

export function ExtractTextPanel({ initialPage, onConsumeInitialPage }: { initialPage?: number | null; onConsumeInitialPage?: () => void } = {}): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [pageInput, setPageInput] = useState('all');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const scopedPages = useCallback(
    (): number[] | 'all' =>
      pageInput.trim().toLowerCase() === 'all'
        ? 'all'
        : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n)),
    [pageInput],
  );

  const handleExtract = useCallback(async () => {
    if (!activeFile) return;
    const pages = scopedPages();
    setBusy(true); setStatus(tChrome('panel.extractText.extracting'));
    try {
      const r = await call('extract_text', { file: activeFile.workingPath, pages });
      setText(r.text);
      setStatus(tChrome('panel.extractText.done', { chars: r.length, pages: r.pages_extracted }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, scopedPages, call]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setStatus(tChrome('panel.extractText.copied'));
  }, [text]);

  // Writing the file routes through the same export door the File menu uses —
  // one producer, two entry points — so the panel never grows a second way to
  // put a document's text on disk.
  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const dest = await saveFile(`${activeFile.name.replace(/\.pdf$/i, '')}.txt`);
    if (!dest) return;
    setBusy(true); setStatus(tChrome('panel.extractText.saving'));
    try {
      const r = await call('export_document', {
        file: activeFile.workingPath, output: dest, fmt: 'txt', pages: scopedPages(),
      });
      setStatus(tChrome('panel.extractText.saved', { chars: r.characters, path: r.output }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, scopedPages, saveFile, call]);

  // Auto-extract when triggered from the canvas context menu. Fires exactly
  // once per initialPage arrival — everything else is read through refs
  // (the stable-listener pattern): depending on `busy` would re-fire the
  // extraction the moment it completes, and depending on `activeFile` would
  // re-fire on every buffer swap.
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const callRef = useRef(call);
  callRef.current = call;
  const consumeRef = useRef(onConsumeInitialPage);
  consumeRef.current = onConsumeInitialPage;
  useEffect(() => {
    const file = activeFileRef.current;
    if (!initialPage || !file || busyRef.current) return;
    setPageInput(String(initialPage));
    consumeRef.current?.();
    // Auto-run extraction
    const pages = [initialPage];
    setBusy(true); setStatus(tChrome('panel.extractText.extracting'));
    callRef.current('extract_text', { file: file.workingPath, pages }).then((r) => {
      setText(r.text);
      setStatus(tChrome('panel.extractText.doneOne', { chars: r.length, page: initialPage }));
    }).catch((e: unknown) => setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }))).finally(() => setBusy(false));
  }, [initialPage]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.extractText.open')} />;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span></div>
      <div className="flex items-end gap-3">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.extractText.pagesLabel')}</label>
          <input type="text" value={pageInput} onChange={(e) => setPageInput(e.target.value)}
            aria-label={tChrome('panel.extractText.pagesAria')}
            className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <button onClick={handleExtract} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium">
          {busy ? tChrome('panel.extractText.extractingBtn') : tChrome('panel.extractText.extract')}
        </button>
        {text && <button onClick={handleCopy} className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium">{tChrome('panel.extractText.copy')}</button>}
        <button onClick={handleSave} disabled={busy} data-testid="extract-text-save" className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm font-medium">{tChrome('panel.extractText.save')}</button>
      </div>
      {text && (
        <textarea readOnly value={text} className="flex-1 min-h-[200px] px-3 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm font-mono text-neutral-300 resize-none focus:outline-none" />
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
