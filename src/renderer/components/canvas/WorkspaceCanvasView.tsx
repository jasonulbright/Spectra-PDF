import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { Canvas } from './Canvas';
import { DocLayer } from './DocLayer';
import { HeaderLayer } from './HeaderLayer';
import { AddDocGhost, GhostRow } from './DropGhost';
import { deriveDropGhosts } from './ghost-size';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import type { DragSource } from '../../canvas/usePageDrag';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Route a double-clicked page to the existing PageInspector (pages view).
  onInspectPage: (path: string, pageNumber: number) => void;
  onApplyChanges: () => void;
}

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,
  onInspectPage,
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
      const page = doc?.pages.find((p) => p.id === pageId);
      if (!page) return;
      onInspectPage(page.sourceDocId, page.sourcePageIndex + 1);
    },
    [docs, onInspectPage],
  );

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
        (drag.draggingPage ? ' dragging' : '')
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
          onPagePointerDown={drag.onPagePointerDown}
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

      {/* Floating controls: zoom cluster + pending page-edit commit */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 z-30">
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
    </div>
  );
}
