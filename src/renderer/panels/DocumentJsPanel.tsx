import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerDocumentJsHandler } from '../testHarness';

// Phase 9.S6 — the "Document JavaScripts" editor. Reads and rewrites the
// catalog's /Names /JavaScript name tree as TEXT. The app NEVER executes the
// scripts (DECISIONS #33) — this is an editor, not an interpreter. Saving
// routes through the undoable in-place workspace flow (like every content
// edit), so the change lands on the working copy and is written to disk on
// Save. No Monaco: a plain monospace textarea keeps the dependency footprint
// flat (DECISIONS #4), and document JavaScript is edited, not run, here.

interface DocScript {
  name: string;
  js: string;
}

export function DocumentJsPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();

  const [scripts, setScripts] = useState<DocScript[]>([]);
  const [baseline, setBaseline] = useState<DocScript[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const load = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await call('list_document_js', { file: workingPath })) as unknown as {
        scripts: DocScript[];
      };
      const list = res.scripts ?? [];
      setScripts(list);
      setBaseline(list);
      setSelected(0);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [workingPath, call]);

  // Reload whenever the active document changes (mount + switch + after a save
  // reloads the working copy).
  useEffect(() => {
    if (path) void load();
    else {
      setScripts([]);
      setBaseline([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const dirty = JSON.stringify(scripts) !== JSON.stringify(baseline);
  const sel = selected < scripts.length ? scripts[selected] : null;

  const addScript = useCallback(() => {
    setScripts((prev) => {
      // A unique default name so two "Add"s never collide (the engine refuses
      // duplicates, but the UI should not create them in the first place).
      const used = new Set(prev.map((s) => s.name));
      let n = prev.length + 1;
      let name = `Script${n}`;
      while (used.has(name)) name = `Script${++n}`;
      setSelected(prev.length);
      return [...prev, { name, js: '' }];
    });
  }, []);

  const updateSelected = useCallback(
    (patch: Partial<DocScript>) => {
      setScripts((prev) => prev.map((s, i) => (i === selected ? { ...s, ...patch } : s)));
    },
    [selected],
  );

  const removeSelected = useCallback(() => {
    setScripts((prev) => prev.filter((_, i) => i !== selected));
    setSelected((i) => Math.max(0, i - 1));
  }, [selected]);

  const savingRef = useRef(false);
  const save = useCallback(async () => {
    if (!activeFile || savingRef.current) return;
    // Validate up front for a clear message (the engine also refuses).
    const names = scripts.map((s) => s.name.trim());
    if (names.some((n) => !n)) {
      setError('Every script needs a name.');
      return;
    }
    if (new Set(names).size !== names.length) {
      setError('Two scripts have the same name — names must be unique.');
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setStatus('Saving document scripts…');
    try {
      await performOperation(activeFile.path, 'set_document_js', {
        scripts: scripts.map((s) => ({ name: s.name.trim(), js: s.js })),
      });
      setStatus('');
      await load(); // re-read the now-updated working copy → new baseline
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [activeFile, scripts, performOperation, load]);

  // e2e hooks: set the active document's JS (undoable, via performOperation)
  // and read it back — the native-free equivalent of driving the panel by hand
  // (refs so the once-registered effect never closes over stale state).
  const activePathRef = useRef(activeFile?.path ?? null);
  activePathRef.current = activeFile?.path ?? null;
  const workingPathRef = useRef(workingPath);
  workingPathRef.current = workingPath;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerDocumentJsHandler({
      set: async (list) => {
        const p = activePathRef.current;
        if (!p) throw new Error('No active document.');
        await performOperation(p, 'set_document_js', { scripts: list });
        await load();
      },
      list: async () => {
        const wp = workingPathRef.current;
        if (!wp) return [];
        const r = (await call('list_document_js', { file: wp })) as unknown as {
          scripts: DocScript[];
        };
        return r.scripts ?? [];
      },
    });
    return () => registerDocumentJsHandler(null);
  }, [performOperation, call, load]);

  if (!activeFile)
    return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to edit its document JavaScript" />;

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="shrink-0 flex items-center gap-3">
        <div className="text-sm text-neutral-400">
          Document JavaScript in <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="docjs-add"
          onClick={addScript}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium"
        >
          + Add script
        </button>
        <button
          data-testid="docjs-save"
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="px-2.5 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 rounded font-medium"
        >
          Save scripts
        </button>
      </div>

      <p className="shrink-0 text-xs text-neutral-500 -mt-1">
        These scripts run when the document is opened in a PDF reader. This editor never runs
        them — it only reads and writes the text.
      </p>

      {scripts.length === 0 && !busy ? (
        <div data-testid="docjs-empty" className="text-sm text-neutral-500">
          This PDF has no document-level JavaScript. Use <em>Add script</em> to create one.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3">
          {/* Script list */}
          <ul
            data-testid="docjs-list"
            className="w-44 shrink-0 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/50 p-1 flex flex-col gap-0.5"
          >
            {scripts.map((s, i) => (
              <li key={i}>
                <button
                  data-testid={`docjs-item-${i}`}
                  onClick={() => setSelected(i)}
                  className={`w-full text-left px-2 py-1 text-xs rounded truncate ${
                    i === selected
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800'
                  }`}
                  title={s.name}
                >
                  {s.name || '(unnamed)'}
                </button>
              </li>
            ))}
          </ul>

          {/* Editor for the selected script */}
          {sel && (
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400 shrink-0">Name</span>
                <input
                  data-testid="docjs-name"
                  type="text"
                  value={sel.name}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                  className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
                />
                <button
                  data-testid="docjs-delete"
                  onClick={removeSelected}
                  className="px-2.5 py-1 text-xs bg-red-700/70 hover:bg-red-600 rounded font-medium"
                >
                  Delete
                </button>
              </div>
              <textarea
                data-testid="docjs-editor"
                value={sel.js}
                spellCheck={false}
                onChange={(e) => updateSelected({ js: e.target.value })}
                className="flex-1 min-h-0 w-full px-2.5 py-2 bg-neutral-950 border border-neutral-700 rounded text-xs font-mono resize-none focus:outline-none focus:border-blue-500"
                placeholder="// document-level JavaScript"
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div data-testid="docjs-error" className="shrink-0 text-xs text-red-400" aria-live="polite">
          {error}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
