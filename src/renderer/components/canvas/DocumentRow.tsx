import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, PageAnnotation } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { FieldCandidate } from '../../lib/form-candidates';
import type { TableRegion, TableReviewHandlers } from '../../lib/table-review';
import type { AnnotationTransform } from '../../lib/annotation-manipulation';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { SnapshotPlacement } from '../../lib/snapshot-capture';
import type { OcrWord } from '../../ocr/types';
import type { PageReadAloud } from '../../lib/read-aloud';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { ShapeType } from '../../state/types';
import type { MeasureScale } from '../../lib/measure';
import { MAX_ROW_WIDTH, ADD_GHOST_WIDTH } from '../../canvas/layout';
import { GhostPage } from './DropGhost';
import { PageCell } from './PageCell';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';

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
  shapeType: ShapeType;
  measureScale?: MeasureScale;
  measureLeaveMarkup?: boolean;
  onMeasureResult?: (text: string) => void;
  // Pending redaction marks keyed by pageId — per-page arrays are built once
  // per marks change (WorkspaceCanvasView useMemo), so PageCell memoization
  // survives unrelated re-renders.
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  fieldCandidatesByPage: ReadonlyMap<string, FieldCandidate[]>;
  tableRegionsByPage: ReadonlyMap<string, TableRegion[]>;
  tableReview?: TableReviewHandlers;
  selectedCandidateId: string | null;
  onSelectCandidate: (candidateId: string) => void;
  onRemoveCandidate: (candidateId: string) => void;
  onMoveCandidate: (
    candidateId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  editImagesByPage: ReadonlyMap<string, EditImagePlacement[]>;
  editVectorsByPage: ReadonlyMap<string, EditVectorObject[]>;
  snapGeomByPage: ReadonlyMap<string, import('../../lib/snap-geometry').PageSnapGeometry>;
  snapSettings: import('../../lib/snap-settings').SnapSettings;
  selectedVector: { pageId: string; index: number } | null;
  editImageTransform: EditImageTransformCtx | null;
  onCommitImageTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** Multi-select: the group frame context (N>1) + its one-op commit. */
  editImageGroup: import('./ImageGroupOverlay').ImageGroupCtx | null;
  onCommitImageGroupTransform: (
    pageId: string,
    targets: { index: number; matrix: number[] }[],
  ) => void;
  vectorTransform: EditImageTransformCtx | null;
  onCommitVectorTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** Crop mode: armed flag + unit-space rect commit. */
  imageCropArmed: boolean;
  onCommitImageCrop: (pageId: string, index: number, rect: [number, number, number, number]) => void;
  /** The overlay's gradient-mask dot commit. */
  onCommitImageMask: (
    pageId: string,
    index: number,
    mask: import('../../lib/edit-images').EditImageMaskParam,
  ) => void;
  editTextByPage: ReadonlyMap<string, EditTextListing>;
  editSelection:
    | { kind: 'image'; pageId: string; index: number; indexes: number[] }
    | { kind: 'text' | 'para'; pageId: string; index: number }
    | null;
  /** The ONE open inline editor — a run's (kind 'text') or a paragraph's. */
  editingText: { kind: 'text' | 'para'; pageId: string; index: number } | null;
  onSelectEditImage: (pageId: string, index: number, additive?: boolean) => void;
  onSelectEditVector: (pageId: string, index: number) => void;
  onDeleteVector: () => void;
  onRestyleVector: (
    pageId: string,
    index: number,
    opts: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => void;
  onSelectEditText: (pageId: string, index: number) => void;
  onOpenTextEditor: (pageId: string, index: number) => void;
  onCommitTextEdit: (pageId: string, index: number, newText: string, opts?: { convert?: boolean }) => void;
  onRestyleTextEdit: (pageId: string, index: number, style: { size?: number; color?: [number, number, number] }) => void;
  onCancelTextEdit: () => void;
  onSelectEditParagraph: (pageId: string, index: number) => void;
  onOpenParagraphEditor: (pageId: string, index: number) => void;
  onCommitParagraphEdit: (pageId: string, index: number, newText: string, opts?: ParagraphEditOpts) => void;
  /** Misspelled ranges for the paragraph editor's own squiggles, and the
   * BCP-47 tag the native controls mark in. REQUIRED in the prop type so a
   * second render path cannot silently ship without them: an optional
   * callback erased by `?.` is indistinguishable from a wired one. */
  onCheckSpelling: (text: string) => Promise<Array<{ start: number; end: number }>>;
  spellLang: string | undefined;
  onCancelParagraphEdit: () => void;
  onMergeParagraphPrev: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  onMergeParagraphNext: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  readAloudByPage: ReadonlyMap<string, PageReadAloud>;
  // Form widgets keyed by pageId + pending values keyed by file path.
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  onWidgetAction: (
    path: string,
    fieldName: string,
    action: import('../../lib/field-actions').WidgetAction | null,
  ) => void;
  // Add-field placement.
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  // Add-text placement.
  addTextPlacement: SignaturePlacement | null;
  /** The pending crop rectangle, drawn on the page. */
  cropPlacement: SignaturePlacement | null;
  onClearCropPlacement: () => void;
  onSetCropRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** An article bead band; the Articles panel appends it. */
  onSetBeadRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** A snapshot band; the region is captured to the clipboard. REQUIRED for
   * the crop band's reason — an optional callback silently unwires a tool
   * in whichever render path forgets to pass it. */
  onSetSnapshotRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** The captured snapshot's card, and its two actions. */
  snapshotPlacement: SnapshotPlacement | null;
  onClearSnapshotPlacement: () => void;
  onSaveSnapshot: () => void;
  onSetAddTextRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearAddTextPlacement: () => void;
  onAddImageRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  // Click-selection for the properties bar (I.6). null clears.
  selectedAnnotationIds: readonly string[];
  onSelectAnnotation: (
    docId: string,
    pageId: string,
    annotationId: string | null,
    additive: boolean,
  ) => void;
  onTransformAnnotations: (docId: string, edits: AnnotationTransform[]) => void;
  onCalibrate: (lengthPts: number) => void;
  onMeasureContextMenu: (docId: string, pageId: string, annotationId: string, x: number, y: number) => void;
  onMarqueeSelect: (docId: string, pageId: string, annotationIds: string[], additive: boolean) => void;
  onRegroupCountMarks: (docId: string, pageId: string, annotationIds: string[], group: import('../../lib/count-marks').CountGroup) => void;
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
  shapeType,
  measureScale,
  measureLeaveMarkup,
  onMeasureResult,
  redactionMarksByPage,
  fieldCandidatesByPage,
  tableRegionsByPage,
  tableReview,
  selectedCandidateId,
  onSelectCandidate,
  onRemoveCandidate,
  onMoveCandidate,
  editImagesByPage,
  editVectorsByPage,
  snapGeomByPage,
  snapSettings,
  selectedVector,
  editImageTransform,
  onCommitImageTransform,
  editImageGroup,
  onCommitImageGroupTransform,
  vectorTransform,
  onCommitVectorTransform,
  imageCropArmed,
  onCommitImageCrop,
  onCommitImageMask,
  editTextByPage,
  editSelection,
  editingText,
  onSelectEditImage,
  onSelectEditVector,
  onDeleteVector,
  onRestyleVector,
  onSelectEditText,
  onOpenTextEditor,
  onCommitTextEdit,
  onRestyleTextEdit,
  onCancelTextEdit,
  onSelectEditParagraph,
  onOpenParagraphEditor,
  onCommitParagraphEdit,
  onCheckSpelling,
  spellLang,
  onCancelParagraphEdit,
  onMergeParagraphPrev,
  onMergeParagraphNext,
  signaturePlacement,
  findMatchPageIds,
  findWordsByPage,
  readAloudByPage,
  formWidgetsByPage,
  formValuesByPath,
  onSetFormValue,
  onSignFieldRequest,
  onWidgetAction,
  newFieldPlacement,
  onSetNewFieldRect,
  onClearNewFieldPlacement,
  addTextPlacement,
  cropPlacement,
  onClearCropPlacement,
  snapshotPlacement,
  onClearSnapshotPlacement,
  onSaveSnapshot,
  onSetAddTextRect,
  onSetCropRect,
  onSetBeadRect,
  onSetSnapshotRect,
  onClearAddTextPlacement,
  onAddImageRect,
  onPageContextMenu,
  onPagePointerDown,
  onAddAnnotation,
  onUpdateAnnotation,
  onRecolorAnnotation,
  onRemoveAnnotation,
  selectedAnnotationIds,
  onSelectAnnotation,
  onTransformAnnotations,
  onCalibrate,
  onMeasureContextMenu,
  onMarqueeSelect,
  onRegroupCountMarks,
  onAddRedactionMark,
  onRemoveRedactionMark,
  onSetSignaturePlacement,
  onClearSignaturePlacement,
  onAddPages,
}: DocumentRowProps): React.JSX.Element {
  // memo() would otherwise hold the previous language's chrome after a switch.
  useTranslation();
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
        shapeType={shapeType}
        measureScale={measureScale}
        measureLeaveMarkup={measureLeaveMarkup}
        onMeasureResult={onMeasureResult}
        redactionMarks={redactionMarksByPage.get(page.id)}
        fieldCandidates={fieldCandidatesByPage.get(page.id)}
        tableRegions={tableRegionsByPage.get(page.id)}
        tableReview={tableReview}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={onSelectCandidate}
        onRemoveCandidate={onRemoveCandidate}
        onMoveCandidate={onMoveCandidate}
        editImages={editImagesByPage.get(page.id)}
        editVectors={editVectorsByPage.get(page.id)}
        snapGeometry={snapGeomByPage.get(page.id)}
        snapSettings={snapSettings}
        selectedVectorIndex={selectedVector?.pageId === page.id ? selectedVector.index : null}
        editImageTransform={editImageTransform?.pageId === page.id ? editImageTransform : null}
        onCommitImageTransform={onCommitImageTransform}
        editImageGroup={editImageGroup?.pageId === page.id ? editImageGroup : null}
        onCommitImageGroupTransform={onCommitImageGroupTransform}
        vectorTransform={vectorTransform?.pageId === page.id ? vectorTransform : null}
        onCommitVectorTransform={onCommitVectorTransform}
        imageCropArmed={imageCropArmed}
        onCommitImageCrop={onCommitImageCrop}
        onCommitImageMask={onCommitImageMask}
        editTextRuns={editTextByPage.get(page.id)?.runBoxes}
        editParagraphs={editTextByPage.get(page.id)?.paragraphs}
        editSelectedIndexes={
          editSelection?.kind === 'image' && editSelection.pageId === page.id
            ? editSelection.indexes
            : null
        }
        editTextSelectedIndex={
          editSelection?.kind === 'text' && editSelection.pageId === page.id
            ? editSelection.index
            : null
        }
        editParaSelectedIndex={
          editSelection?.kind === 'para' && editSelection.pageId === page.id
            ? editSelection.index
            : null
        }
        editingTextIndex={
          editingText?.kind === 'text' && editingText.pageId === page.id
            ? editingText.index
            : null
        }
        editingParaIndex={
          editingText?.kind === 'para' && editingText.pageId === page.id
            ? editingText.index
            : null
        }
        onSelectEditImage={onSelectEditImage}
        onSelectEditVector={onSelectEditVector}
        onDeleteVector={onDeleteVector}
        onRestyleVector={onRestyleVector}
        onSelectEditText={onSelectEditText}
        onOpenTextEditor={onOpenTextEditor}
        onCommitTextEdit={onCommitTextEdit}
        onRestyleTextEdit={onRestyleTextEdit}
        onCancelTextEdit={onCancelTextEdit}
        onSelectEditParagraph={onSelectEditParagraph}
        onOpenParagraphEditor={onOpenParagraphEditor}
        onCommitParagraphEdit={onCommitParagraphEdit}
        onCheckSpelling={onCheckSpelling}
        spellLang={spellLang}
        onCancelParagraphEdit={onCancelParagraphEdit}
        onMergeParagraphPrev={onMergeParagraphPrev}
        onMergeParagraphNext={onMergeParagraphNext}
        signaturePlacement={signaturePlacement?.pageId === page.id ? signaturePlacement : null}
        findMatch={findMatchPageIds.has(page.id)}
        findWords={findWordsByPage.get(page.id)}
        readAloud={readAloudByPage.get(page.id)}
        formWidgets={formWidgetsByPage.get(page.id)}
        formValues={formValuesByPath.get(page.sourceDocId)}
        onSetFormValue={onSetFormValue}
        onSignFieldRequest={onSignFieldRequest}
        onWidgetAction={onWidgetAction}
        newFieldPlacement={newFieldPlacement?.pageId === page.id ? newFieldPlacement : null}
        onSetNewFieldRect={onSetNewFieldRect}
        onClearNewFieldPlacement={onClearNewFieldPlacement}
        addTextPlacement={addTextPlacement?.pageId === page.id ? addTextPlacement : null}
        cropPlacement={cropPlacement?.pageId === page.id ? cropPlacement : null}
        onClearCropPlacement={onClearCropPlacement}
        onSetAddTextRect={onSetAddTextRect}
        onSetCropRect={onSetCropRect}
        onSetBeadRect={onSetBeadRect}
        onSetSnapshotRect={onSetSnapshotRect}
        snapshotPlacement={snapshotPlacement?.pageId === page.id ? snapshotPlacement : null}
        onClearSnapshotPlacement={onClearSnapshotPlacement}
        onSaveSnapshot={onSaveSnapshot}
        onAddImageRect={onAddImageRect}
        onClearAddTextPlacement={onClearAddTextPlacement}
        onPageContextMenu={onPageContextMenu}
        onPagePointerDown={onPagePointerDown}
        onAddAnnotation={onAddAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
        onRecolorAnnotation={onRecolorAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
        selectedAnnotationIds={selectedAnnotationIds}
        onSelectAnnotation={onSelectAnnotation}
        onTransformAnnotations={onTransformAnnotations}
        onCalibrate={onCalibrate}
        onMeasureContextMenu={onMeasureContextMenu}
        onMarqueeSelect={onMarqueeSelect}
        onRegroupCountMarks={onRegroupCountMarks}
        onAddRedactionMark={onAddRedactionMark}
        onRemoveRedactionMark={onRemoveRedactionMark}
        onSetSignaturePlacement={onSetSignaturePlacement}
        onClearSignaturePlacement={onClearSignaturePlacement}
      />,
    );
    if (!collapsed) visible++;
  }
  emitGhost();
  // Add-page ghost: imports a picked file's pages at the end of this doc.
  strip.push(
    <button
      key="__add_page"
      className="page-add-ghost"
      data-testid={`add-page-${doc.id}`}
      title={tChrome('canvas.doc.addPages')}
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
