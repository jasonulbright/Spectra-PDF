import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageRef } from '../../state/types';
import { pageDisplayWidth } from '../../canvas/layout';
import { PageView } from './PageView';

interface PageCellProps {
  docId: string;
  page: PageRef;
  pdf: PDFDocumentProxy | null;
  pageHeight: number;
  renderVersion: number;
  selected: boolean;
  collapsed: boolean;
  visibleNumber: number;
  onSelectPage: (docId: string, pageId: string) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
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
  onSelectPage,
  onOpenPage,
  onPagePointerDown,
}: PageCellProps): React.JSX.Element {
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
              width: pageDisplayWidth(page.width, page.height),
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
      onPointerDown={(e) => onPagePointerDown(docId, page.id, e)}
    >
      <PageView
        pdf={pdf}
        pageNumber={page.sourcePageIndex + 1}
        naturalWidth={page.width}
        naturalHeight={page.height}
        version={renderVersion}
      />
      <span className="page-number">{visibleNumber}</span>
    </div>
  );
}

export const PageCell = memo(PageCellImpl);
