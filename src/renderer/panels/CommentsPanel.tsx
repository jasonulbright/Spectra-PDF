import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { dialog } from '../lib/tauri-bridge';
import { getCanvasServices, getCommandContext } from '../commands/context';
import { NoFileOpen } from '../components/NoFileOpen';
import { ANNOTATION_PALETTE } from '../components/canvas/PageCell';
import { CommentSummaryDialog } from '../components/CommentSummaryDialog';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import type { PanelKey } from '../i18n-panels';
import {
  COMMENT_SORTS,
  DEFAULT_SUMMARY_OPTIONS,
  filterIsActive,
  formatCommentDate,
  engineFilter,
  matchWorkspaceRow,
  orderedComments,
  summaryExclusions,
  typeLabel,
} from '../lib/comment-summary';
import type {
  CommentFilter,
  CommentModel,
  MatchableRow,
  SummaryOptions,
  SummaryResult,
} from '../lib/comment-summary';

// THE comments surface. One.
//
// There used to be two, both reachable and both called "Comments": this panel
// (engine-backed, complete, read-only, delete-all) and a separate sidebar the
// status bar opened (in-memory, editable, but silently filtered to annotations
// carrying a note). They disagreed about the count by construction, and the
// dock titled both of them "Comments" — so the same word opened two different
// lists with two different answers.
//
// This is the merge, and the list now shows the FILE's own review model:
//   - every comment the file carries, with its author, date, subject, state
//     and reply thread, ORDERED AND NARROWED BY THE ENGINE. The order is not
//     re-derived here: the same `list_comments` answer drives this list and
//     the produced summary, so the two can never disagree about which
//     comments, in what order;
//   - each row picks up jump/edit/recolour/delete when a workspace annotation
//     matches it by import fingerprint; one that does not is listed read-only
//     rather than dropped, which is what the old under-count did;
//   - a comment drawn on the canvas and not yet committed is not in the file
//     at all, so no engine read can see it: those rows are listed FIRST, in
//     document order, and the filter never removes them — they are the user's
//     live edits;
//   - Delete All is the engine op, so it removes everything and is undoable.

// The PDF's own vocabulary, not the app's internal kind. A row that says
// "textmarkup" tells the user nothing — "Highlight" is the word the format,
// the engine's by-type summary, and every other PDF tool use.
const KIND_KEY: Record<string, PanelKey> = {
  highlight: 'panel.comments.kind.highlight',
  underline: 'panel.comments.kind.underline',
  strikeout: 'panel.comments.kind.strikeout',
  squiggly: 'panel.comments.kind.squiggly',
  freetext: 'panel.comments.kind.freetext',
  ink: 'panel.comments.kind.ink',
  stamp: 'panel.comments.kind.stamp',
  note: 'panel.comments.kind.note',
  link: 'panel.comments.kind.link',
  measure: 'panel.comments.kind.measure',
  shape: 'panel.comments.kind.shape',
  callout: 'panel.comments.kind.callout',
  count: 'panel.comments.kind.count',
  countlegend: 'panel.comments.kind.countlegend',
};

function labelFor(kind: string, markupType?: string): string {
  const k = kind === 'textmarkup' ? (markupType ?? 'highlight') : kind;
  const key = KIND_KEY[k];
  return key ? tChrome(key) : k;
}

interface WorkspaceRow {
  docId: string;
  pageId: string;
  pageNumber: number;
  annotationId: string;
  label: string;
  color: string;
  note: string;
  /** Present only for a row imported from the file — the raw PDF-space rect
   * the engine also reports, which is what pairs the two. */
  match: MatchableRow | null;
}

