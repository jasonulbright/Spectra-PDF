import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import { useAppDispatch } from '../../state/AppStateProvider';
import { file } from '../../lib/tauri-bridge';
import {
  flattenOutline,
  restRows,
  clampDropDepth,
  moveOutlineNode,
  isPathPrefix,
  outlinesEqual,
} from '../../lib/outline-reorder';
import type { OutlineNode, FlatNode } from '../../lib/outline-reorder';
import type { OpenFile } from '../../state/types';
import { TEST_HARNESS_ENABLED, registerCanvasOutline } from '../../testHarness';

interface OutlineSidebarProps {
  // The file whose bookmarks are shown — the canvas's active file. Null renders
  // the empty state.
  activeFile: OpenFile | null;
  // Jump the canvas camera to a page id (`path#pN`) — wired to centerOn.
  onJumpToPage: (pageId: string) => void;
  onClose: () => void;
}

const INDENT_PX = 16;
const DRAG_THRESHOLD_PX = 5;

interface DragState {
  path: number[];
  startX: number;
  startY: number;
  started: boolean;
  overIndex: number;
  depth: number;
}

// Reorder + click-to-jump outline sidebar (2n.2). Reorder uses the same
// window-level pointer pattern as the canvas page drag (HTML5 DnD can't
// complete in the WebView); each drop auto-saves through set_outline ->
// UPDATE_FILE, so it lands on the snapshot-undo chain like the Bookmarks panel.
// Content editing (title/page/add/delete) stays in the Tools > Bookmarks panel.
export function OutlineSidebar({
  activeFile,
  onJumpToPage,
  onClose,
}: OutlineSidebarProps): React.JSX.Element {
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

  // (Re)load the active file's outline whenever its bytes change — same reload
  // key as OutlinePanel, so it re-reads after commits/undo/other ops (which
  // reindex the file and can renumber pages).
  useEffect(() => {
    if (!activeFile) {
      setNodes([]);
      setLoadedFor(null);
      return;
    }
    const key = `${activeFile.path}#${activeFile.pageCount}#${activeFile.undoStack.length}`;
    if (key === loadedFor) return;
    let cancelled = false;
    call('get_outline', { file: activeFile.workingPath })
      .then((res) => {
        if (cancelled) return;
        setNodes((res.outline as OutlineNode[]) ?? []);
        setLoadedFor(key);
        setStatus(res.truncated ? 'Outline truncated (too many bookmarks)' : '');
      })
      .catch((e: unknown) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [activeFile, call, loadedFor]);

  const persist = useCallback(
    async (next: OutlineNode[]) => {
      if (!activeFile) return;
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
        setStatus('');
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
        // Reload from disk on failure so the view matches the file.
        setLoadedFor(null);
      }
    },
    [activeFile, call, dispatch],
  );

  // Values the (stable) window listeners need at fire time — read via a ref so
  // the listeners never go stale and add/remove always use the same references
  // (same pattern as usePageDrag; a mid-drag re-render must not swap them).
  const dragDeps = useRef({ activeFile, onJumpToPage, persist });
  dragDeps.current = { activeFile, onJumpToPage, persist };

  // Persists are chained so two quick drops can't race on the same working file
  // — interleaved snapshot/set_outline/readBuffer would let a stale order win
  // and leave a hole in the undo chain. Each drop's save runs strictly after
  // the previous one finishes (mirrors OutlinePanel's busy-gated single save,
  // adapted to the auto-save-per-drop model).
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const queuePersist = (next: OutlineNode[]): Promise<void> => {
    const run = saveChain.current.then(() => dragDeps.current.persist(next));
    saveChain.current = run.catch(() => {}); // keep the chain alive after a failure
    return run;
  };

  // Non-dragged rows + their midpoints, measured ONCE at drag start: the drop
  // gap is then a cheap number scan per pointermove instead of an O(N)
  // re-flatten + N live DOM queries every event (outlines reach the engine's
  // 10k-node cap; usePageDrag likewise hit-tests precomputed geometry).
  const dragCache = useRef<{ rest: FlatNode[]; mids: number[] } | null>(null);
  const measureRest = (path: number[]): { rest: FlatNode[]; mids: number[] } => {
    const rest = restRows(flattenOutline(nodesRef.current), path);
    const listEl = listRef.current;
    const mids = rest.map((f) => {
      const el = listEl?.querySelector(`[data-outline-row="${f.path.join('.')}"]`);
      const r = el?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY;
    });
    return { rest, mids };
  };

  const projectFromCache = (
    s: DragState,
    cache: { rest: FlatNode[]; mids: number[] },
    clientX: number,
    clientY: number,
  ): { overIndex: number; depth: number } => {
    let overIndex = 0;
    for (const m of cache.mids) if (clientY > m) overIndex++;
    const desired = s.path.length - 1 + Math.round((clientX - s.startX) / INDENT_PX);
    return { overIndex, depth: clampDropDepth(cache.rest, overIndex, desired) };
  };

  function onPointerMove(e: PointerEvent): void {
    const s = session.current;
    if (!s) return;
    if (!s.started) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.started = true;
      dragCache.current = measureRest(s.path); // measure once, at drag start
    }
    const cache = dragCache.current;
    if (!cache) return;
    const { overIndex, depth } = projectFromCache(s, cache, e.clientX, e.clientY);
    s.overIndex = overIndex;
    s.depth = depth;
    setDrag({ ...s });
  }

  function onPointerUp(e: PointerEvent): void {
    const s = session.current;
    const cache = dragCache.current;
    teardown();
    if (!s) return;
    const { activeFile: af, onJumpToPage: jump } = dragDeps.current;
    if (!s.started || !cache) {
      // A click, not a drag — jump to the node's page if it has one.
      const hit = flattenOutline(nodesRef.current).find((f) => f.path.join('.') === s.path.join('.'));
      const page = hit?.node.page;
      if (page != null && af) jump(`${af.path}#p${page - 1}`);
      return;
    }
    const { overIndex, depth } = projectFromCache(s, cache, e.clientX, e.clientY);
    const next = moveOutlineNode(nodesRef.current, s.path, overIndex, depth);
    if (outlinesEqual(next, nodesRef.current)) return; // structural no-op → skip the save
    setNodes(next);
    void queuePersist(next);
  }

  const teardown = useCallback((): void => {
    session.current = null;
    dragCache.current = null;
    setDrag(null);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPointerCancel(): void {
    teardown();
  }

  const onRowPointerDown = useCallback((path: number[], e: React.PointerEvent): void => {
    if (e.button !== 0 || session.current) return;
    e.preventDefault();
    session.current = { path, startX: e.clientX, startY: e.clientY, started: false, overIndex: 0, depth: 0 };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => teardown, [teardown]); // cleanup on unmount

  // e2e harness (2n.2): the tree drag is pointer-capture, so expose a reader +
  // the exact drop path while mounted. Reads the latest tree/persist via refs.
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
        await queuePersist(next);
      },
    });
    return () => registerCanvasOutline(null);
  }, []);

  const flat = flattenOutline(nodes);
  const draggedPath = drag?.started ? drag.path : null;
  // Which rest-row the drop indicator sits above (by rest-order index).
  const rest = draggedPath ? restRows(flat, draggedPath) : [];
  const indicatorPath = draggedPath ? rest[drag!.overIndex]?.path ?? null : null;
  const indicatorAtEnd = draggedPath ? drag!.overIndex >= rest.length : false;

  return (
    <div className="comment-sidebar" data-testid="outline-sidebar">
      <div className="comment-sidebar-header">
        <span>Outline ({flat.length})</span>
        <button className="comment-sidebar-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="comment-sidebar-list outline-sidebar-list" ref={listRef}>
        {flat.length === 0 && (
          <p className="comment-sidebar-empty">
            No bookmarks. Add them in Tools ▸ Bookmarks; here you can jump to and reorder them.
          </p>
        )}
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
                className={'outline-row' + (isDragged ? ' dragging' : '')}
                style={{ marginLeft: f.depth * INDENT_PX }}
                onPointerDown={(e) => onRowPointerDown(f.path, e)}
                title={f.node.page != null ? `Jump to page ${f.node.page}` : f.node.title}
              >
                <span className="outline-row-title">{f.node.title || 'Untitled'}</span>
                {f.node.page != null && <span className="outline-row-page">{f.node.page}</span>}
              </div>
            </div>
          );
        })}
        {indicatorAtEnd && <div className="outline-drop-indicator" style={{ marginLeft: drag!.depth * INDENT_PX }} />}
      </div>
      {status && <div className="outline-sidebar-status">{status}</div>}
    </div>
  );
}

