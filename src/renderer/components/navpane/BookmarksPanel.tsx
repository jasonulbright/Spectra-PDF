import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import { useAppDispatch } from '../../state/AppStateProvider';
import { file } from '../../lib/tauri-bridge';
import { getCanvasServices, pushEscapeInterceptor } from '../../commands/context';
import {
  flattenOutline,
  restRows,
  projectDrop,
  moveOutlineNode,
  isPathPrefix,
  outlinesEqual,
} from '../../lib/outline-reorder';
import type { OutlineNode, FlatNode } from '../../lib/outline-reorder';
import { ChromeIcon } from '../chrome-icons';
import { TEST_HARNESS_ENABLED, registerCanvasOutline } from '../../testHarness';
import type { NavPanelComponentProps } from './types';

// Bookmarks nav panel (Phase 4 M3.2) — the ONE bookmarks surface, merging the
// canvas OutlineSidebar (drag-reorder + click-to-jump, § 2n.2) with the
// OutlinePanel's editing (rename / retarget page / add child / delete). Reorder
// starts ONLY from the drag handle so the inline inputs stay editable. Every
// mutation (reorder, edit-on-blur, add, delete) routes through one queued
// persist (`set_outline` → snapshot → UPDATE_FILE), chained so two can't race —
// same in-place-undoable path both predecessors used. `outline-reorder.ts` is
// untouched.

const INDENT_PX = 16;
const DRAG_THRESHOLD_PX = 5;

// Immutable tree update by index path (from OutlinePanel).
function updateAt(
  nodes: OutlineNode[],
  path: number[],
  fn: (n: OutlineNode) => OutlineNode | null,
): OutlineNode[] {
  const [head, ...rest] = path;
  return nodes.flatMap((node, i) => {
    if (i !== head) return [node];
    if (rest.length === 0) {
      const next = fn(node);
      return next ? [next] : [];
    }
    return [{ ...node, children: updateAt(node.children, rest, fn) }];
  });
}

interface DragState {
  path: number[];
  startX: number;
  startY: number;
  started: boolean;
  overIndex: number;
  depth: number;
  filePath: string | undefined; // the file the drag started against
}

