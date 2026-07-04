import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BASE_PAGE_HEIGHT, DOC_SLOT } from '../../canvas/layout';
import { DocumentRow } from './DocumentRow';
import type { DocPlacement } from '../../canvas/layout';
import type { DragSource } from '../../canvas/usePageDrag';

interface DocLayerProps {
  items: DocPlacement[];
  proxies: Map<string, PDFDocumentProxy>;
  renderVersion: number;
  selected: DragSource | null;
  collapsedId: string | null;
  draggingPage: DragSource | null;
  intoDocId: string | null;
  intoIndex: number;
  intoGhostWidth: number;
  intoGhostHeight: number;
  betweenIndex: number;
  onSelectPage: (docId: string, pageId: string) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  annotateMode: boolean;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
  onAddAnnotation: (docId: string, pageId: string, rect: { x: number; y: number; w: number; h: number }) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
}

function DocLayerImpl(props: DocLayerProps): React.JSX.Element {
  const { items, intoDocId, intoIndex, intoGhostWidth, intoGhostHeight, betweenIndex } = props;
  return (
    <>
      {items.map((item, index) => {
        const doc = item.doc;
        const shifted = betweenIndex !== -1 && index >= betweenIndex;
        return (
          <div
            key={doc.id}
            className="canvas-doc"
            style={{
              left: item.x,
              top: item.y,
              width: item.width,
              transform: shifted ? `translateY(${DOC_SLOT}px)` : undefined,
            }}
          >
            <DocumentRow
              doc={doc}
              proxies={props.proxies}
              pageHeight={BASE_PAGE_HEIGHT}
              renderVersion={props.renderVersion}
              selectedPageId={props.selected?.docId === doc.id ? props.selected.pageId : null}
              collapseId={
                props.collapsedId && props.draggingPage?.docId === doc.id
                  ? props.collapsedId
                  : null
              }
              intoGhost={
                intoDocId === doc.id
                  ? { index: intoIndex, width: intoGhostWidth, height: intoGhostHeight }
                  : null
              }
              onSelectPage={props.onSelectPage}
              onOpenPage={props.onOpenPage}
              annotateMode={props.annotateMode}
              onPageContextMenu={props.onPageContextMenu}
              onPagePointerDown={props.onPagePointerDown}
              onAddAnnotation={props.onAddAnnotation}
              onRemoveAnnotation={props.onRemoveAnnotation}
            />
          </div>
        );
      })}
    </>
  );
}

export const DocLayer = memo(DocLayerImpl);