export function CommentsPanel(): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const [model, setModel] = useState<CommentModel | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<SummaryOptions>(DEFAULT_SUMMARY_OPTIONS);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [report, setReport] = useState<SummaryResult | null>(null);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const { sort, filter } = options;

  // The workspace's own annotations for the document on show. Unfiltered —
  // the old sidebar's `if (!a.note) continue` is exactly what made two
  // "Comments" report different numbers.
  const rows = useMemo<WorkspaceRow[]>(() => {
    const docs = state.workspace.documents.filter((d) => d.path === activeFile?.path);
    const out: WorkspaceRow[] = [];
    for (const doc of docs) {
      doc.pages.forEach((page, i) => {
        for (const a of page.annotations ?? []) {
          const original = a.importedOriginal;
          out.push({
            docId: doc.id,
            pageId: page.id,
            pageNumber: i + 1,
            annotationId: a.id,
            label: labelFor(a.kind, a.markupType),
            color: a.color,
            note: a.note ?? '',
            match: original
              ? {
                  annotationId: a.id,
                  subtype: original.subtype,
                  rect: original.rect,
                }
              : null,
          });
        }
      });
    }
    return out;
  }, [state.workspace.documents, activeFile?.path]);

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_comments', {
        file: workingPath,
        sort,
        filter: engineFilter(filter),
      });
      setModel(res as unknown as CommentModel);
    } catch {
      setModel(null);
    }
  }, [workingPath, call, sort, filter]);

  useEffect(() => {
    setConfirming(false);
    if (!buffer || !workingPath) {
      setModel(null);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  // The file's comments in the engine's order, each paired with the workspace
  // row that can act on it. `used` makes the pairing one-to-one: two identical
  // annotations on one page are two rows, never one row claimed twice.
  const listed = useMemo(() => {
    if (!model) return [];
    const candidates = rows.filter((r) => r.match !== null).map((r) => r.match as MatchableRow);
    const used = new Set<string>();
    const byId = new Map(rows.map((r) => [r.annotationId, r]));
    return orderedComments(model).map(({ comment, depth }) => {
      const hit = matchWorkspaceRow(comment, candidates, used);
      return { comment, depth, row: hit ? (byId.get(hit.annotationId) ?? null) : null };
    });
  }, [model, rows]);

  // A comment drawn on the canvas lives in the page tier until it is
  // committed, so no engine read can see it. These are the user's live edits:
  // listed first, in document order, and never narrowed away.
  const pending = useMemo(() => rows.filter((r) => r.match === null), [rows]);

  const notActionable = listed.filter((entry) => entry.row === null).length;

  const setFilter = useCallback(
    (next: CommentFilter) => setOptions((o) => ({ ...o, filter: next })),
    [],
  );

  // XFDF interchange (rung 4). Export is a gate-flushed read (the engine
  // call's commit gate bakes pending comments first, so the file it reads
  // matches what the user sees); import is the standard undoable mutation.
  const exportXfdf = useCallback(async () => {
    if (!activeFile) return;
    const output = await dialog.saveFile({
      defaultPath: activeFile.name.replace(/\.pdf$/i, '') + '.xfdf',
    });
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('panel.comments.exporting'));
    try {
      const r = await call('export_xfdf', { file: activeFile.workingPath, output });
      // `count` is what the file holds and `found` is what the document held;
      // a comment XFDF cannot carry, or one whose keys will not read, is in
      // the engine's `skipped` list and in the gap between the two.
      const rr = r as unknown as { count: number; found: number };
      setStatus(
        rr.count === rr.found
          ? tChromeCount('panel.comments.exported', rr.count)
          : tChrome('panel.comments.exportedIncomplete', {
              exported: rr.count,
              found: rr.found,
            }),
      );
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call]);

  const importXfdf = useCallback(async () => {
    if (!activeFile) return;
    const xfdf = await dialog.pickAnyFile();
    if (!xfdf) return;
    setBusy(true);
    setStatus(tChrome('panel.comments.importing'));
    try {
      const r = await performOperation(activeFile.path, 'import_xfdf', { xfdf });
      if (r === EDIT_DECLINED) {
        setStatus('');
        return;
      }
      await refresh();
      const rr = r as unknown as { added: number; skipped: { reason: string }[] };
      const skipped = rr.skipped.length
        ? tChrome('panel.comments.importedSkipped', { count: rr.skipped.length })
        : '';
      setStatus(
        tChrome(rr.added === 1 ? 'panel.comments.imported_one' : 'panel.comments.imported_other', {
          count: rr.added,
          skipped,
        }),
      );
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, performOperation, refresh]);

  const deleteAll = useCallback(async () => {
    if (!activeFile) return;
    setConfirming(false);
    setBusy(true);
    setStatus(tChrome('panel.comments.deleting'));
    try {
      const r = await performOperation(activeFile.path, 'delete_all_annotations', {});
      if (r === EDIT_DECLINED) {
        setStatus('');
        return;
      }
      await refresh();
      const n = (r as unknown as { removed: number }).removed;
      setStatus(tChromeCount('panel.comments.removed', n));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, performOperation, refresh]);

  // The produced file opens like any other document — through App's one open
  // funnel, never a second implementation of "open some files".
  //
  // The report outlives the dialog and the document switch on purpose. The
  // dialog is gone by the time the summary exists and the active document is
  // then the summary itself, so this panel is the only surface still standing
  // where what the run left out can be read.
  const summaryDone = useCallback(async (result: SummaryResult) => {
    setSummaryOpen(false);
    setReport(result);
    setStatus(tChrome('panel.comments.summaryOpening'));
    try {
      await getCommandContext()?.app?.openPath(result.output);
    } finally {
      setStatus('');
    }
  }, []);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.comments.open')} />;

  const fileCount = model?.found ?? 0;
  const types = Object.entries(model?.by_type ?? {});
  const total = Math.max(fileCount, listed.length + pending.length);
  const excluded = report ? summaryExclusions(report) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      {total === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="comments-empty">
          {tChrome('panel.comments.empty')}
        </p>
      ) : (
        <>
          <div className="text-sm text-neutral-300" data-testid="comments-summary">
            {tChromeCount('panel.comments.summary', total)}
            {types.length > 0 && (
              <span className="text-neutral-500"> — {types.map(([t, n]) => `${n} ${t}`).join(', ')}</span>
            )}
          </div>

          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-xs text-neutral-500 mb-1" htmlFor="comments-sort">
                {tChrome('panel.comments.sort')}
              </label>
              <select
                id="comments-sort"
                data-testid="comments-sort"
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={sort}
                onChange={(e) =>
                  setOptions((o) => ({ ...o, sort: e.target.value as SummaryOptions['sort'] }))
                }
              >
                {COMMENT_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {tChrome(SORT_KEY[s])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1" htmlFor="comments-filter-author">
                {tChrome('panel.comments.filterAuthor')}
              </label>
              <select
                id="comments-filter-author"
                data-testid="comments-filter-author"
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs max-w-[10rem]"
                value={filter.authors?.[0] ?? ''}
                onChange={(e) =>
                  setFilter({
                    ...filter,
                    authors: e.target.value ? [e.target.value] : undefined,
                  })
                }
              >
                <option value="">{tChrome('panel.comments.filterAny')}</option>
                {(model?.authors ?? []).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1" htmlFor="comments-filter-type">
                {tChrome('panel.comments.filterType')}
              </label>
              <select
                id="comments-filter-type"
                data-testid="comments-filter-type"
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs max-w-[10rem]"
                value={filter.subtypes?.[0] ?? ''}
                onChange={(e) =>
                  setFilter({
                    ...filter,
                    subtypes: e.target.value ? [e.target.value] : undefined,
                  })
                }
              >
                <option value="">{tChrome('panel.comments.filterAny')}</option>
                {(model?.subtypes ?? []).map((s) => (
                  <option key={s} value={s}>
                    {typeLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1" htmlFor="comments-filter-state">
                {tChrome('panel.comments.filterState')}
              </label>
              <select
                id="comments-filter-state"
                data-testid="comments-filter-state"
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs max-w-[9rem]"
                value={filter.states?.[0] ?? ''}
                onChange={(e) =>
                  setFilter({
                    ...filter,
                    states: e.target.value ? [e.target.value] : undefined,
                  })
                }
              >
                <option value="">{tChrome('panel.comments.filterAny')}</option>
                {(model?.states ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1" htmlFor="comments-filter-pages">
                {tChrome('panel.comments.filterPages')}
              </label>
              <input
                id="comments-filter-pages"
                data-testid="comments-filter-pages"
                type="text"
                spellCheck={false}
                className="px-2 py-1 w-24 bg-neutral-800 border border-neutral-700 rounded text-xs"
                placeholder={tChrome('panel.comments.filterPagesPlaceholder')}
                value={filter.pages ?? ''}
                onChange={(e) => setFilter({ ...filter, pages: e.target.value || undefined })}
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-neutral-400 pb-1">
              <input
                type="checkbox"
                data-testid="comments-filter-body"
                checked={filter.has_body === true}
                onChange={(e) => setFilter({ ...filter, has_body: e.target.checked || undefined })}
              />
              {tChrome('panel.comments.filterWithText')}
            </label>
          </div>

          {model && filterIsActive(filter) && (
            <p className="text-xs text-amber-300" data-testid="comments-filtered">
              {tChrome('panel.comments.filteredAway', {
                count: tNumber(model.excluded.filtered),
              })}
            </p>
          )}

          <div className="flex flex-col gap-1 max-h-[26rem] overflow-y-auto" data-testid="comments-list" tabIndex={0} role="region" aria-label={tChrome('panel.comments.listAria')}>
            {pending.map((e) => (
              <CommentCard
                key={e.annotationId}
                row={e}
                header={tChrome('panel.comments.pageLine', { label: e.label, page: e.pageNumber })}
                pending
                depth={0}
                editing={editing}
                setEditing={setEditing}
                dispatch={dispatch}
              />
            ))}

            {listed.map(({ comment, depth, row }) => (
              <div
                key={comment.id}
                data-testid="comment-item"
                data-comment-id={comment.id}
                className="relative px-3 py-2 ps-4 bg-neutral-800/60 border border-neutral-800 rounded"
                style={{ marginInlineStart: `${depth * 12}px` }}
              >
                <span
                  aria-hidden
                  className="comment-accent color-chip"
                  style={{ background: row?.color ?? '#525252' }}
                />
                <button
                  type="button"
                  data-testid={row ? `comment-jump-${row.annotationId}` : undefined}
                  className="w-full text-start"
                  title={tChrome('panel.comments.jumpTitle')}
                  disabled={!row}
                  onClick={() => row && getCanvasServices()?.openPageForReading(row.pageId)}
                >
                  <div className="text-xs text-neutral-400">
                    {tChrome('panel.comments.rowLine', {
                      label: typeLabel(comment.subtype),
                      page: tNumber(comment.page),
                      author: comment.author || tChrome('panel.comments.doc.unknownAuthor'),
                      date: formatCommentDate(comment.modified ?? comment.created),
                    })}
                  </div>
                  {comment.subject && (
                    <div className="text-xs text-neutral-500">
                      {tChrome('panel.comments.rowSubject', { subject: comment.subject })}
                    </div>
                  )}
                  {comment.state && (
                    <div className="text-xs text-neutral-500">
                      {tChrome('panel.comments.rowState', { state: comment.state })}
                    </div>
                  )}
                  {comment.reply_type === 'group' && (
                    <div className="text-xs text-neutral-500">
                      {tChrome('panel.comments.rowGrouped')}
                    </div>
                  )}
                  {comment.reply_type === 'unknown' && (
                    <div className="text-xs text-neutral-500">
                      {tChrome('panel.comments.rowUnknownRelationship')}
                    </div>
                  )}
                  {comment.orphan && (
                    <div className="text-xs text-amber-300" data-testid="comment-orphan">
                      {tChrome('panel.comments.rowOrphan')}
                    </div>
                  )}
                  {comment.cycle && (
                    <div className="text-xs text-amber-300">
                      {tChrome('panel.comments.rowCycle')}
                    </div>
                  )}
                  {comment.contents && !(row && editing === row.annotationId) && (
                    <div className="text-sm text-neutral-200 truncate" title={comment.contents}>
                      {comment.contents}
                    </div>
                  )}
                </button>

                {row && editing === row.annotationId ? (
                  <textarea
                    autoFocus
                    data-testid="comment-note-input"
                    className="mt-1 w-full text-sm bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
                    defaultValue={row.note}
                    onBlur={(ev) => {
                      dispatch({
                        type: 'UPDATE_ANNOTATION',
                        docId: row.docId,
                        pageId: row.pageId,
                        annotationId: row.annotationId,
                        note: ev.target.value,
                      });
                      setEditing(null);
                    }}
                  />
                ) : null}

                {row ? (
                  <RowActions
                    row={row}
                    editing={editing}
                    setEditing={setEditing}
                    dispatch={dispatch}
                  />
                ) : (
                  <p className="text-xs text-neutral-600 mt-1" data-testid="comment-read-only">
                    {tChrome('panel.comments.rowReadOnly')}
                  </p>
                )}
              </div>
            ))}

            {notActionable > 0 && (
              <p className="text-xs text-neutral-500 px-1 py-2" data-testid="comments-not-editable">
                {tChromeCount('panel.comments.notShown', notActionable)}
              </p>
            )}
          </div>

          {confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-300">{tChrome('panel.comments.confirm', { count: total })}</span>
              <button
                data-testid="comments-delete-confirm"
                onClick={() => void deleteAll()}
                disabled={busy}
                className="text-sm danger-action"
              >
                {tChrome('panel.comments.deleteAllBtn')}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
              >
                {tChrome('panel.comments.cancel')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                data-testid="comments-delete-all"
                onClick={() => setConfirming(true)}
                disabled={busy}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
              >
                {tChrome('panel.comments.deleteAll')}
              </button>
              <button
                data-testid="comments-summary-open"
                onClick={() => {
                  setReport(null);
                  setSummaryOpen(true);
                }}
                disabled={busy || !model || model.count === 0}
                title={tChrome('panel.comments.summaryHint')}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
              >
                {tChrome('panel.comments.summaryBtn')}
              </button>
              <button
                data-testid="comments-export-xfdf"
                onClick={() => void exportXfdf()}
                disabled={busy}
                title={tChrome('panel.comments.exportTitle')}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
              >
                {tChrome('panel.comments.exportBtn')}
              </button>
              <button
                data-testid="comments-import-xfdf"
                onClick={() => void importXfdf()}
                disabled={busy}
                title={tChrome('panel.comments.importTitle')}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
              >
                {tChrome('panel.comments.importBtn')}
              </button>
            </div>
          )}
        </>
      )}
      {status && <div className="text-xs text-neutral-400">{status}</div>}
      {report && (
        <div
          className="flex flex-col gap-0.5 text-sm break-all"
          data-testid="comment-summary-done"
          aria-live="polite"
        >
          <p>
            {tChrome('panel.comments.summaryDone', {
              sheets: tNumber(report.sheets),
              written: tNumber(report.written),
              output: report.output,
            })}
          </p>
          {excluded && (
            <div className="flex flex-col gap-0.5" data-testid="comment-summary-excluded">
              {excluded.accounting && (
                <p className="text-xs text-neutral-400">
                  {tChrome('panel.comments.summaryReconcile', {
                    found: tNumber(report.found),
                    written: tNumber(report.written),
                    filtered: tNumber(report.excluded.filtered),
                    unmodelled: tNumber(report.excluded.unmodelled),
                  })}
                </p>
              )}
              {excluded.noPosition > 0 && (
                <p className="text-xs text-amber-300">
                  {tChrome('panel.comments.summaryNoPosition', {
                    count: tNumber(excluded.noPosition),
                  })}
                </p>
              )}
              {excluded.bodyRefused > 0 && (
                <p className="text-xs text-amber-300">
                  {tChrome('panel.comments.summaryBodyRefused', {
                    count: tNumber(excluded.bodyRefused),
                  })}
                </p>
              )}
              {excluded.noBoxPages.length > 0 && (
                <p className="text-xs text-amber-300">
                  {tChrome('panel.comments.summaryNoBox', {
                    pages: excluded.noBoxPages.map((p) => tNumber(p)).join(', '),
                  })}
                </p>
              )}
              {excluded.unreadablePages.length > 0 && (
                <p className="text-xs text-amber-300">
                  {tChrome('panel.comments.summaryUnreadable', {
                    pages: excluded.unreadablePages.map((p) => tNumber(p)).join(', '),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {summaryOpen && model && (
        <CommentSummaryDialog
          file={{ workingPath: activeFile.workingPath, name: activeFile.name }}
          model={model}
          options={options}
          onOptionsChange={setOptions}
          onDone={(result) => void summaryDone(result)}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </div>
  );
}

const SORT_KEY: Record<string, PanelKey> = {
  page: 'panel.comments.sort.page',
  author: 'panel.comments.sort.author',
  date: 'panel.comments.sort.date',
  type: 'panel.comments.sort.type',
};

function RowActions({
  row,
  editing,
  setEditing,
  dispatch,
}: {
  row: WorkspaceRow;
  editing: string | null;
  setEditing: (id: string | null) => void;
  dispatch: ReturnType<typeof useAppDispatch>;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1 mt-1">
      <button
        type="button"
        data-testid={`comment-edit-${row.annotationId}`}
        className="text-xs px-1.5 py-0.5 rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
        onClick={() => setEditing(editing === row.annotationId ? null : row.annotationId)}
      >
        {row.note ? tChrome('panel.comments.editNote') : tChrome('panel.comments.addNote')}
      </button>
      {ANNOTATION_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={tChrome('panel.comments.recolourTo', { color: c })}
          title={tChrome('panel.comments.recolour')}
          className={'color-swatch w-3.5 h-3.5' + (row.color === c ? ' is-selected' : '')}
          style={{ background: c }}
          onClick={() =>
            dispatch({
              type: 'RECOLOR_ANNOTATION',
              docId: row.docId,
              pageId: row.pageId,
              annotationId: row.annotationId,
              color: c,
            })
          }
        />
      ))}
      <button
        type="button"
        data-testid={`comment-delete-${row.annotationId}`}
        className="ms-auto text-xs danger-action is-quiet"
        onClick={() =>
          dispatch({
            type: 'REMOVE_ANNOTATION',
            docId: row.docId,
            pageId: row.pageId,
            annotationId: row.annotationId,
          })
        }
      >
        {tChrome('panel.comments.delete')}
      </button>
    </div>
  );
}

function CommentCard({
  row,
  header,
  pending,
  depth,
  editing,
  setEditing,
  dispatch,
}: {
  row: WorkspaceRow;
  header: string;
  pending: boolean;
  depth: number;
  editing: string | null;
  setEditing: (id: string | null) => void;
  dispatch: ReturnType<typeof useAppDispatch>;
}): React.ReactElement {
  return (
    <div
      data-testid="comment-item"
      data-comment-pending={pending ? 'true' : undefined}
      className="relative px-3 py-2 ps-4 bg-neutral-800/60 border border-neutral-800 rounded"
      style={{ marginInlineStart: `${depth * 12}px` }}
    >
      <span
        aria-hidden
        className="comment-accent color-chip"
        style={{ background: row.color }}
      />
      <button
        type="button"
        data-testid={`comment-jump-${row.annotationId}`}
        className="w-full text-start"
        title={tChrome('panel.comments.jumpTitle')}
        onClick={() => getCanvasServices()?.openPageForReading(row.pageId)}
      >
        <div className="text-xs text-neutral-400">{header}</div>
        {pending && (
          <div className="text-xs text-neutral-600">{tChrome('panel.comments.rowPending')}</div>
        )}
        {row.note && !(editing === row.annotationId) && (
          <div className="text-sm text-neutral-200 truncate" title={row.note}>
            {row.note}
          </div>
        )}
      </button>

      {editing === row.annotationId ? (
        <textarea
          autoFocus
          data-testid="comment-note-input"
          className="mt-1 w-full text-sm bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
          defaultValue={row.note}
          onBlur={(ev) => {
            dispatch({
              type: 'UPDATE_ANNOTATION',
              docId: row.docId,
              pageId: row.pageId,
              annotationId: row.annotationId,
              note: ev.target.value,
            });
            setEditing(null);
          }}
        />
      ) : null}

      <RowActions row={row} editing={editing} setEditing={setEditing} dispatch={dispatch} />
    </div>
  );
}
