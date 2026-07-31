import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { getCanvasServices } from '../commands/context';
import { NoFileOpen } from '../components/NoFileOpen';
import { ANNOTATION_PALETTE } from '../components/canvas/PageCell';

// U3 (Phase 11) — THE comments surface. One.
//
// There used to be two, both reachable and both called "Comments": this panel
// (engine-backed, complete, read-only, delete-all) and a separate sidebar the
// status bar opened (in-memory, editable, but silently filtered to annotations
// carrying a note). They disagreed about the count by construction, and the
// dock titled both of them "Comments" — so the same word opened two different
// lists with two different answers.
//
// This is the merge. It keeps BOTH truths and is honest about the difference:
//   - the rows you can act on are the workspace's own annotations — every one
//     of them now, not just the ones with a note (a highlight without a note is
//     still a comment) — with jump, edit, recolour and delete;
//   - the FILE's total comes from the engine, so a document carrying markup
//     this app doesn't model (multi-stroke ink, polygons) reports honestly
//     instead of quietly under-counting;
//   - Delete All is the engine op, so it removes everything and is undoable.

// The PDF's own vocabulary, not the app's internal kind. A row that says
// "textmarkup" tells the user nothing — "Highlight" is the word the format,
// the engine's by-type summary, and every other PDF tool use.
const KIND_LABEL: Record<string, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  freetext: 'FreeText',
  ink: 'Ink',
  stamp: 'Stamp',
  note: 'Text',
  link: 'Link',
  measure: 'Measurement',
  shape: 'Shape',
  callout: 'Callout',
};

function labelFor(kind: string, markupType?: string): string {
  if (kind === 'textmarkup') return KIND_LABEL[markupType ?? 'highlight'] ?? 'Highlight';
  return KIND_LABEL[kind] ?? kind;
}

interface EngineAnnot {
  page: number;
  subtype: string;
  rect: number[] | null;
  contents: string;
  author: string;
}
interface Overview {
  annotations: EngineAnnot[];
  count: number;
  by_type: Record<string, number>;
}

