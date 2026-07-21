import { memo } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BASE_PAGE_HEIGHT, DOC_SLOT } from '../../canvas/layout';
import { DocumentRow } from './DocumentRow';
import type { DocPlacement } from '../../canvas/layout';
import type { PageAnnotation } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OcrWord } from '../../ocr/types';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';

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
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  editImagesByPage: ReadonlyMap<string, EditImagePlacement[]>;
  editVectorsByPage: ReadonlyMap<string, EditVectorObject[]>;
  selectedVector: { pageId: string; index: number } | null;
  editImageTransform: EditImageTransformCtx | null;
  onCommitImageTransform: (pageId: string, index: number, matrix: number[]) => void;
  vectorTransform: EditImageTransformCtx | null;
  onCommitVectorTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** 9.C3 crop mode: armed flag + unit-space rect commit. */
  imageCropArmed: boolean;
  onCommitImageCrop: (pageId: string, index: number, rect: [number, number, number, number]) => void;
  editTextByPage: ReadonlyMap<string, EditTextListing>;
  editSelection: { kind: 'image' | 'text' | 'para'; pageId: string; index: number } | null;
  editingText: { kind: 'text' | 'para'; pageId: string; index: number } | null;
  onSelectEditImage: (pageId: string, index: number) => void;
  onSelectEditVector: (pageId: string, index: number) => void;
  onDeleteVector: () => void;
  onSelectEditText: (pageId: string, index: number) => void;
  onOpenTextEditor: (pageId: string, index: number) => void;
  onCommitTextEdit: (pageId: string, index: number, newText: string, opts?: { convert?: boolean }) => void;
  onCancelTextEdit: () => void;
  onSelectEditParagraph: (pageId: string, index: number) => void;
  onOpenParagraphEditor: (pageId: string, index: number) => void;
  onCommitParagraphEdit: (pageId: string, index: number, newText: string, opts?: ParagraphEditOpts) => void;
  onCancelParagraphEdit: () => void;
  onMergeParagraphPrev: (pageId: string, index: number) => void;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  // Form widgets keyed by pageId + pending values keyed by file path (2n.4b).
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  // Add-field placement (2n.4c).
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  // Add-text placement (9.A2).
  addTextPlacement: SignaturePlacement | null;
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
              redactionMarksByPage={props.redactionMarksByPage}
              editImagesByPage={props.editImagesByPage}
              editVectorsByPage={props.editVectorsByPage}
              selectedVector={props.selectedVector}
              editImageTransform={props.editImageTransform}
              onCommitImageTransform={props.onCommitImageTransform}
              vectorTransform={props.vectorTransform}
              onCommitVectorTransform={props.onCommitVectorTransform}
              imageCropArmed={props.imageCropArmed}
              onCommitImageCrop={props.onCommitImageCrop}
              editTextByPage={props.editTextByPage}
              editSelection={props.editSelection}
              editingText={props.editingText}
              onSelectEditImage={props.onSelectEditImage}
              onSelectEditVector={props.onSelectEditVector}
              onDeleteVector={props.onDeleteVector}
              onSelectEditText={props.onSelectEditText}
              onOpenTextEditor={props.onOpenTextEditor}
              onCommitTextEdit={props.onCommitTextEdit}
              onCancelTextEdit={props.onCancelTextEdit}
              onSelectEditParagraph={props.onSelectEditParagraph}
              onOpenParagraphEditor={props.onOpenParagraphEditor}
              onCommitParagraphEdit={props.onCommitParagraphEdit}
              onCancelParagraphEdit={props.onCancelParagraphEdit}
              onMergeParagraphPrev={props.onMergeParagraphPrev}
              signaturePlacement={props.signaturePlacement}
              findMatchPageIds={props.findMatchPageIds}
              findWordsByPage={props.findWordsByPage}
              formWidgetsByPage={props.formWidgetsByPage}
              formValuesByPath={props.formValuesByPath}
              onSetFormValue={props.onSetFormValue}
              onSignFieldRequest={props.onSignFieldRequest}
              newFieldPlacement={props.newFieldPlacement}
              onSetNewFieldRect={props.onSetNewFieldRect}
              onClearNewFieldPlacement={props.onClearNewFieldPlacement}
              addTextPlacement={props.addTextPlacement}
              onSetAddTextRect={props.onSetAddTextRect}
              onAddImageRect={props.onAddImageRect}
              onClearAddTextPlacement={props.onClearAddTextPlacement}
              onPageContextMenu={props.onPageContextMenu}
              onPagePointerDown={props.onPagePointerDown}
              onAddAnnotation={props.onAddAnnotation}
              onUpdateAnnotation={props.onUpdateAnnotation}
              onRecolorAnnotation={props.onRecolorAnnotation}
              onRemoveAnnotation={props.onRemoveAnnotation}
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
