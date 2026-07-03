import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument } from '../../state/types';
import { MAX_ROW_WIDTH } from '../../canvas/layout';
import { GhostPage } from './DropGhost';
import { PageCell } from './PageCell';

// Wrap cap for the flex strip. 12px = the strip-inner's horizontal padding
// (border-box), so the content width flexbox wraps at equals layout.ts's
// MAX_ROW_WIDTH exactly — wrapPages and the DOM must break rows identically.
const STRIP_MAX_WIDTH = MAX_ROW_WIDTH + 12;

interface DocumentRowProps {
  doc: OpenDocument;
  proxies: Map<string, PDFDocumentProxy>;
  pageHeight: number;
  renderVersion: number;
  selectedPageId: string | null;
  collapseId: string | null;
  intoGhost: { index: number; width: number; height: number } | null;
  onSelectPage: (docId: string, pageId: string) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
}

function DocumentRowImpl({
  doc,
  proxies,
  pageHeight,
  renderVersion,
  selectedPageId,
  collapseId,
  intoGhost,
  onSelectPage,
  onOpenPage,
  onPageContextMenu,
  onPagePointerDown,
}: DocumentRowProps): React.JSX.Element {
  const strip: React.JSX.Element[] = [];
  let visible = 0;
  const emitGhost = (): void => {
    if (intoGhost && intoGhost.index === visible) {
      strip.push(
        <GhostPage key="__into_ghost" width={intoGhost.width} height={intoGhost.height} grow />,
      );
    }
  };
  for (const page of doc.pages) {
    const collapsed = page.id === collapseId;
    if (!collapsed) emitGhost();
    strip.push(
      <PageCell
        key={page.id}
        docId={doc.id}
        page={page}
        pdf={proxies.get(page.sourceDocId) ?? null}
        pageHeight={pageHeight}
        renderVersion={renderVersion}
        selected={page.id === selectedPageId}
        collapsed={collapsed}
        visibleNumber={visible + 1}
        onSelectPage={onSelectPage}
        onOpenPage={onOpenPage}
        onPageContextMenu={onPageContextMenu}
        onPagePointerDown={onPagePointerDown}
      />,
    );
    if (!collapsed) visible++;
  }
  emitGhost();

  return (
    <section className="doc-row">
      <div className="page-strip">
        <div className="page-strip-inner" style={{ maxWidth: STRIP_MAX_WIDTH }}>
          {strip}
        </div>
      </div>
    </section>
  );
}

export const DocumentRow = memo(DocumentRowImpl);