export function CommentsPanel(): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  // The editable rows: the workspace's own annotations for the document on
  // show. Unfiltered — the old sidebar's `if (!a.note) continue` is exactly
  // what made two "Comments" report different numbers.
  const rows = useMemo(() => {
    const docs = state.workspace.documents.filter((d) => d.path === activeFile?.path);
    const out: {
      docId: string;
      pageId: string;
      pageNumber: number;
      annotationId: string;
      label: string;
      color: string;
      note: string;
    }[] = [];
    for (const doc of docs) {
      doc.pages.forEach((page, i) => {
        for (const a of page.annotations ?? []) {
          out.push({
            docId: doc.id,
            pageId: page.id,
            pageNumber: i + 1,
            annotationId: a.id,
            label: labelFor(a.kind, a.markupType),
            color: a.color,
            note: a.note ?? '',
          });
        }
      });
    }
    return out;
  }, [state.workspace.documents, activeFile?.path]);

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_annotations', { file: workingPath });
      setOverview(res as unknown as Overview);
    } catch {
      setOverview(null);
    }
  }, [workingPath, call]);

  useEffect(() => {
    setConfirming(false);
    if (!buffer || !workingPath) {
      setOverview(null);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const deleteAll = useCallback(async () => {
    if (!activeFile) return;
    setConfirming(false);
    setBusy(true);
    setStatus('Deleting comments…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const r = await call('delete_all_annotations', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
      });
      const buf = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
      await refresh();
      const n = (r as unknown as { removed: number }).removed;
      setStatus(`Removed ${n} comment${n === 1 ? '' : 's'} (undo with Ctrl+Z)`);
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, dispatch, refresh]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to review its comments" />;

  const fileCount = overview?.count ?? 0;
  const types = Object.entries(overview?.by_type ?? {});
  // Markup that lives in the FILE but not in the workspace tier — this app
  // doesn't model every annotation type, and pretending otherwise would be the
  // silent under-count this merge exists to kill.
  const notShown = Math.max(0, fileCount - rows.length);
  const total = Math.max(fileCount, rows.length);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      {total === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="comments-empty">
          This document has no comments.
        </p>
      ) : (
        <>
          <div className="text-sm text-neutral-300" data-testid="comments-summary">
            {total} comment{total === 1 ? '' : 's'}
            {types.length > 0 && (
              <span className="text-neutral-500"> — {types.map(([t, n]) => `${n} ${t}`).join(', ')}</span>
            )}
          </div>

          <div className="flex flex-col gap-1 max-h-[26rem] overflow-y-auto" data-testid="comments-list">
            {rows.map((e) => (
              <div
                key={e.annotationId}
                data-testid="comment-item"
                className="px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded border-l-2"
                style={{ borderLeftColor: e.color }}
              >
                <button
                  type="button"
                  data-testid={`comment-jump-${e.annotationId}`}
                  className="w-full text-left"
                  title="Go to this comment"
                  onClick={() => getCanvasServices()?.openPageForReading(e.pageId)}
                >
                  <div className="text-xs text-neutral-400">
                    {e.label} · Page {e.pageNumber}
                  </div>
                  {e.note && !(editing === e.annotationId) && (
                    <div className="text-sm text-neutral-200 truncate" title={e.note}>
                      {e.note}
                    </div>
                  )}
                </button>

                {editing === e.annotationId ? (
                  <textarea
                    autoFocus
                    data-testid="comment-note-input"
                    className="mt-1 w-full text-sm bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
                    defaultValue={e.note}
                    onBlur={(ev) => {
                      dispatch({
                        type: 'UPDATE_ANNOTATION',
                        docId: e.docId,
                        pageId: e.pageId,
                        annotationId: e.annotationId,
                        note: ev.target.value,
                      });
                      setEditing(null);
                    }}
                  />
                ) : null}

                <div className="flex items-center gap-1 mt-1">
                  <button
                    type="button"
                    data-testid={`comment-edit-${e.annotationId}`}
                    className="text-xs px-1.5 py-0.5 rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
                    onClick={() => setEditing(editing === e.annotationId ? null : e.annotationId)}
                  >
                    {e.note ? 'Edit note' : 'Add note'}
                  </button>
                  {ANNOTATION_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Recolour to ${c}`}
                      title="Recolour"
                      className="w-3.5 h-3.5 rounded-sm border border-black/30"
                      style={{ background: c }}
                      onClick={() =>
                        dispatch({
                          type: 'RECOLOR_ANNOTATION',
                          docId: e.docId,
                          pageId: e.pageId,
                          annotationId: e.annotationId,
                          color: c,
                        })
                      }
                    />
                  ))}
                  <button
                    type="button"
                    data-testid={`comment-delete-${e.annotationId}`}
                    className="ml-auto text-xs px-1.5 py-0.5 rounded text-neutral-400 hover:bg-red-600 hover:text-white"
                    onClick={() =>
                      dispatch({
                        type: 'REMOVE_ANNOTATION',
                        docId: e.docId,
                        pageId: e.pageId,
                        annotationId: e.annotationId,
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}

            {notShown > 0 && (
              <p className="text-xs text-neutral-500 px-1 py-2" data-testid="comments-not-editable">
                {notShown} more comment{notShown === 1 ? '' : 's'} in the file that this list can’t
                edit — Delete All still removes {notShown === 1 ? 'it' : 'them'}.
              </p>
            )}
          </div>

          {confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-300">Delete all {total} comments?</span>
              <button
                data-testid="comments-delete-confirm"
                onClick={() => void deleteAll()}
                disabled={busy}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded text-sm font-medium"
              >
                Delete all
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              data-testid="comments-delete-all"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="self-start px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm"
            >
              Delete all comments
            </button>
          )}
        </>
      )}
      {status && <div className="text-xs text-neutral-400">{status}</div>}
    </div>
  );
}
