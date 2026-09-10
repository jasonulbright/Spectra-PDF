import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import { useOperations } from '../../hooks/useOperations';
import { useBookmarkDrafts } from '../../state/AppStateProvider';
import type { BookmarkDraft } from '../../lib/bookmark-drafts';
import { runCommitGate } from '../../lib/commit-gate';
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
import { inlineDelta } from '../../lib/inline-direction';
import { pageFieldWidth, pageLabelWidth } from '../../lib/page-field-width';
import { ChromeIcon } from '../chrome-icons';
import { TEST_HARNESS_ENABLED, registerCanvasOutline } from '../../testHarness';
import type { PdfBuffer } from '../../state/types';
import type { NavPanelComponentProps } from './types';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';

// Bookmarks nav panel — the ONE bookmarks surface, merging the
// canvas OutlineSidebar (drag-reorder + click-to-jump) with the
// OutlinePanel's editing (rename / retarget page / add child / delete). Reorder
// starts ONLY from the drag handle so the inline inputs stay editable. Every
// mutation (reorder, edit-on-blur, add, delete) routes through one queued
// persist (private `set_outline` → validated publication), chained so two can't
// race. `outline-reorder.ts` is
// untouched.

const INDENT_PX = 16;
const DRAG_THRESHOLD_PX = 5;
const EMPTY_NODES: OutlineNode[] = [];

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
  owner: BookmarkDraft;
  buffer: PdfBuffer | null;
  nodes: OutlineNode[];
}

