import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { ContextMenu } from '../ContextMenu';
import type { MenuItem } from '../ContextMenu';
import { Canvas } from './Canvas';
import { DocLayer } from './DocLayer';
import { HeaderLayer } from './HeaderLayer';
import { AddDocGhost, GhostRow } from './DropGhost';
import { deriveDropGhosts } from './ghost-size';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import type { DragSource } from '../../canvas/usePageDrag';
import type { OpenDocument, PageAnnotation } from '../../state/types';
import type { CanvasTool, StampPreset } from './PageCell';
import { STAMP_PRESETS, ANNOTATION_PALETTE } from './PageCell';
import { CommentSidebar } from './CommentSidebar';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Open the PageInspector overlay. `pageNumber` is the page's workspace
  // position within its file (== the file's page order once pending edits
  // commit, which the opener does first).
  onInspectPage: (path: string, pageNumber: number) => void;
  // Jump to the extract-text panel with the page pre-selected (same
  // workspace-position numbering; the engine gate commits before reading).
  onExtractText: (path: string, pageNumber: number) => void;
  onApplyChanges: () => void;
}

// A page's 1-based position within its file's committed order: pages of all
// same-path documents in workspace order. This is what the file looks like
// after the commit bridge materializes pending edits.
function workspacePageNumber(
  docs: OpenDocument[],
  doc: OpenDocument,
  pageId: string,
): number | null {
  const index = doc.pages.findIndex((p) => p.id === pageId);
  if (index === -1) return null;
  let before = 0;
  for (const d of docs) {
    if (d.path !== doc.path) continue;
    if (d.id === doc.id) return before + index + 1;
    before += d.pages.length;
  }
  return null;
}

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,
  onInspectPage,
  onExtractText,
  onApplyChanges,
}: WorkspaceCanvasViewProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const docs = state.workspace.documents;
  const proxies = usePdfProxies(state.files);
  const layout = useMemo(() => computeLayout(docs), [docs]);
  const canvasRef = useRef<CanvasHandle | null>(null);
  const [selected, setSelected] = useState<DragSource | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string; pageId: string } | null>(
    null,
  );
  const [tool, setTool] = useState<CanvasTool>('select');
  // Color picker for the annotation tools: null keeps each tool's own default
  // (yellow highlight, dark freetext, blue ink); a pick applies to whichever
  // tool creates the next annotation, across tool switches.
  const [toolColor, setToolColor] = useState<string | null>(null);
  const [stampPreset, setStampPreset] = useState<StampPreset | null>(null);
  const [showComments, setShowComments] = useState(false);

  // Escape returns to Select from the highlight tool.
  React.useEffect(() => {
    if (tool === 'select') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTool('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  const onAddAnnotation = useCallback(
    (docId: string, pageId: string, annotation: PageAnnotation) =>
      dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
    [dispatch],
  );

  const onUpdateAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, note: string) =>
      dispatch({ type: 'UPDATE_ANNOTATION', docId, pageId, annotationId, note }),
    [dispatch],
  );

  const onRecolorAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, color: string) =>
      dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
    [dispatch],
  );

  const onRemoveAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string) =>
      dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
    [dispatch],
  );

  const movePageInto = useCallback(
    (source: DragSource, targetDocId: string, index: number) => {
      dispatch({
        type: 'MOVE_PAGE',
        fromDocId: source.docId,
        toDocId: targetDocId,
        pageId: source.pageId,
        toIndex: index,
      });
      setSelected({ docId: targetDocId, pageId: source.pageId });
    },
    [dispatch],
  );

  const movePageToNewDoc = useCallback(
    (source: DragSource, docIndex: number) => {
      const sourceDoc = docs.find((d) => d.id === source.docId);
      if (!sourceDoc) return;
      const newDocId = crypto.randomUUID();
      const newName = uniqueDocName(
        sourceDoc.name,
        new Set(docs.filter((d) => d.id !== source.docId || d.pages.length > 1).map((d) => d.name)),
      );
      dispatch({
        type: 'MOVE_PAGE_TO_NEW_DOC',
        fromDocId: source.docId,
        pageId: source.pageId,
        docIndex,
        newDocId,
        newName,
      });
      setSelected({ docId: newDocId, pageId: source.pageId });
    },
    [dispatch, docs],
  );

  const drag = usePageDrag({ layout, canvasRef, movePageInto, movePageToNewDoc });

  const onSelectPage = useCallback(
    (docId: string, pageId: string) => setSelected({ docId, pageId }),
    [],
  );

  const onOpenPage = useCallback(
    (docId: string, pageId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const pageNumber = workspacePageNumber(docs, doc, pageId);
      if (pageNumber != null) onInspectPage(doc.path, pageNumber);
    },
    [docs, onInspectPage],
  );

  const onPageContextMenu = useCallback(
    (docId: string, pageId: string, e: React.MouseEvent) => {
      setSelected({ docId, pageId });
      setMenu({ x: e.clientX, y: e.clientY, docId, pageId });
    },
    [],
  );

  const rotateBy = useCallback(
    (docId: string, pageId: string, delta: 90 | 270) => {
      const page = docs.find((d) => d.id === docId)?.pages.find((p) => p.id === pageId);
      if (!page) return;
      const rotation = (((page.rotation + delta) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
      dispatch({ type: 'ROTATE_PAGE_REF', docId, pageId, rotation });
    },
    [dispatch, docs],
  );

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return [];
    const doc = docs.find((d) => d.id === menu.docId);
    if (!doc) return [];
    const fileHasOnePage =
      docs.filter((d) => d.path === doc.path).reduce((sum, d) => sum + d.pages.length, 0) <= 1;
    return [
      {
        label: 'Open',
        onClick: () => {
          const pageNumber = workspacePageNumber(docs, doc, menu.pageId);
          if (pageNumber != null) onInspectPage(doc.path, pageNumber);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      { label: 'Rotate right 90°', onClick: () => rotateBy(menu.docId, menu.pageId, 90) },
      { label: 'Rotate left 90°', onClick: () => rotateBy(menu.docId, menu.pageId, 270) },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Extract text…',
        onClick: () => {
          const pageNumber = workspacePageNumber(docs, doc, menu.pageId);
          if (pageNumber != null) onExtractText(doc.path, pageNumber);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Delete page',
        danger: true,
        // A file's last page can't be deleted (0-page PDFs can't exist) —
        // closing the file is the right gesture for that.
        disabled: fileHasOnePage,
        onClick: () => dispatch({ type: 'DELETE_PAGE_REF', docId: menu.docId, pageId: menu.pageId }),
      },
    ];
  }, [menu, docs, dispatch, onInspectPage, onExtractText, rotateBy]);

  const onMoveDoc = useCallback(
    (docId: string, direction: -1 | 1) => dispatch({ type: 'REORDER_DOCS', docId, direction }),
    [dispatch],
  );

  const onRemoveDoc = useCallback(
    (docId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const siblings = docs.filter((d) => d.path === doc.path);
      if (siblings.length === 1) onCloseFile(doc.path);
      else dispatch({ type: 'REMOVE_DOC', docId });
    },
    [dispatch, docs, onCloseFile],
  );

  const onRenameDoc = useCallback(
    (docId: string, name: string) => {
      const taken = new Set(docs.filter((d) => d.id !== docId).map((d) => d.name));
      dispatch({ type: 'RENAME_DOC', docId, name: uniqueDocName(name.trim(), taken) });
    },
    [dispatch, docs],
  );

  const { intoDocId, intoIndex, betweenIndex, ghostSize, betweenPages } = deriveDropGhosts(
    docs,
    drag.draggingPage,
    drag.dropTarget,
  );

  const dirty = state.pageDirtyPaths.length > 0;

  if (docs.length === 0) {
    return (
      <div className="canvas-view flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-neutral-400 mb-1">No documents open</p>
          <p className="text-sm text-neutral-500 mb-4">
            Drop PDF files anywhere, or open them to lay them out here
          </p>
          <button
            onClick={onOpenFiles}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            Open PDF
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'canvas-view flex-1 flex flex-col relative overflow-hidden' +
        (drag.committing ? ' committing' : '') +
        (drag.draggingPage ? ' dragging' : '') +
        (tool !== 'select' ? ' annotating' : '')
      }
    >
      <Canvas
        ref={canvasRef}
        contentWidth={layout.contentWidth}
        contentHeight={layout.contentHeight}
        slotHeight={layout.slotHeight}
        dragging={drag.draggingPage !== null}
        onSettle={() => setRenderVersion((v) => v + 1)}
        onBackgroundClick={() => setSelected(null)}
        overlay={
          <HeaderLayer
            items={layout.items}
            betweenIndex={betweenIndex}
            onMove={onMoveDoc}
            onRemove={onRemoveDoc}
            onRename={onRenameDoc}
          />
        }
      >
        <DocLayer
          items={layout.items}
          proxies={proxies}
          renderVersion={renderVersion}
          selected={selected}
          collapsedId={drag.collapsedId}
          draggingPage={drag.draggingPage}
          intoDocId={intoDocId}
          intoIndex={intoIndex}
          intoGhostWidth={ghostSize.width}
          intoGhostHeight={ghostSize.height}
          betweenIndex={betweenIndex}
          onSelectPage={onSelectPage}
          onOpenPage={onOpenPage}
          tool={tool}
          annotationColor={toolColor ?? undefined}
          stampPreset={stampPreset}
          onPageContextMenu={onPageContextMenu}
          onPagePointerDown={drag.onPagePointerDown}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
        />
        {drag.dropTarget?.kind === 'between' && (
          <div
            className="canvas-doc ghost-doc"
            style={{
              left: 0,
              top: betweenSlotY(layout, drag.dropTarget.docIndex),
              width: MIN_DOC_WIDTH,
            }}
          >
            <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
          </div>
        )}
        <div
          className="canvas-doc"
          style={{ left: 0, top: betweenSlotY(layout, layout.items.length), width: MIN_DOC_WIDTH }}
        >
          <AddDocGhost width={MIN_DOC_WIDTH} onClick={onOpenFiles} />
        </div>
      </Canvas>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {/* Floating controls: tool toggle + zoom cluster + pending page-edit commit */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 z-30">
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Select and drag pages"
            onClick={() => setTool('select')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'select' ? 'bg-neutral-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Select
          </button>
          <button
            data-testid="tool-highlight"
            title="Drag a box on a page to highlight (Esc to exit)"
            onClick={() => setTool(tool === 'highlight' ? 'select' : 'highlight')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'highlight' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Highlight
          </button>
          <button
            data-testid="tool-freetext"
            title="Drag a box on a page to add text (Esc to exit)"
            onClick={() => setTool(tool === 'freetext' ? 'select' : 'freetext')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'freetext' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Text
          </button>
          <button
            data-testid="tool-ink"
            title="Draw freehand on a page (Esc to exit)"
            onClick={() => setTool(tool === 'ink' ? 'select' : 'ink')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'ink' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Draw
          </button>
          <button
            data-testid="tool-stamp"
            title="Click a page to place a stamp (Esc to exit)"
            onClick={() => setTool(tool === 'stamp' ? 'select' : 'stamp')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'stamp' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Stamp
          </button>
        </div>
        {tool === 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Stamp preset"
          >
            {STAMP_PRESETS.map((p) => (
              <button
                key={p.label}
                data-testid={`stamp-preset-${p.label.toLowerCase()}`}
                onClick={() => setStampPreset(stampPreset?.label === p.label ? null : p)}
                title={p.label}
                className="px-2 py-0.5 text-[10px] font-bold rounded-full"
                style={{
                  color: p.color,
                  border: `1px solid ${p.color}`,
                  backgroundColor: stampPreset?.label === p.label ? `${p.color}33` : 'transparent',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <button
          data-testid="toggle-comments"
          title="Show annotation notes"
          onClick={() => setShowComments((v) => !v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${showComments ? 'bg-blue-600 text-white border-blue-600' : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Comments
        </button>
        {tool !== 'select' && tool !== 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Annotation color"
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                data-testid={`annot-color-${c.slice(1)}`}
                onClick={() => setToolColor(toolColor === c ? null : c)}
                title={c}
                className="w-4 h-4 rounded-full"
                style={{
                  backgroundColor: c,
                  outline: toolColor === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        )}
        {dirty && (
          <button
            data-testid="apply-page-edits-btn"
            onClick={onApplyChanges}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-full font-medium shadow-lg"
          >
            Apply changes
          </button>
        )}
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Zoom out"
            onClick={() => canvasRef.current?.zoomOut()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            −
          </button>
          <button
            title="Fit to view"
            onClick={() => canvasRef.current?.reset()}
            className="px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            Fit
          </button>
          <button
            title="Zoom in"
            onClick={() => canvasRef.current?.zoomIn()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            +
          </button>
        </div>
      </div>

      {showComments && (
        <CommentSidebar
          docs={docs}
          onSelectPage={onSelectPage}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onClose={() => setShowComments(false)}
        />
      )}
    </div>
  );
}
