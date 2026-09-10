import React, { useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { useDocumentJsDrafts } from '../state/AppStateProvider';
import { parseDocumentJsRead, validateScripts, type DocScript } from '../lib/document-js-drafts';
import { runCommitGate } from '../lib/commit-gate';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerDocumentJsHandler } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

// Edits document JavaScript as text, never executes it. The provider owns
// unsaved text; a panel remount or an active-document switch owns none of it.
export function DocumentJsPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const drafts = useDocumentJsDrafts(), draft = drafts.get(activeFile);
  const scripts = draft?.scripts ?? [], selected = draft?.selected ?? 0;
  const editable = !!draft && drafts.editable(draft), conflict = !!draft && drafts.conflict(draft);
  const busy = !!draft?.busy, dirty = !!draft?.dirty, buffer = draft?.buffer ?? null;
  const error = conflict ? tChrome('panel.docjs.sourceChanged') : draft?.error || '';
  const status = busy ? tChrome('panel.docjs.saving') : '';
  const sel = scripts[selected] ?? null;
  useEffect(() => { if (draft) void drafts.load(draft, call); });
  useEffect(() => () => { if (draft) drafts.cancelLoad(draft); }, [draft, drafts]);
  const addScript = useCallback(() => {
    if (!draft) return;
    const index = draft.scripts.length;
    drafts.change(draft, buffer, prev => {
      const used = new Set(prev.map(s => s.name)); let n = prev.length + 1;
      while (used.has(`Script${n}`)) n++;
      return [...prev, { name: `Script${n}`, js: '' }];
    });
    drafts.select(draft, index);
  }, [draft, drafts, buffer]);
  const updateSelected = useCallback((patch: Partial<DocScript>) => {
    if (draft) drafts.change(draft, buffer, prev => prev.map((s, i) => i === selected ? { ...s, ...patch } : s));
  }, [draft, drafts, buffer, selected]);
  const removeSelected = useCallback(() => {
    if (draft) drafts.change(draft, buffer, prev => prev.filter((_, i) => i !== selected));
  }, [draft, drafts, buffer, selected]);
  const save = useCallback(async () => {
    if (draft) await drafts.save(draft, performOperation);
  }, [draft, drafts, performOperation]);
  const draftRef = useRef(draft); draftRef.current = draft;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerDocumentJsHandler({
      set: async list => {
        const d = draftRef.current;
        if (!d) throw new Error(tChrome('refusal.file.noActiveDocument'));
        await drafts.load(d, call);
        if (!drafts.editable(d) || d.busy) throw new Error(tChrome('panel.docjs.sourceChanged'));
        const scripts = validateScripts(list);
        drafts.change(d, d.buffer, () => scripts);
        await drafts.save(d, performOperation);
        if (d.error) throw new Error(d.error);
      },
      list: async () => {
        const d = draftRef.current;
        if (!d) return [];
        const buffer = activeFile?.buffer;
        const reply = await call('list_document_js', { file: d.workingPath, for_edit: true });
        if (!drafts.current(d, buffer)) throw new Error(tChrome('panel.docjs.sourceChanged'));
        return parseDocumentJsRead(reply);
      },
    });
    return () => registerDocumentJsHandler(null);
  }, [activeFile?.buffer, drafts, performOperation, call]);

  if (!activeFile)
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.docjs.open')} />;

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="shrink-0 flex items-center gap-3">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.docjs.heading')} <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="docjs-add"
          onClick={addScript}
          disabled={!editable}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
        >
          {tChrome('panel.docjs.addScript')}
        </button>
        <button
          data-testid="docjs-save"
          onClick={() => void save()}
          disabled={!editable || !dirty || busy}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
        >
          {tChrome('panel.docjs.saveScripts')}
        </button>
      </div>

      <p className="shrink-0 text-xs text-neutral-500 -mt-1">
        {tChrome('panel.docjs.blurb')}
      </p>

      {draft?.loaded && scripts.length === 0 && !busy ? (
        <div data-testid="docjs-empty" className="text-sm text-neutral-500">
          {tChrome('panel.docjs.empty')}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3">
          {/* Script list */}
          <ul
            data-testid="docjs-list"
            className="w-44 shrink-0 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/50 p-1 flex flex-col gap-0.5"
            tabIndex={0}
            role="region"
            aria-label={tChrome('panel.docjs.listAria')}
          >
            {scripts.map((s, i) => (
              <li key={i}>
                <button
                  data-testid={`docjs-item-${i}`}
                  onClick={() => { if (draft) drafts.select(draft, i); }}
                  className={`w-full text-start px-2 py-1 text-xs rounded truncate ${
                    i === selected
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800'
                  }`}
                  title={s.name}
                >
                  {s.name || tChrome('panel.docjs.unnamed')}
                </button>
              </li>
            ))}
          </ul>

          {/* Editor for the selected script */}
          {sel && (
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400 shrink-0">{tChrome('panel.docjs.name')}</span>
                <input
                  data-testid="docjs-name"
                  type="text"
                  value={sel.name}
                  disabled={!editable}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                  className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
                />
                <button
                  data-testid="docjs-delete"
                  onClick={removeSelected}
                  disabled={!editable}
                  className="text-xs danger-action"
                >
                  {tChrome('panel.docjs.delete')}
                </button>
              </div>
              <textarea
                data-testid="docjs-editor"
                value={sel.js}
                spellCheck={false}
                disabled={!editable}
                onChange={(e) => updateSelected({ js: e.target.value })}
                className="flex-1 min-h-0 w-full px-2.5 py-2 bg-neutral-950 border border-neutral-700 rounded text-xs font-mono resize-none focus:outline-none focus:border-blue-500"
                placeholder={tChrome('panel.docjs.placeholder')}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div data-testid="docjs-error" className="shrink-0 text-xs text-red-400" aria-live="polite">
          {error}
          {draft && <button data-testid="docjs-reload" disabled={busy} onClick={() => void drafts.reload(draft, runCommitGate)}>
            {tChrome(draft.dirty ? 'panel.docjs.discardReload' : 'app.commit.retry')}
          </button>}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
