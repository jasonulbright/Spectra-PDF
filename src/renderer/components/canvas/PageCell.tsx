import { memo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageRef } from '../../state/types';
import { displayWidthOf } from '../../canvas/layout';
import { PageView } from './PageView';

export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PageCellProps {
  docId: string;
  page: PageRef;
  pdf: PDFDocumentProxy | null;
  pageHeight: number;
  renderVersion: number;
  selected: boolean;
  collapsed: boolean;
  visibleNumber: number;
  annotateMode: boolean;
  onSelectPage: (docId: string, pageId: string) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
  onAddAnnotation: (docId: string, pageId: string, rect: AnnotationRect) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
}

function PageCellImpl({
  docId,
  page,
  pdf,
  pageHeight,
  renderVersion,
  selected,
  collapsed,
  visibleNumber,
  annotateMode,
  onSelectPage,
  onOpenPage,
  onPageContextMenu,
  onPagePointerDown,
  onAddAnnotation,
  onRemoveAnnotation,
}: PageCellProps): React.JSX.Element {
  const displayWidth = displayWidthOf(page);
  // Rubber band for the highlight tool, in display-normalized coords.
  const [band, setBand] = useState<AnnotationRect | null>(null);
  const bandStart = useRef<{ x: number; y: number } | null>(null);

  const normPoint = (e: React.PointerEvent<HTMLElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!annotateMode) {
      onPagePointerDown(docId, page.id, e);
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    bandStart.current = normPoint(e);
    setBand({ ...bandStart.current, w: 0, h: 0 });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    if (!annotateMode || !bandStart.current) return;
    const p = normPoint(e);
    const s = bandStart.current;
    setBand({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };

  const handlePointerUp = (): void => {
    if (!annotateMode || !bandStart.current) return;
    const done = band;
    bandStart.current = null;
    setBand(null);
    if (done && done.w > 0.01 && done.h > 0.01) onAddAnnotation(docId, page.id, done);
  };

  return (
    <div
      data-page-id={page.id}
      className={'page' + (selected ? ' selected' : '') + (collapsed ? ' collapsing' : '')}
      style={
        collapsed
          ? {
              width: 0,
              height: pageHeight,
              position: 'absolute',
              opacity: 0,
              pointerEvents: 'none',
            }
          : {
              width: displayWidth,
              height: pageHeight,
            }
      }
      onClick={(e) => {
        e.stopPropagation();
        onSelectPage(docId, page.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenPage(docId, page.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPageContextMenu(docId, page.id, e);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <PageView
        pdf={pdf}
        pageNumber={page.sourcePageIndex + 1}
        naturalWidth={page.width}
        naturalHeight={page.height}
        version={renderVersion}
        rotation={page.rotation}
        displayWidth={displayWidth}
        displayHeight={pageHeight}
      />
      {(page.annotations ?? []).map((a) => (
        <div
          key={a.id}
          className="page-annot"
          title={a.note}
          style={{
            left: `${a.x * 100}%`,
            top: `${a.y * 100}%`,
            width: `${a.w * 100}%`,
            height: `${a.h * 100}%`,
            backgroundColor: `${a.color}66`,
            borderColor: a.color,
          }}
        >
          {!annotateMode && (
            <button
              className="page-annot-x"
              title="Remove highlight"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveAnnotation(docId, page.id, a.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {band && (
        <div
          className="page-annot page-annot-band"
          style={{
            left: `${band.x * 100}%`,
            top: `${band.y * 100}%`,
            width: `${band.w * 100}%`,
            height: `${band.h * 100}%`,
          }}
        />
      )}
      <span className="page-number">{visibleNumber}</span>
    </div>
  );
}

export const PageCell = memo(PageCellImpl);