export function BookmarksPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  const { call } = useEngine();
  const dispatch = useAppDispatch();
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const session = useRef<DragState | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // The file the drag started against — a mid-drag doc-tab switch must not
  // apply a stale reorder (measured against the old tree) to a different file.
  const activeFilePathRef = useRef(activeFile?.path);
  activeFilePathRef.current = activeFile?.path;

  const fileKey = activeFile
    ? `${activeFile.path}#${activeFile.pageCount}#${activeFile.undoStack.length}`
    : null;

  // (Re)load when the file's bytes change (external edits, undo, other ops).
  // Our OWN saves advance loadedFor to the anticipated key (below) so they
  // don't trigger a reload that would clobber an in-progress inline edit.
  useEffect(() => {
    if (!activeFile) {
      setNodes([]);
      setLoadedFor(null);
      return;
    }
    if (fileKey === loadedFor) return;
    let cancelled = false;
    call('get_outline', { file: activeFile.workingPath })
      .then((res) => {
        if (cancelled) return;
        setNodes((res.outline as OutlineNode[]) ?? []);
        setLoadedFor(fileKey);
        setStatus(res.truncated ? 'Outline truncated (too many bookmarks)' : '');
      })
      .catch((e: unknown) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [activeFile, fileKey, loadedFor, call]);

  // One persist path, chained so a reorder and an edit-save can't interleave
  // (both stage the same working file). Advances loadedFor to the post-save key
  // so this save doesn't self-trigger the reload effect.
  const persist = useCallback(
    async (next: OutlineNode[]): Promise<void> => {
      if (!activeFile) return;
      const expectedKey = `${activeFile.path}#${activeFile.pageCount}#${activeFile.undoStack.length + 1}`;
      setStatus('Saving…');
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('set_outline', {
          file: activeFile.workingPath,
          outline: next,
          output: activeFile.workingPath,
        });
        const buffer = await file.readBuffer(activeFile.workingPath);
        dispatch({
          type: 'UPDATE_FILE',
          path: activeFile.path,
          pageCount: activeFile.pageCount,
          buffer,
          snapshotPath,
        });
        setLoadedFor(expectedKey);
        setStatus('');
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
        setLoadedFor(null); // reload from disk on failure so the view matches
      }
    },
    [activeFile, call, dispatch],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const queuePersist = useCallback((next: OutlineNode[]): Promise<void> => {
    const run = saveChain.current.then(() => persistRef.current(next));
    saveChain.current = run.catch(() => {});
    return run;
  }, []);

  // ── Editing (from OutlinePanel) ──────────────────────────────────────────
  // Local edits update `nodes`; commit on blur/Enter if the value changed, so
  // each finished field is one undoable save (Acrobat's immediate model).
  const editBaseline = useRef<OutlineNode[] | null>(null);
  const beginEdit = useCallback(() => {
    if (!editBaseline.current) editBaseline.current = nodesRef.current;
  }, []);
  const commitEdit = useCallback(() => {
    const base = editBaseline.current;
    editBaseline.current = null;
    if (base && !outlinesEqual(base, nodesRef.current)) void queuePersist(nodesRef.current);
  }, [queuePersist]);
  // Commit a pending inline edit on unmount too — closing the pane / switching
  // panels while a field is dirty-but-not-yet-blurred must not lose it (the
  // async persist still lands via dispatch after unmount). commitEdit clears
  // the baseline, so a blur-commit already fired makes this a no-op.
  const commitEditRef = useRef(commitEdit);
  commitEditRef.current = commitEdit;
  useEffect(() => () => commitEditRef.current(), []);

  const editNode = useCallback((path: number[], fn: (n: OutlineNode) => OutlineNode | null) => {
    beginEdit();
    setNodes((prev) => updateAt(prev, path, fn));
  }, [beginEdit]);

  const addRoot = useCallback(() => {
    const next = [...nodesRef.current, { title: 'Untitled', page: null, children: [] }];
    setNodes(next);
    void queuePersist(next);
  }, [queuePersist]);

  const addChild = useCallback(
    (path: number[]) => {
      const next = updateAt(nodesRef.current, path, (n) => ({
        ...n,
        children: [...n.children, { title: 'Untitled', page: null, children: [] }],
      }));
      setNodes(next);
      void queuePersist(next);
    },
    [queuePersist],
  );

  const deleteNode = useCallback(
    (path: number[]) => {
      const next = updateAt(nodesRef.current, path, () => null);
      setNodes(next);
      void queuePersist(next);
    },
    [queuePersist],
  );

  const jumpTo = useCallback(
    (page: number | null) => {
      if (page == null || !activeFile) return;
      getCanvasServices()?.canvas()?.centerOn(`${activeFile.path}#p${page - 1}`);
    },
    [activeFile],
  );

  // ── Reorder (from OutlineSidebar) ────────────────────────────────────────
  const dragCache = useRef<{ rest: FlatNode[]; mids: number[]; scrollTop0: number } | null>(null);
  const measureRest = (path: number[]) => {
    const rest = restRows(flattenOutline(nodesRef.current), path);
    const listEl = listRef.current;
    const mids = rest.map((f) => {
      const el = listEl?.querySelector(`[data-outline-row="${f.path.join('.')}"]`);
      const r = el?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY;
    });
    return { rest, mids, scrollTop0: listEl?.scrollTop ?? 0 };
  };
  const projectFromCache = (
    s: DragState,
    cache: { rest: FlatNode[]; mids: number[]; scrollTop0: number },
    clientX: number,
    clientY: number,
  ) => {
    const y = clientY + ((listRef.current?.scrollTop ?? 0) - cache.scrollTop0);
    const desired = s.path.length - 1 + Math.round((clientX - s.startX) / INDENT_PX);
    return projectDrop(cache.rest, cache.mids, y, desired);
  };

  const detachRef = useRef<() => void>(() => {});
  const dragMove = useCallback((e: PointerEvent): void => {
    const s = session.current;
    if (!s) return;
    if (!s.started) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.started = true;
      dragCache.current = measureRest(s.path);
    }
    const cache = dragCache.current;
    if (!cache) return;
    const { overIndex, depth } = projectFromCache(s, cache, e.clientX, e.clientY);
    s.overIndex = overIndex;
    s.depth = depth;
    setDrag({ ...s });
  }, []);

  const dragEnd = useCallback(
    (e: PointerEvent): void => {
      const s = session.current;
      const cache = dragCache.current;
      session.current = null;
      dragCache.current = null;
      detachRef.current();
      setDrag(null);
      if (!s || !s.started || !cache) return; // below threshold — not a reorder
      // Abort if the active file changed mid-drag — the cache + path index the
      // OLD tree; applying to the reloaded (different) file's outline would
      // corrupt it and save to the wrong file (same guard as the Pages panel).
      if (s.filePath !== activeFilePathRef.current) return;
      const { overIndex, depth } = projectFromCache(s, cache, e.clientX, e.clientY);
      const next = moveOutlineNode(nodesRef.current, s.path, overIndex, depth);
      if (outlinesEqual(next, nodesRef.current)) return; // structural no-op
      setNodes(next);
      void queuePersist(next);
    },
    [queuePersist],
  );

  const onHandlePointerDown = useCallback(
    (path: number[], e: React.PointerEvent): void => {
      if (e.button !== 0 || session.current) return;
      e.preventDefault();
      session.current = {
        path,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        overIndex: 0,
        depth: 0,
        filePath: activeFilePathRef.current,
      };
      const onUp = (ev: PointerEvent) => dragEnd(ev);
      const cancel = () => {
        session.current = null;
        dragCache.current = null;
        detachRef.current();
        setDrag(null);
      };
      window.addEventListener('pointermove', dragMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', cancel);
      // Match usePageDrag / the Pages panel: blur + Escape abort the drag.
      window.addEventListener('blur', cancel);
      const unEscape = pushEscapeInterceptor(() => {
        cancel();
        return true;
      });
      detachRef.current = () => {
        window.removeEventListener('pointermove', dragMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('blur', cancel);
        unEscape();
      };
    },
    [dragMove, dragEnd],
  );

  useEffect(() => () => detachRef.current(), []);

  // e2e harness (moved from OutlineSidebar in M3.2b): the tree drag is
  // pointer-capture, so expose the reader + the exact drop path while mounted.
  const queuePersistRef = useRef(queuePersist);
  queuePersistRef.current = queuePersist;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasOutline({
      getOrder: () =>
        flattenOutline(nodesRef.current).map((f) => ({
          title: f.node.title,
          depth: f.depth,
          page: f.node.page,
        })),
      reorder: async (fromPath, overIndex, depth) => {
        const next = moveOutlineNode(nodesRef.current, fromPath, overIndex, depth);
        setNodes(next);
        await queuePersistRef.current(next);
      },
    });
    return () => registerCanvasOutline(null);
  }, []);

  const flat = useMemo(() => flattenOutline(nodes), [nodes]);
  const draggedPath = drag?.started ? drag.path : null;
  const rest = draggedPath ? restRows(flat, draggedPath) : [];
  const indicatorPath = draggedPath ? rest[drag!.overIndex]?.path ?? null : null;
  const indicatorAtEnd = draggedPath ? drag!.overIndex >= rest.length : false;

  if (!activeFile) {
    return <div className="navpanel-empty" data-testid="bookmarks-panel">No document open.</div>;
  }

  return (
    <div className="bookmarks-panel flex flex-col h-full min-h-0" data-testid="bookmarks-panel">
      <div className="navpanel-scroll bookmarks-list flex-1" ref={listRef}>
        {flat.length === 0 && <p className="navpanel-empty">No bookmarks yet.</p>}
        {flat.map((f) => {
          const key = f.path.join('.');
          const isDragged = draggedPath != null && isPathPrefix(draggedPath, f.path);
          return (
            <div key={key}>
              {indicatorPath && indicatorPath.join('.') === key && (
                <div className="outline-drop-indicator" style={{ marginLeft: drag!.depth * INDENT_PX }} />
              )}
              <div
                data-outline-row={key}
                data-testid="bookmark-row"
                className={'bookmark-row group' + (isDragged ? ' dragging' : '')}
                style={{ marginLeft: f.depth * INDENT_PX }}
              >
                <span
                  className="bookmark-handle"
                  data-testid="bookmark-handle"
                  title="Drag to reorder / nest"
                  onPointerDown={(e) => onHandlePointerDown(f.path, e)}
                >
                  <ChromeIcon icon="overflow" size={12} />
                </span>
                <input
                  data-testid="bookmark-title"
                  value={f.node.title}
                  onChange={(e) => editNode(f.path, (n) => ({ ...n, title: e.target.value }))}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="bookmark-title-input"
                  placeholder="Untitled"
                />
                <button
                  className="bookmark-jump"
                  title={f.node.page != null ? `Jump to page ${f.node.page}` : 'No target page'}
                  disabled={f.node.page == null}
                  onClick={() => jumpTo(f.node.page)}
                >
                  {f.node.page ?? '—'}
                </button>
                <input
                  data-testid="bookmark-page"
                  type="number"
                  min={1}
                  max={activeFile.pageCount}
                  value={f.node.page ?? ''}
                  placeholder="—"
                  title="Target page"
                  onChange={(e) => {
                    const v =
                      e.target.value === ''
                        ? null
                        : Math.max(1, Math.min(activeFile.pageCount, Number(e.target.value)));
                    editNode(f.path, (n) => ({ ...n, page: v }));
                  }}
                  onBlur={commitEdit}
                  className="bookmark-page-input"
                />
                <button
                  title="Add child bookmark"
                  onClick={() => addChild(f.path)}
                  className="bookmark-btn opacity-0 group-hover:opacity-100"
                >
                  +
                </button>
                <button
                  data-testid="bookmark-delete"
                  title="Delete bookmark (and children)"
                  onClick={() => deleteNode(f.path)}
                  className="bookmark-btn bookmark-btn-danger opacity-0 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
        {indicatorAtEnd && <div className="outline-drop-indicator" style={{ marginLeft: drag!.depth * INDENT_PX }} />}
      </div>
      <div className="bookmarks-footer">
        <button data-testid="bookmark-add" onClick={addRoot} className="bookmark-add-btn">
          + Add bookmark
        </button>
        {status && <span className="bookmark-status">{status}</span>}
      </div>
    </div>
  );
}