export function BookmarksPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const drafts = useBookmarkDrafts();
  const draft = drafts.get(activeFile);
  const nodes = draft?.nodes ?? EMPTY_NODES;
  const loaded = !!draft?.loaded;
  const editable = !!draft && drafts.editable(draft);
  const conflict = !!draft && drafts.conflict(draft);
  const status = conflict ? tChrome('nav.bookmarks.sourceChanged') : draft?.error || draft?.status || '';
  const derive = draft?.preview ?? null, deriveMode = draft?.mode ?? 'replace', deriving = draft?.deriving ?? false;
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const session = useRef<DragState | null>(null);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const draftRef = useRef(draft); draftRef.current = draft;
  const ioRef = useRef({ performOperation, call }); ioRef.current = { performOperation, call };

  useEffect(() => { if (draft) void drafts.load(draft, call); });
  useEffect(() => () => { if (draft) drafts.cancelLoad(draft); }, [draft, drafts]);
  const persist = useCallback(async () => {
    if (draft) await drafts.flush(draft, performOperation, call, runCommitGate);
  }, [draft, drafts, performOperation, call]);
  // Blur, a document switch and pane unmount all finish the OLD session's
  // gesture. The provider queue survives the pane, and deduplicates the blur.
  useEffect(() => () => {
    if (draft) void drafts.flush(draft, ioRef.current.performOperation, ioRef.current.call, runCommitGate);
  }, [draft, drafts]);
  const renderedBuffer = draft?.buffer ?? null;
  const editNode = useCallback((path: number[], fn: (n: OutlineNode) => OutlineNode | null) => {
    if (draft) drafts.change(draft, renderedBuffer, prev => updateAt(prev, path, fn));
  }, [draft, drafts, renderedBuffer]);
  const commitEdit = persist;
  const addRoot = useCallback(() => {
    if (!draft) return;
    drafts.change(draft, renderedBuffer, prev => [...prev, { title: tChrome('nav.bookmarks.untitled'), page: null, children: [] }]);
    void persist();
  }, [draft, drafts, renderedBuffer, persist]);
  const addChild = useCallback((path: number[]) => {
    editNode(path, n => ({ ...n, children: [...n.children, { title: tChrome('nav.bookmarks.untitled'), page: null, children: [] }] }));
    void persist();
  }, [editNode, persist]);
  const deleteNode = useCallback((path: number[]) => { editNode(path, () => null); void persist(); }, [editNode, persist]);

  const jumpTo = useCallback(
    (page: number | null) => {
      if (page == null || !activeFile) return;
      // jumpToFilePage, not canvas().centerOn: a bookmark addresses a page
      // of the FILE, which may sit in a `.pdfx` partition the reading view
      // isn't showing — centring there was a silent, zero-feedback no-op
      // (regression). The service resolves page number → id from live
      // workspace state (ids are opaque — generation-tagged or
      // adopted — so string-building `path#p{n}` is no longer valid).
      getCanvasServices()?.jumpToFilePage(activeFile.path, page);
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
    // Depth follows the INLINE axis: dragging toward the inline-end side
    // nests deeper, which is leftward under `dir=rtl`.
    const desired =
      s.path.length - 1 + Math.round(inlineDelta(clientX - s.startX) / INDENT_PX);
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
      const target = s.owner;
      if (!target || draftRef.current !== target || target.buffer !== s.buffer || target.nodes !== s.nodes || !drafts.editable(target)) return;
      const { overIndex, depth } = projectFromCache(s, cache, e.clientX, e.clientY);
      const next = moveOutlineNode(nodesRef.current, s.path, overIndex, depth);
      if (outlinesEqual(next, nodesRef.current)) return; // structural no-op
      drafts.change(target, s.buffer, () => next);
      void drafts.flush(target, performOperation, call, runCommitGate);
    },
    [drafts, performOperation, call],
  );

  const onHandlePointerDown = useCallback(
    (path: number[], e: React.PointerEvent): void => {
      if (e.button !== 0 || session.current || !draft || !drafts.editable(draft)) return;
      e.preventDefault();
      session.current = {
        path,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        overIndex: 0,
        depth: 0,
        owner: draft, buffer: draft.buffer, nodes: draft.nodes,
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
    [dragMove, dragEnd, draft, drafts],
  );

  useEffect(() => () => detachRef.current(), []);
  useEffect(() => { detachRef.current(); session.current = null; dragCache.current = null; setDrag(null); }, [draft]);

  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasOutline({
      getOrder: () => flattenOutline(draft?.nodes ?? []).map(f => ({ title: f.node.title, depth: f.depth, page: f.node.page })),
      reorder: async (fromPath, overIndex, depth) => {
        if (!draft) return;
        drafts.change(draft, draft.buffer, prev => moveOutlineNode(prev, fromPath, overIndex, depth));
        await drafts.flush(draft, performOperation, call, runCommitGate);
      },
    });
    return () => registerCanvasOutline(null);
  }, [draft, drafts, performOperation, call]);

  const openDerive = useCallback(async () => {
    if (draft) await drafts.preview(draft, call, runCommitGate);
  }, [draft, drafts, call]);
  const buildFromStructure = useCallback(async () => {
    if (draft) await drafts.derive(draft, performOperation);
  }, [draft, drafts, performOperation]);

  const flat = useMemo(() => flattenOutline(nodes), [nodes]);
  // Both page columns are sized to the document, so the widest page number in
  // THIS file renders whole.
  const pageInputWidth = pageFieldWidth(activeFile?.pageCount ?? 1);
  const pageLabelMinWidth = pageLabelWidth(activeFile?.pageCount ?? 1);
  const draggedPath = drag?.started ? drag.path : null;
  const rest = draggedPath ? restRows(flat, draggedPath) : [];
  const indicatorPath = draggedPath ? rest[drag!.overIndex]?.path ?? null : null;
  const indicatorAtEnd = draggedPath ? drag!.overIndex >= rest.length : false;


  if (!activeFile) {
    return (
      <div className="navpanel-empty" data-testid="bookmarks-panel">
        {tChrome('nav.common.noDocument')}
      </div>
    );
  }

  return (
    <div className="bookmarks-panel flex flex-col h-full min-h-0" data-testid="bookmarks-panel">
      {draft && (conflict || draft.error || draft.readOnly) && (
        <div role="alert" data-testid="bookmarks-revision-notice">
          <p>{status}</p>
          <button data-testid="bookmarks-reload" disabled={draft.busy || deriving} onClick={() => void drafts.reload(draft, runCommitGate)}>
            {draft.dirty ? tChrome('nav.bookmarks.discardReload') : tChrome('app.commit.retry')}
          </button>
        </div>
      )}
      <fieldset disabled={!editable} className="min-h-0 flex-1 flex flex-col">
      <div className="navpanel-scroll bookmarks-list flex-1" ref={listRef}>
        {!loaded && (
          <p className="navpanel-empty" data-testid="bookmarks-loading">
            {tChrome('nav.bookmarks.loading')}
          </p>
        )}
        {loaded && flat.length === 0 && (
          <p className="navpanel-empty">{tChrome('nav.bookmarks.empty')}</p>
        )}
        {loaded && flat.map((f) => {
          const key = f.path.join('.');
          const isDragged = draggedPath != null && isPathPrefix(draggedPath, f.path);
          return (
            <div key={key}>
              {indicatorPath && indicatorPath.join('.') === key && (
                <div className="outline-drop-indicator" style={{ marginInlineStart: drag!.depth * INDENT_PX }} />
              )}
              <div
                data-outline-row={key}
                data-testid="bookmark-row"
                className={'bookmark-row group' + (isDragged ? ' dragging' : '')}
              >
                {/* The nesting indent is a shrinkable spacer, not a row margin:
                    it gives up width before the fixed page columns can be
                    pushed past the panel's edge. */}
                {f.depth > 0 && (
                  <span className="bookmark-indent" style={{ width: f.depth * INDENT_PX }} />
                )}
                <span
                  className="bookmark-handle"
                  data-testid="bookmark-handle"
                  title={tChrome('nav.bookmarks.dragHandle')}
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
                  placeholder={tChrome('nav.bookmarks.untitled')}
                />
                <button
                  className="bookmark-jump"
                  title={
                    f.node.page != null
                      ? tChrome('nav.bookmarks.jumpToPage', { page: f.node.page })
                      : tChrome('nav.bookmarks.noTargetPage')
                  }
                  disabled={f.node.page == null}
                  onClick={() => jumpTo(f.node.page)}
                  style={{ minWidth: pageLabelMinWidth }}
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
                  title={tChrome('nav.bookmarks.targetPage')}
                  onChange={(e) => {
                    const v =
                      e.target.value === ''
                        ? null
                        : Math.max(1, Math.min(activeFile.pageCount, Number(e.target.value)));
                    // Retargeting drops the view position with it: `top` is a
                    // coordinate on the OLD page, and carrying it over would
                    // scroll the new page to wherever the old heading sat.
                    editNode(f.path, (n) => ({
                      ...n,
                      page: v,
                      left: undefined,
                      top: undefined,
                      zoom: undefined,
                    }));
                  }}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="bookmark-page-input"
                  style={{ width: pageInputWidth }}
                />
                <button
                  title={tChrome('nav.bookmarks.addChild')}
                  onClick={() => addChild(f.path)}
                  className="bookmark-btn opacity-0 group-hover:opacity-100"
                >
                  +
                </button>
                <button
                  data-testid="bookmark-delete"
                  title={tChrome('nav.bookmarks.delete')}
                  onClick={() => deleteNode(f.path)}
                  className="bookmark-btn bookmark-btn-danger opacity-0 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
        {loaded && indicatorAtEnd && <div className="outline-drop-indicator" style={{ marginInlineStart: drag!.depth * INDENT_PX }} />}
      </div>
      </fieldset>
      {derive && (
        <div className="bookmarks-derive" data-testid="bookmarks-derive">
          <div className="bookmarks-derive-state" data-testid="bookmarks-derive-state">
            {derive.tagged
              ? tChrome('nav.bookmarks.derive.found', { count: derive.headings })
              : tChrome('nav.bookmarks.derive.untagged')}
          </div>
          {derive.tagged && derive.skipped > 0 && (
            <div className="bookmarks-derive-state" data-testid="bookmarks-derive-skipped">
              {tChrome('nav.bookmarks.derive.skipped', { count: derive.skipped })}
            </div>
          )}
          {derive.tagged && derive.existing > 0 && (
            <label className="bookmarks-derive-mode">
              {tChrome('nav.bookmarks.derive.existing')}
              <select
                data-testid="bookmarks-derive-mode"
                value={deriveMode}
                disabled={deriving}
                onChange={(e) => { if (draft) drafts.setMode(draft, e.target.value === 'append' ? 'append' : 'replace'); }}
              >
                <option value="replace">{tChrome('nav.bookmarks.derive.replace')}</option>
                <option value="append">{tChrome('nav.bookmarks.derive.append')}</option>
              </select>
            </label>
          )}
          <div className="bookmarks-derive-actions">
            <button
              data-testid="bookmarks-derive-build"
              disabled={!editable || deriving || draft?.dirty || draft?.busy || (derive.tagged && derive.headings === 0)}
              onClick={() => void buildFromStructure()}
              className="bookmark-add-btn disabled:opacity-60"
            >
              {derive.tagged
                ? tChrome('nav.bookmarks.derive.build')
                : tChrome('nav.bookmarks.derive.tagThenBuild')}
            </button>
            <button
              data-testid="bookmarks-derive-cancel"
              onClick={() => { if (draft) drafts.cancelPreview(draft); }}
              className="bookmark-add-btn"
            >
              {tChrome('nav.bookmarks.derive.cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="bookmarks-footer">
        {draft?.dirty && !conflict && !draft.readOnly && (
          <button data-testid="bookmarks-retry" disabled={!editable || draft.busy} onClick={() => void persist()} className="bookmark-add-btn">
            {tChrome(draft.error ? 'app.commit.retry' : 'dialog.common.save')}
          </button>
        )}
        <button
          data-testid="bookmark-add"
          onClick={addRoot}
          disabled={!editable}
          className="bookmark-add-btn disabled:opacity-60"
        >
          {tChrome('nav.bookmarks.add')}
        </button>
        <button
          data-testid="bookmarks-from-structure"
          onClick={() => void openDerive()}
          disabled={!editable || deriving || draft?.busy || draft?.dirty}
          className="bookmark-add-btn disabled:opacity-60"
        >
          {tChrome('nav.bookmarks.derive.open')}
        </button>
        {status && <span className="bookmark-status">{status}</span>}
      </div>
    </div>
  );
}
