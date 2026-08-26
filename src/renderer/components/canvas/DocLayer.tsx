import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BASE_PAGE_HEIGHT, DOC_SLOT } from '../../canvas/layout';
import { DocumentRow } from './DocumentRow';
import type { DocPlacement } from '../../canvas/layout';
import type { PageAnnotation } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { FieldCandidate } from '../../lib/form-candidates';
import type { TableRegion, TableReviewHandlers } from '../../lib/table-review';
import type { A11yFinding, A11yFindingHandlers } from '../../lib/a11y-findings';
import type { AnnotationTransform } from '../../lib/annotation-manipulation';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { LinkRegion } from '../../lib/links';
import type { SnapshotPlacement } from '../../lib/snapshot-capture';
import type { OcrWord } from '../../ocr/types';
import type { PageReadAloud } from '../../lib/read-aloud';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue, FormValuePhase } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { ShapeType } from '../../state/types';
import type { MeasureScale } from '../../lib/measure';

interface DocLayerProps {
  items: DocPlacement[];
  proxies: Map<string, PDFDocumentProxy>;
  renderVersion: number;
  selectedPageIds: ReadonlySet<string>;
  collapsedIds: ReadonlySet<string> | null;
  intoDocId: string | null;
  intoIndex: number;
  intoGhostWidth: number;
  intoGhostHeight: number;
  betweenIndex: number;
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
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  fieldCandidatesByPage: ReadonlyMap<string, FieldCandidate[]>;
  tableRegionsByPage: ReadonlyMap<string, TableRegion[]>;
  tableReview?: TableReviewHandlers;
  a11yFindingsByPage: ReadonlyMap<string, A11yFinding[]>;
  a11yFindings?: A11yFindingHandlers;
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
  onSetFormValue: (
    path: string,
    fieldName: string,
    value: FormFieldValue,
    phase?: FormValuePhase,
    previous?: string,
  ) => void;
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
  /** A link band; the rect reaches the Links panel, which owns Create.
   * REQUIRED for the crop band's reason — an optional callback silently
   * unwires a tool in whichever render path forgets to pass it. */
  onSetLinkRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** The file's existing links, projected onto the canvas, and the pick that
   * opens one in the panel. Shown while the Links tool is open only. */
  linkRegions: readonly LinkRegion[];
  onPickLink: (region: LinkRegion) => void;
  selectedLink: { page: number; index: number } | null;
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
              selectedPageIds={props.selectedPageIds}
              collapsedIds={props.collapsedIds}
              intoGhost={
                intoDocId === doc.id
                  ? { index: intoIndex, width: intoGhostWidth, height: intoGhostHeight }
                  : null
              }
              onSelectPage={props.onSelectPage}
              onOpenPage={props.onOpenPage}
              tool={props.tool}
              annotationColor={props.annotationColor}
              stampPreset={props.stampPreset}
              shapeType={props.shapeType}
              measureScale={props.measureScale}
              measureLeaveMarkup={props.measureLeaveMarkup}
              onMeasureResult={props.onMeasureResult}
              redactionMarksByPage={props.redactionMarksByPage}
              fieldCandidatesByPage={props.fieldCandidatesByPage}
              tableRegionsByPage={props.tableRegionsByPage}
              tableReview={props.tableReview}
              a11yFindingsByPage={props.a11yFindingsByPage}
              a11yFindings={props.a11yFindings}
              selectedCandidateId={props.selectedCandidateId}
              onSelectCandidate={props.onSelectCandidate}
              onRemoveCandidate={props.onRemoveCandidate}
              onMoveCandidate={props.onMoveCandidate}
              editImagesByPage={props.editImagesByPage}
              editVectorsByPage={props.editVectorsByPage}
              snapGeomByPage={props.snapGeomByPage}
              snapSettings={props.snapSettings}
              selectedVector={props.selectedVector}
              editImageTransform={props.editImageTransform}
              onCommitImageTransform={props.onCommitImageTransform}
              editImageGroup={props.editImageGroup}
              onCommitImageGroupTransform={props.onCommitImageGroupTransform}
              vectorTransform={props.vectorTransform}
              onCommitVectorTransform={props.onCommitVectorTransform}
              imageCropArmed={props.imageCropArmed}
              onCommitImageCrop={props.onCommitImageCrop}
              onCommitImageMask={props.onCommitImageMask}
              editTextByPage={props.editTextByPage}
              editSelection={props.editSelection}
              editingText={props.editingText}
              onSelectEditImage={props.onSelectEditImage}
              onSelectEditVector={props.onSelectEditVector}
              onDeleteVector={props.onDeleteVector}
              onRestyleVector={props.onRestyleVector}
              onSelectEditText={props.onSelectEditText}
              onOpenTextEditor={props.onOpenTextEditor}
              onCommitTextEdit={props.onCommitTextEdit}
              onRestyleTextEdit={props.onRestyleTextEdit}
              onCancelTextEdit={props.onCancelTextEdit}
              onSelectEditParagraph={props.onSelectEditParagraph}
              onOpenParagraphEditor={props.onOpenParagraphEditor}
              onCommitParagraphEdit={props.onCommitParagraphEdit}
              onCheckSpelling={props.onCheckSpelling}
              spellLang={props.spellLang}
              onCancelParagraphEdit={props.onCancelParagraphEdit}
              onMergeParagraphPrev={props.onMergeParagraphPrev}
          onMergeParagraphNext={props.onMergeParagraphNext}
              signaturePlacement={props.signaturePlacement}
              findMatchPageIds={props.findMatchPageIds}
              findWordsByPage={props.findWordsByPage}
              readAloudByPage={props.readAloudByPage}
              formWidgetsByPage={props.formWidgetsByPage}
              formValuesByPath={props.formValuesByPath}
              onSetFormValue={props.onSetFormValue}
              onSignFieldRequest={props.onSignFieldRequest}
              onWidgetAction={props.onWidgetAction}
              newFieldPlacement={props.newFieldPlacement}
              onSetNewFieldRect={props.onSetNewFieldRect}
              onClearNewFieldPlacement={props.onClearNewFieldPlacement}
              addTextPlacement={props.addTextPlacement}
              cropPlacement={props.cropPlacement}
              onClearCropPlacement={props.onClearCropPlacement}
              onSetAddTextRect={props.onSetAddTextRect}
              onSetCropRect={props.onSetCropRect}
              onSetBeadRect={props.onSetBeadRect}
              onSetSnapshotRect={props.onSetSnapshotRect}
              onSetLinkRect={props.onSetLinkRect}
              linkRegions={props.linkRegions}
              onPickLink={props.onPickLink}
              selectedLink={props.selectedLink}
              snapshotPlacement={props.snapshotPlacement}
              onClearSnapshotPlacement={props.onClearSnapshotPlacement}
              onSaveSnapshot={props.onSaveSnapshot}
              onAddImageRect={props.onAddImageRect}
              onClearAddTextPlacement={props.onClearAddTextPlacement}
              onPageContextMenu={props.onPageContextMenu}
              onPagePointerDown={props.onPagePointerDown}
              onAddAnnotation={props.onAddAnnotation}
              onUpdateAnnotation={props.onUpdateAnnotation}
              onRecolorAnnotation={props.onRecolorAnnotation}
              onRemoveAnnotation={props.onRemoveAnnotation}
              selectedAnnotationIds={props.selectedAnnotationIds}
              onSelectAnnotation={props.onSelectAnnotation}
              onTransformAnnotations={props.onTransformAnnotations}
              onCalibrate={props.onCalibrate}
              onMeasureContextMenu={props.onMeasureContextMenu}
              onMarqueeSelect={props.onMarqueeSelect}
              onRegroupCountMarks={props.onRegroupCountMarks}
              onAddRedactionMark={props.onAddRedactionMark}
              onRemoveRedactionMark={props.onRemoveRedactionMark}
              onSetSignaturePlacement={props.onSetSignaturePlacement}
              onClearSignaturePlacement={props.onClearSignaturePlacement}
              onAddPages={props.onAddPages}
            />
          </div>
        );
      })}
    </>
  );
}

export const DocLayer = memo(DocLayerImpl);
