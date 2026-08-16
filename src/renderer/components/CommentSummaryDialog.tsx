import React, { useCallback, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { app, dialog } from '../lib/tauri-bridge';
import { TEST_HARNESS_ENABLED, registerCommentSummary } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tNumber } from '../i18n';
import {
  COMMENT_SORTS,
  SUMMARY_MODES,
  SUMMARY_PAPERS,
  SUMMARY_PLACEMENTS,
  summaryFileName,
  summaryParams,
  typeLabel,
} from '../lib/comment-summary';
import type {
  CommentModel,
  SummaryOptions,
  SummaryResult,
} from '../lib/comment-summary';

// The comment summary dialog — the document's own controls.
//
// `placement` and `connectors` are ORTHOGONAL, not one five-valued choice:
// four documents fall out of two fields, and folding "no connectors" into the
// placement list would make it a fifth layout that has to be kept in step with
// the other four.
//
// The sort and the filter are the SAME parameters the panel's list is already
// showing, passed straight through — the dialog never re-derives an order.
//
// A finished run hands its whole result to `onDone` and this dialog is
// unmounted in the same turn, so it can render nothing about the outcome: an
// exclusion report written here is a report no reader ever sees. What the
// summary left out is reported by the surface the reader lands on.

const GUTTERS = [144, 180, 216, 252, 288];

export function CommentSummaryDialog({
  file,
  model,
  options,
  onOptionsChange,
  onDone,
  onClose,
}: {
  file: { workingPath: string; name: string };
  model: CommentModel;
  options: SummaryOptions;
  onOptionsChange: (next: SummaryOptions) => void;
  onDone: (result: SummaryResult) => void;
  onClose: () => void;
}): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call } = useEngine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reentrancy ref taken before the first await (the CreatePdf/convert rule).
  const runningRef = useRef(false);

  const set = <K extends keyof SummaryOptions>(key: K, value: SummaryOptions[K]): void =>
    onOptionsChange({ ...options, [key]: value });

  const runSummary = useCallback(
    async (out: string) => {
      if (runningRef.current) return null;
      runningRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const params = summaryParams(
          file.workingPath,
          out,
          options,
          model,
          file.name,
          await app.getEditFontPath(),
        );
        const r = (await call('summarize_comments', params)) as unknown as SummaryResult;
        onDone(r);
        return r;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        runningRef.current = false;
        setBusy(false);
      }
    },
    [call, file.name, file.workingPath, model, onDone, options],
  );

  const create = useCallback(async () => {
    if (runningRef.current) return;
    const out = await dialog.saveFile({
      defaultPath: summaryFileName(file.name, new Date()),
    });
    if (!out || runningRef.current) return;
    await runSummary(out);
  }, [file.name, runSummary]);

  // Harness bridge: the native save dialog is undrivable — e2e injects the
  // destination and runs the REAL summary path.
  const harnessRef = useRef({ runSummary });
  harnessRef.current = { runSummary };
  React.useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCommentSummary({ run: (out) => harnessRef.current.runSummary(out) });
    return () => registerCommentSummary(null);
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
        aria-label={tChrome('panel.comments.summaryAria')}
        data-testid="comment-summary-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('panel.comments.summaryTitle')}</h3>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-xs text-neutral-400 break-all">{file.name}</p>

          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="comment-summary-mode">
              {tChrome('panel.comments.mode')}
            </label>
            <select
              id="comment-summary-mode"
              data-testid="comment-summary-mode"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={options.mode}
              disabled={busy}
              onChange={(e) => set('mode', e.target.value as SummaryOptions['mode'])}
            >
              {SUMMARY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {tChrome(
                    mode === 'comments_only'
                      ? 'panel.comments.mode.commentsOnly'
                      : 'panel.comments.mode.documentAndComments',
                  )}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="comment-summary-placement"
              >
                {tChrome('panel.comments.placement')}
              </label>
              <select
                id="comment-summary-placement"
                data-testid="comment-summary-placement"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={options.placement}
                disabled={busy || options.mode === 'comments_only'}
                onChange={(e) =>
                  set('placement', e.target.value as SummaryOptions['placement'])
                }
              >
                {SUMMARY_PLACEMENTS.map((placement) => (
                  <option key={placement} value={placement}>
                    {tChrome(PLACEMENT_KEY[placement])}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="comment-summary-gutter"
              >
                {tChrome('panel.comments.gutter')}
              </label>
              <select
                id="comment-summary-gutter"
                data-testid="comment-summary-gutter"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={options.gutter}
                disabled={busy || options.mode === 'comments_only'}
                onChange={(e) => set('gutter', Number(e.target.value))}
              >
                {GUTTERS.map((points) => (
                  <option key={points} value={points}>
                    {tChrome('panel.comments.gutterOption', { points: tNumber(points) })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="comment-summary-connectors"
              checked={options.connectors}
              disabled={busy || options.mode === 'comments_only'}
              onChange={(e) => set('connectors', e.target.checked)}
            />
            {tChrome('panel.comments.connectors')}
          </label>

          <div className="flex gap-3">
            <div className="flex-1">
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="comment-summary-paper"
              >
                {tChrome('panel.comments.paper')}
              </label>
              <select
                id="comment-summary-paper"
                data-testid="comment-summary-paper"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={options.paper}
                disabled={busy}
                onChange={(e) => set('paper', e.target.value)}
              >
                {SUMMARY_PAPERS.map((paper) => (
                  <option key={paper} value={paper}>
                    {tChrome(PAPER_KEY[paper])}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="comment-summary-sort"
              >
                {tChrome('panel.comments.sort')}
              </label>
              <select
                id="comment-summary-sort"
                data-testid="comment-summary-sort"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={options.sort}
                disabled={busy}
                onChange={(e) => set('sort', e.target.value as SummaryOptions['sort'])}
              >
                {COMMENT_SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {tChrome(SORT_KEY[sort])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-xs text-neutral-500" data-testid="comment-summary-scope">
            {tChrome('panel.comments.summaryScope', {
              count: tNumber(model.count),
              types: model.subtypes.map((s) => typeLabel(s)).join(', '),
            })}
          </p>

          {error && (
            <p className="text-sm text-red-400" data-testid="comment-summary-error" aria-live="polite">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="comment-summary-create"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy}
              onClick={() => void create()}
            >
              {tChrome(
                busy ? 'panel.comments.summarizing' : 'panel.comments.summaryCreate',
              )}
            </button>
            <button
              type="button"
              data-testid="comment-summary-close"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
              onClick={onClose}
              disabled={busy}
            >
              {tChrome('panel.comments.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const PLACEMENT_KEY: Record<string, Parameters<typeof tChrome>[0]> = {
  auto: 'panel.comments.placement.auto',
  beside: 'panel.comments.placement.beside',
  beneath: 'panel.comments.placement.beneath',
  separate: 'panel.comments.placement.separate',
};

const PAPER_KEY: Record<string, Parameters<typeof tChrome>[0]> = {
  letter: 'panel.comments.paper.letter',
  legal: 'panel.comments.paper.legal',
  tabloid: 'panel.comments.paper.tabloid',
  a3: 'panel.comments.paper.a3',
  a4: 'panel.comments.paper.a4',
  a5: 'panel.comments.paper.a5',
};

const SORT_KEY: Record<string, Parameters<typeof tChrome>[0]> = {
  page: 'panel.comments.sort.page',
  author: 'panel.comments.sort.author',
  date: 'panel.comments.sort.date',
  type: 'panel.comments.sort.type',
};
