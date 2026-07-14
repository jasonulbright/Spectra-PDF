import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { logRenderError, scheduleReblit } from '../canvas/raster';
import { getCanvasServices, pushEscapeInterceptor } from '../../commands/context';
import { buildPageContextMenu } from '../../lib/page-context-menu';
import { computeReorderTarget } from '../../lib/page-reorder';
import { ContextMenu } from '../ContextMenu';
import type { NavPanelComponentProps } from './types';
import type { PageRef } from '../../state/types';

// Pages (thumbnails) panel — Phase 4 M3.1 (§ 5.1). Small renders of the active
// file's pages through the same pdf.js proxy the board uses (one per file via
// pdfDocCache); virtualized to a window around the scroll viewport. Click →
// select (the SHARED ui.selectedPageIds) + centerOn the board; the context
// menu is the shared page menu (§ 3.2). Drag-reorder lands in the next M3.1
// sub-slice; the board's reorder remains available meanwhile.

const ROW_H = 172; // fixed slot: thumbnail area + page-number label
const THUMB_MAX_H = 136;
const SIDE_PAD = 16; // horizontal padding inside the scroller
const OVERSCAN = 3; // rows rendered beyond the viewport each side
// Rotation-invariant raster budget (longest side, CSS px before dpr). Fixed so
// a pending rotation never re-renders the raster (only the CSS transform/size
// change) — the board's PageView convention.
const RENDER_TARGET = 320;

interface PageItem {
  docId: string;
  page: PageRef;
  pageNumber: number; // 1-based within the file (workspace order across its docs)
}

function dprCap(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// One thumbnail: renders the page at natural orientation to a device-pixel
// canvas, then CSS-rotates by the pending PageRef rotation — exactly the
// board's PageView approach, so a pending rotation shows without a re-render
// of the file. `version` bumps to force a re-render after a buffer swap.
function Thumbnail({
  proxy,
  pageNumber,
  natW,
  natH,
  rotation,
  maxW,
  version,
}: {
  proxy: PDFDocumentProxy | undefined;
  pageNumber: number;
  natW: number;
  natH: number;
  rotation: 0 | 90 | 180 | 270;
  maxW: number;
  version: number;
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  // First paint lands immediately; a buffer-swap re-render (version bump)
  // batches through the shared anti-ripple scheduler.
  const hasPaintedRef = useRef(false);

  // Display footprint (rotation-aware) — the raster below is NOT: it renders at
  // a fixed budget from the natural dims, and CSS rotates + sizes it. So a
  // pending rotation only updates the transform, never re-renders.
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? natH : natW;
  const dispH = swapped ? natW : natH;
  const fit = Math.min(maxW / dispW, THUMB_MAX_H / dispH) || 0;
  const natWpx = Math.max(1, natW * fit);
  const natHpx = Math.max(1, natH * fit);

  useEffect(() => {
    if (!proxy) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    setReady(false);
    (async () => {
      const page = await proxy.getPage(pageNumber);
      if (cancelled) return;
      // Scale from the natural (rotation-correct) dims — NOT page.view, the raw
      // MediaBox, which doesn't reflect an intrinsic /Rotate (review-caught:
      // wrong density on scanned/faxed pages). Render offscreen, then blit.
      const scale = (RENDER_TARGET * dprCap()) / Math.max(natW, natH);
      const viewport = page.getViewport({ scale });
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.floor(viewport.width));
      off.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport });
      await task.promise;
      if (cancelled) return;
      const paint = (): void => {
        if (cancelled) return;
        const canvas = ref.current;
        if (!canvas) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        setReady(true);
      };
      if (hasPaintedRef.current) {
        scheduleReblit(paint);
      } else {
        paint();
        hasPaintedRef.current = true;
      }
    })().catch(logRenderError('thumbnail'));
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        // already settled
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxy, pageNumber, version]);

  return (
    <div
      className="thumb-frame"
      style={{ width: dispW * fit, height: dispH * fit }}
    >
      <canvas
        ref={ref}
        className={ready ? '' : 'opacity-0'}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: natWpx,
          height: natHpx,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }}
      />
    </div>
  );
}

