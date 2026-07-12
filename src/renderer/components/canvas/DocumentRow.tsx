import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, PageAnnotation } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OcrWord } from '../../ocr/types';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import { MAX_ROW_WIDTH, ADD_GHOST_WIDTH } from '../../canvas/layout';
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
  selectedPageIds: ReadonlySet<string>;
  collapsedIds: ReadonlySet<string> | null;
  intoGhost: { index: number; width: number; height: number } | null;
  onSelectPage: (docId: string, pageId: string, e?: React.MouseEvent) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  tool: CanvasTool;
  annotationColor?: string;
  stampPreset?: StampPreset | null;
  // Pending redaction marks keyed by pageId — per-page arrays are built once
  // per marks change (WorkspaceCanvasView useMemo), so PageCell memoization
  // survives unrelated re-renders.
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  // Form widgets keyed by pageId + pending values keyed by file path (2n.4b).
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  // Add-field placement (2n.4c).
  formsAddMode: boolean;
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  onAddRedactionMark: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onRemoveRedactionMark: (markId: string) => void;
  onSetSignaturePlacement: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearSignaturePlacement: () => void;
  onAddPages: (docId: string, toIndex: number) => void;
}

function DocumentRowImpl({
  doc,
  proxies,
  pageHeight,
  renderVersion,
  selectedPageIds,
  collapsedIds,
  intoGhost,
  onSelectPage,
  onOpenPage,
  tool,
  annotationColor,
  stampPreset,
  redactionMarksByPage,
  signaturePlacement,
  findMatchPageIds,
  findWordsByPage,
  formWidgetsByPage,
  formValuesByPath,
  onSetFormValue,
  formsAddMode,
  newFieldPlacement,
  onSetNewFieldRect,
  onClearNewFieldPlacement,
  onPageContextMenu,
  onPagePointerDown,
  onAddAnnotation,
  onUpdateAnnotation,
  onRecolorAnnotation,
  onRemoveAnnotation,
  onAddRedactionMark,
  onRemoveRedactionMark,
  onSetSignaturePlacement,
  onClearSignaturePlacement,
  onAddPages,
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
    const collapsed = collapsedIds?.has(page.id) ?? false;
    if (!collapsed) emitGhost();
    strip.push(
      <PageCell
        key={page.id}
        docId={doc.id}
        page={page}
        pdf={proxies.get(page.sourceDocId) ?? null}
        pageHeight={pageHeight}
        renderVersion={renderVersion}
        selected={selectedPageIds.has(page.id)}
        collapsed={collapsed}
        visibleNumber={visible + 1}
        onSelectPage={onSelectPage}
        onOpenPage={onOpenPage}
        tool={tool}
        annotationColor={annotationColor}
        stampPreset={stampPreset}
        redactionMarks={redactionMarksByPage.get(page.id)}
        signaturePlacement={signaturePlacement?.pageId === page.id ? signaturePlacement : null}
        findMatch={findMatchPageIds.has(page.id)}
        findWords={findWordsByPage.get(page.id)}
        formWidgets={formWidgetsByPage.get(page.id)}
        formValues={formValuesByPath.get(page.sourceDocId)}
        onSetFormValue={onSetFormValue}
        formsAddMode={formsAddMode}
        newFieldPlacement={newFieldPlacement?.pageId === page.id ? newFieldPlacement : null}
        onSetNewFieldRect={onSetNewFieldRect}
        onClearNewFieldPlacement={onClearNewFieldPlacement}
        onPageContextMenu={onPageContextMenu}
        onPagePointerDown={onPagePointerDown}
        onAddAnnotation={onAddAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
        onRecolorAnnotation={onRecolorAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
        onAddRedactionMark={onAddRedactionMark}
        onRemoveRedactionMark={onRemoveRedactionMark}
        onSetSignaturePlacement={onSetSignaturePlacement}
        onClearSignaturePlacement={onClearSignaturePlacement}
      />,
    );
    if (!collapsed) visible++;
  }
  emitGhost();
  // Add-page ghost (2n.3): imports a picked file's pages at the end of this doc.
  strip.push(
    <button
      key="__add_page"
      className="page-add-ghost"
      data-testid={`add-page-${doc.id}`}
      title="Add pages from a file"
      onClick={(e) => {
        e.stopPropagation();
        onAddPages(doc.id, doc.pages.length);
      }}
      style={{ width: ADD_GHOST_WIDTH, height: pageHeight }}
    >
      +
    </button>,
  );

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
