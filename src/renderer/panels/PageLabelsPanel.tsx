import React, { useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { usePageLabelDrafts } from '../state/AppStateProvider';
import { previewLabel, type LabelRange } from '../lib/page-label-drafts';
import { runCommitGate } from '../lib/commit-gate';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

const STYLES: { value: string; label: string }[] = [
  { value: 'D', label: '1, 2, 3' },
  { value: 'r', label: 'i, ii, iii' },
  { value: 'R', label: 'I, II, III' },
  { value: 'a', label: 'a, b, c' },
  { value: 'A', label: 'A, B, C' },
  { value: 'none', label: '' }, // label resolved at render (localized)
];

export function PageLabelsPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const drafts = usePageLabelDrafts(), draft = drafts.get(activeFile);
  const ranges = draft?.ranges ?? [];
  const editable = !!draft && drafts.editable(draft), conflict = !!draft && drafts.conflict(draft);
  const busy = !!draft?.busy;
  const status = conflict ? tChrome('panel.pageLabels.sourceChanged') : draft?.error || draft?.status || '';
  const buffer = draft?.buffer ?? null;
  useEffect(() => { if (draft) void drafts.load(draft, call); });
  useEffect(() => () => { if (draft) drafts.cancelLoad(draft); }, [draft, drafts]);
  const addRange = useCallback(() => {
    if (draft) drafts.change(draft, buffer, prev => {
      const occupied = new Set(prev.map(r => r.start));
      const start = Array.from({ length: draft.pages }, (_, i) => i + 1).find(i => !occupied.has(i));
      return start ? [...prev, { start, style: 'D', prefix: '', startAt: 1 }] : prev;
    });
  }, [draft, drafts, buffer]);
  const updateRange = useCallback((i: number, patch: Partial<LabelRange>) => {
    if (draft) drafts.change(draft, buffer, prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));
  }, [draft, drafts, buffer]);
  const removeRange = useCallback((i: number) => {
    if (draft) drafts.change(draft, buffer, prev => prev.filter((_, j) => i !== j));
  }, [draft, drafts, buffer]);
  const handleApply = useCallback(async () => {
    if (draft) await drafts.apply(draft, performOperation, call, runCommitGate);
  }, [draft, drafts, performOperation, call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.pageLabels.open')} />;

  const total = draft?.loaded ? draft.pages : activeFile.pageCount;
  const previewPages = Array.from({ length: Math.min(total, 8) }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', total)})
      </div>
      <p className="text-xs text-neutral-500">
        {tChrome('panel.pageLabels.blurb')}
      </p>

      {draft && (conflict || draft.error) && <div role="alert" data-testid="pagelabel-notice">
        <p>{status}</p>
        <button data-testid="pagelabel-reload" disabled={busy} onClick={() => void drafts.reload(draft, runCommitGate)}>
          {tChrome(draft.dirty ? 'panel.pageLabels.discardReload' : 'app.commit.retry')}
        </button>
      </div>}
      <fieldset disabled={!editable} className="flex flex-col gap-2">
        {ranges.map((r, i) => (
          <div key={i} className="flex items-end gap-2 flex-wrap" data-testid="pagelabel-range">
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">{tChrome('panel.pageLabels.fromPage')}</label>
              <input
                data-testid={`pagelabel-start-${i}`}
                type="number"
                min={1}
                max={total}
                value={r.start}
                onChange={(e) => updateRange(i, { start: Number(e.target.value) })}
                className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">{tChrome('panel.pageLabels.style')}</label>
              <select
                data-testid={`pagelabel-style-${i}`}
                value={r.style}
                onChange={(e) => updateRange(i, { style: e.target.value })}
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              >
                {STYLES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.value === 'none' ? tChrome('panel.pageLabels.styleNone') : s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">{tChrome('panel.pageLabels.prefix')}</label>
              <input
                type="text"
                value={r.prefix}
                onChange={(e) => updateRange(i, { prefix: e.target.value })}
                className="w-24 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">{tChrome('panel.pageLabels.startAt')}</label>
              <input
                type="number"
                min={1}
                value={r.startAt}
                onChange={(e) => updateRange(i, { startAt: Number(e.target.value) })}
                className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <button
              data-testid={`pagelabel-remove-${i}`}
              onClick={() => removeRange(i)}
              className="text-xs danger-action is-quiet"
            >
              {tChrome('panel.pageLabels.remove')}
            </button>
          </div>
        ))}
        <button
          data-testid="pagelabel-add"
          disabled={!editable || ranges.length >= total}
          onClick={addRange}
          className="self-start px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
        >
          {tChrome('panel.pageLabels.addRange')}
        </button>
      </fieldset>

      <div className="text-xs text-neutral-500">
        {tChrome('panel.pageLabels.preview')}{' '}
        <span className="text-neutral-300" data-testid="pagelabel-preview">
          {previewPages.map((p) => previewLabel(ranges, p)).join(', ')}
          {total > previewPages.length ? ', …' : ''}
        </span>
      </div>

      <button
        data-testid="pagelabel-apply"
        onClick={handleApply}
        disabled={!editable || busy || !draft?.dirty}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.pageLabels.applying') : tChrome('panel.pageLabels.apply')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
