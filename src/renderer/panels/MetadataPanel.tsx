import React, { useState, useCallback, useEffect } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

export function MetadataPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('');
  const [keywords, setKeywords] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load metadata when the active FILE changes. Keyed on workingPath (stable
  // per path, unlike the activeFile object which swaps on every buffer
  // update) — reading the whole object inside while depending on `?.path`
  // was the lint-suppressed version of exactly this.
  const workingPath = activeFile?.workingPath ?? null;
  useEffect(() => {
    if (!workingPath) { setLoaded(false); return; }
    let cancelled = false;
    call('get_metadata', { file: workingPath }).then((r) => {
      if (cancelled) return;
      setTitle(r.title || '');
      setAuthor(r.author || '');
      setSubject(r.subject || '');
      setKeywords(r.keywords || '');
      setLoaded(true);
      setStatus(`Loaded metadata (${r.pages} pages)`);
    }).catch((e: unknown) => { if (!cancelled) setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { cancelled = true; };
  }, [workingPath, call]);

  const handleStrip = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('stripped.pdf');
    if (!output) return;
    setBusy(true); setStatus('Stripping metadata...');
    try {
      await call('strip_metadata', { file: activeFile.workingPath, output });
      setTitle(''); setAuthor(''); setSubject(''); setKeywords('');
      setStatus('All metadata removed');
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('metadata-updated.pdf');
    if (!output) return;
    setBusy(true); setStatus('Saving metadata...');
    try {
      const r = await call('set_metadata', { file: activeFile.workingPath, output, title, author, subject, keywords });
      setStatus(`Updated: ${r.updated_fields.join(', ')}`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, title, author, subject, keywords, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to edit metadata" />;

  const fields = [
    { label: 'Title', value: title, set: setTitle },
    { label: 'Author', value: author, set: setAuthor },
    { label: 'Subject', value: subject, set: setSubject },
    { label: 'Keywords', value: keywords, set: setKeywords },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span></div>
      {loaded && fields.map((f) => (
        <div key={f.label}>
          <label className="block text-sm text-neutral-400 mb-1">{f.label}</label>
          <input type="text" value={f.value} onChange={(e) => f.set(e.target.value)}
            className="w-96 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
      ))}
      {loaded && (
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
            {busy ? 'Saving...' : 'Save Metadata'}
          </button>
          <button onClick={handleStrip} disabled={busy} className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm font-medium text-neutral-300">
            {busy ? 'Stripping...' : 'Strip All Metadata'}
          </button>
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