export function PagesPanel({ activeFile, onOpenPage, onExtractText }: NavPanelComponentProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const proxies = usePdfProxies(state.files);
  const selected = state.ui.selectedPageIds;
  const docs = state.workspace.documents;

  // The active file's pages in workspace order (across its manifest documents).
  const items = useMemo<PageItem[]>(() => {
    if (!activeFile) return [];
    const out: PageItem[] = [];
    let n = 0;
    for (const doc of docs) {
      if (doc.path !== activeFile.path) continue;
      for (const page of doc.pages) {
        n += 1;
        out.push({ docId: doc.id, page, pageNumber: n });
      }
    }
    return out;
  }, [docs, activeFile]);

  // Virtualization window over a fixed row height.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ h: 0, w: 0 });

  // The panel stays mounted across doc-tab switches, so reset the scroll when
  // the subject file changes — otherwise a deep scroll offset carried into a
  // shorter file leaves the virtualization window past the end (empty panel,
  // review-caught).
  useEffect(() => {
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [activeFile?.path]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewport({ h: el.clientHeight, w: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Buffer-swap version per source file (thumbnails re-render on commit/undo).
  const version = useMemo(() => {
    let v = 0;
    if (activeFile) v = activeFile.pageCount + activeFile.undoStack.length;
    return v;
  }, [activeFile]);

  const maxThumbW = Math.max(40, viewport.w - SIDE_PAD * 2);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport.h) / ROW_H) + OVERSCAN);
  const windowItems = items.slice(start, end);

  const [menu, setMenu] = useState<{ x: number; y: number; docId: string; pageId: string } | null>(null);

  // ── Drag-reorder (M3.1b) ─────────────────────────────────────────────────
  // A linear-list pointer drag (window-level listeners, the canvas pattern —
  // HTML5 DnD can't complete in the webview). Below the threshold it's a click
  // (select); above, it reorders via MOVE_PAGE/MOVE_PAGES. Refs feed the stable
  // window handlers the latest items/selection; a per-drag `detachRef` removes
  // that drag's listeners (also on unmount), so no handler-identity juggling.
  const [dropGap, setDropGap] = useState<number | null>(null);
  const dragRef = useRef<{ grabbedId: string; startX: number; startY: number; started: boolean; movingIds: string[]; filePath: string | undefined } | null>(null);
  const detachRef = useRef<() => void>(() => {});
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The file the drag started against — a mid-drag tab switch (Ctrl+Tab while
  // the button is held) must NOT splice pages into a different open PDF.
  const activeFilePathRef = useRef(activeFile?.path);
  activeFilePathRef.current = activeFile?.path;

  const flatIndexAt = useCallback((clientY: number): number => {
    const el = scrollerRef.current;
    if (!el) return 0;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    return Math.max(0, Math.min(itemsRef.current.length, Math.round(y / ROW_H)));
  }, []);

  const dragMove = useCallback(
    (e: PointerEvent): void => {
      const s = dragRef.current;
      if (!s) return;
      if (!s.started) {
        if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < 6) return;
        s.started = true;
        // Capture the moving set at drag start: the whole selection if the
        // grabbed page is part of a multi-selection, else just that page.
        const sel = selectedRef.current;
        s.movingIds =
          sel.has(s.grabbedId) && sel.size > 1
            ? itemsRef.current.filter((it) => sel.has(it.page.id)).map((it) => it.page.id)
            : [s.grabbedId];
      }
      setDropGap(flatIndexAt(e.clientY));
    },
    [flatIndexAt],
  );

  // Finish a drag. `drop` = pointerup (apply the move); false = cancel/unmount.
  const finishDrag = useCallback(
    (clientY: number, drop: boolean): void => {
      const s = dragRef.current;
      dragRef.current = null;
      detachRef.current();
      setDropGap(null);
      if (!drop || !s || !s.started) return; // below threshold → a click; onClick selects
      // Swallow the click that follows a completed drag so it doesn't reselect.
      const swallow = (ev: MouseEvent): void => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);

      // Abort if the active file changed mid-drag, or any moving page is no
      // longer in the current file's items — else the reducer (which searches
      // ALL workspace docs) would move them into whatever file is now shown
      // (review-caught HIGH; the single-page path already self-guards via the
      // `from` lookup below, this covers the multi path too).
      if (s.filePath !== activeFilePathRef.current) return;
      const currentIds = new Set(itemsRef.current.map((it) => it.page.id));
      if (!s.movingIds.every((id) => currentIds.has(id))) return;

      const target = computeReorderTarget(
        itemsRef.current.map((it) => ({ docId: it.docId, pageId: it.page.id })),
        s.movingIds,
        flatIndexAt(clientY),
      );
      if (!target) return;
      if (s.movingIds.length === 1) {
        const from = itemsRef.current.find((it) => it.page.id === s.movingIds[0]);
        if (!from) return;
        dispatch({ type: 'MOVE_PAGE', fromDocId: from.docId, toDocId: target.toDocId, pageId: s.movingIds[0], toIndex: target.toIndex });
      } else {
        dispatch({ type: 'MOVE_PAGES', pageIds: s.movingIds, toDocId: target.toDocId, toIndex: target.toIndex });
      }
      dispatch({ type: 'UI_SET_SELECTION', pageIds: s.movingIds, anchor: s.movingIds[s.movingIds.length - 1] });
    },
    [dispatch, flatIndexAt],
  );

  const onRowPointerDown = useCallback(
    (item: PageItem, e: React.PointerEvent): void => {
      if (e.button !== 0 || dragRef.current) return;
      dragRef.current = {
        grabbedId: item.page.id,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        movingIds: [item.page.id],
        filePath: activeFilePathRef.current,
      };
      const onUp = (ev: PointerEvent) => finishDrag(ev.clientY, true);
      const cancel = () => finishDrag(0, false); // pointercancel / blur / Escape
      window.addEventListener('pointermove', dragMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', cancel);
      // Match usePageDrag's safety nets: window blur and Escape abort the drag
      // (review-caught — otherwise a focus loss strands the window listeners
      // and a later unrelated click resolves the stale session).
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
    [dragMove, finishDrag],
  );

  // Detach an in-flight drag's listeners if the panel unmounts.
  useEffect(() => () => detachRef.current(), []);

  const onThumbClick = useCallback(
    (item: PageItem, e: React.MouseEvent) => {
      const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single';
      dispatch({ type: 'UI_SELECT_PAGE', pageId: item.page.id, mode });
      getCanvasServices()?.canvas()?.centerOn(item.page.id);
    },
    [dispatch],
  );

  const onThumbContextMenu = useCallback(
    (item: PageItem, e: React.MouseEvent) => {
      e.preventDefault();
      // Right-click keeps a selection that contains the page, else selects it.
      dispatch({ type: 'UI_SELECT_PAGE', pageId: item.page.id, mode: 'context' });
      setMenu({ x: e.clientX, y: e.clientY, docId: item.docId, pageId: item.page.id });
    },
    [dispatch],
  );

  const menuItems = useMemo(
    () =>
      menu
        ? buildPageContextMenu({
            docs,
            docId: menu.docId,
            pageId: menu.pageId,
            selectedPageIds: selected,
            dispatch,
            onOpen: onOpenPage,
            onExtractText,
          })
        : [],
    [menu, docs, selected, dispatch, onOpenPage, onExtractText],
  );

  if (!activeFile) {
    return <div className="navpanel-empty" data-testid="pages-panel">No document open.</div>;
  }

  return (
    <div
      ref={scrollerRef}
      data-testid="pages-panel"
      className="navpanel-scroll pages-panel"
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: items.length * ROW_H, position: 'relative' }}>
        {windowItems.map((item, i) => {
          const index = start + i;
          const isSelected = selected.has(item.page.id);
          const proxy = proxies.get(item.page.sourceDocId);
          return (
            <div
              key={item.page.id}
              data-testid="thumb"
              data-page-id={item.page.id}
              className={'thumb-row' + (isSelected ? ' selected' : '')}
              style={{ position: 'absolute', top: index * ROW_H, height: ROW_H, left: 0, right: 0 }}
              onPointerDown={(e) => onRowPointerDown(item, e)}
              onClick={(e) => onThumbClick(item, e)}
              onContextMenu={(e) => onThumbContextMenu(item, e)}
            >
              <Thumbnail
                proxy={proxy}
                pageNumber={item.page.sourcePageIndex + 1}
                natW={item.page.width}
                natH={item.page.height}
                rotation={item.page.rotation}
                maxW={maxThumbW}
                version={version}
              />
              <div className="thumb-label">{item.pageNumber}</div>
            </div>
          );
        })}
        {dropGap !== null && (
          <div className="thumb-drop-indicator" data-testid="thumb-drop-indicator" style={{ top: dropGap * ROW_H }} />
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
