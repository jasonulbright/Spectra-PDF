import { memo, useEffect, useRef, useState } from 'react';
import { showsFormWidgets } from '../../commands/tools';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageAnnotation, PageRef } from '../../state/types';
import { displayWidthAt, displayWidthOf, BASE_PAGE_HEIGHT } from '../../canvas/layout';
import { projectMarkRect, rotateNormalizedPoints, rotateNormalizedRect } from '../../lib/redaction';
import type { RedactionMark } from '../../lib/redaction';
import type { OcrWord } from '../../ocr/types';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import ImageTransformOverlay from './ImageTransformOverlay';
import type { EditTextRun } from '../../lib/edit-text';
import { unencodableChars } from '../../lib/edit-text';
import type { EditParagraph, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import {
  computeEditSpans,
  hexToRgb,
  paragraphUnencodable,
  sanitizeParagraphInput,
} from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import { PageView } from './PageView';
import { PageTextLayer } from './PageTextLayer';

// The tool union moved to the ui state slice (Phase 4 M1: commands and the
// keymap read it for enablement); re-exported here for the overlay consumers.
export type { CanvasTool } from '../../state/types';
import type { CanvasTool } from '../../state/types';

export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StampPreset {
  label: string;
  color: string;
}

export const STAMP_PRESETS: StampPreset[] = [
  { label: 'APPROVED', color: '#2fbf71' },
  { label: 'REJECTED', color: '#e0393e' },
  { label: 'DRAFT', color: '#8a8a93' },
  { label: 'CONFIDENTIAL', color: '#e0393e' },
  { label: 'REVIEWED', color: '#2f6fed' },
];

// Fixed footprint, display-normalized (0..1 of the page cell) — stamps are a
// single click-to-place, not a drag-sized box.
const STAMP_W = 0.32;
const STAMP_H = 0.09;

// Shared by the floating toolbar's "color for new annotations" picker and
// each annotation's own hover recolor row.
export const ANNOTATION_PALETTE = ['#ffd54a', '#16161a', '#2f6fed', '#e0393e', '#2fbf71', '#a855f7'];

const HIGHLIGHT_COLOR = '#ffd54a';
const FREETEXT_COLOR = '#16161a';
const INK_COLOR = '#2f6fed';
const FREETEXT_FONT_PT = 12;

function defaultColorFor(kind: PageAnnotation['kind']): string {
  if (kind === 'freetext') return FREETEXT_COLOR;
  if (kind === 'ink') return INK_COLOR;
  return HIGHLIGHT_COLOR;
}

/** Rotate View's content wrapper: children turn with the page when a style
 * is supplied (freetext/stamp text, the inline editor), pass through
 * untouched when not — so the flat path renders byte-identical JSX. */
function MaybeTurn({
  style,
  children,
}: {
  style: React.CSSProperties | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  if (!style) return <>{children}</>;
  return (
    <div className="page-annot-turn" style={style}>
      {children}
    </div>
  );
}

// One form widget on the page (2n.4b). Interactive only in forms mode; in
// any other tool a widget with a pending value renders as an inert badge so
// pending state is never invisible (the redaction-mark precedent). Every
// pointer event stops here — typing into an input must never select, drag,
// or context-menu the page underneath.
function FormWidgetView({
  widget,
  rotation,
  formsMode,
  pending,
  fontPx,
  onSetFormValue,
  onSignFieldRequest,
}: {
  widget: OverlayWidget;
  rotation: 0 | 90 | 180 | 270;
  formsMode: boolean;
  pending: FormFieldValue | undefined;
  fontPx: number;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
}): React.JSX.Element | null {
  const hasPending = pending !== undefined;
  if (!formsMode && !hasPending) return null;
  // Widget rects are display-normalized at the BAKED orientation; an
  // in-memory rotation just re-projects them (the findWords recipe).
  const r = rotateNormalizedRect(widget.rect, rotation);
  const style: React.CSSProperties = {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  };
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  if (!formsMode) {
    return (
      <div
        className="page-form-widget page-form-pending"
        style={style}
        title={`${widget.fieldName} — filled, not yet applied`}
      />
    );
  }
  const set = (v: FormFieldValue): void => onSetFormValue(widget.path, widget.fieldName, v);
  const effective = pending ?? widget.value;
  const common = {
    'data-testid': `form-widget-${widget.fieldName}`,
    onPointerDown: stop,
    onClick: stop,
    onDoubleClick: stop,
    onContextMenu: stop,
  } as const;
  if (widget.type === 'signature') {
    // An EMPTY, non-read-only signature field is clickable (2n.4d): the
    // click opens the sign card targeting THIS field by name — the engine
    // fills it in place (the field's own widget rect is the stamp box).
    const signable = !widget.sigFilled && !widget.readOnly;
    if (signable) {
      return (
        <button
          {...common}
          type="button"
          className="page-form-widget page-form-sig signable"
          style={style}
          title={`${widget.fieldName} — click to sign this field`}
          onClick={(e) => {
            stop(e);
            onSignFieldRequest(widget.path, widget.fieldName);
          }}
        >
          <span>SIGN HERE</span>
        </button>
      );
    }
    return (
      <div
        {...common}
        className={'page-form-widget page-form-sig' + (widget.sigFilled ? ' signed' : '')}
        style={style}
        title={
          widget.sigFilled
            ? `${widget.fieldName} — already signed`
            : `${widget.fieldName} — read-only signature field`
        }
      >
        <span>{widget.sigFilled ? 'SIGNED' : 'SIGNATURE'}</span>
      </div>
    );
  }
  if (!widget.editable) {
    return (
      <div
        {...common}
        className="page-form-widget page-form-locked"
        style={style}
        title={`${widget.fieldName} — read-only`}
      />
    );
  }
  if (widget.type === 'text') {
    const str = typeof effective === 'string' ? effective : '';
    const cls = 'page-form-widget page-form-input' + (hasPending ? ' pending' : '');
    return widget.multiline ? (
      <textarea
        {...common}
        className={cls}
        style={{ ...style, fontSize: fontPx }}
        value={str}
        onChange={(e) => set(e.target.value)}
        spellCheck={false}
      />
    ) : (
      <input
        {...common}
        className={cls}
        style={{ ...style, fontSize: fontPx }}
        type="text"
        value={str}
        onChange={(e) => set(e.target.value)}
        spellCheck={false}
      />
    );
  }
  if (widget.type === 'checkbox') {
    return (
      <label
        {...common}
        className={'page-form-widget page-form-check' + (hasPending ? ' pending' : '')}
        style={style}
        title={widget.fieldName}
      >
        <input type="checkbox" checked={Boolean(effective)} onChange={(e) => set(e.target.checked)} />
      </label>
    );
  }
  if (widget.type === 'radio') {
    const on = widget.radioOption !== undefined && effective === widget.radioOption;
    return (
      <button
        {...common}
        type="button"
        className={
          'page-form-widget page-form-radio' + (on ? ' on' : '') + (hasPending ? ' pending' : '')
        }
        style={style}
        title={`${widget.fieldName}: ${widget.radioOption ?? '(unmapped option)'}`}
        disabled={widget.radioOption === undefined}
        onClick={(e) => {
          stop(e);
          if (widget.radioOption !== undefined) set(widget.radioOption);
        }}
      >
        <span className="page-form-radio-dot" />
      </button>
    );
  }
  const options = widget.options ?? [];
  if (widget.type === 'dropdown') {
    const sel = typeof effective === 'string' ? effective : '';
    return (
      <select
        {...common}
        className={'page-form-widget page-form-select' + (hasPending ? ' pending' : '')}
        style={{ ...style, fontSize: fontPx }}
        value={sel}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  // optionlist (multi-select)
  const selected = Array.isArray(effective) ? effective : [];
  return (
    <select
      {...common}
      multiple
      className={'page-form-widget page-form-select' + (hasPending ? ' pending' : '')}
      style={{ ...style, fontSize: fontPx }}
      value={selected}
      onChange={(e) => set(Array.from(e.target.selectedOptions, (o) => o.value))}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

interface PageCellProps {
  docId: string;
  page: PageRef;
  /** Rotate View's render-only delta (M6.1). The `page` prop arrives with it
   * ALREADY composed into `page.rotation` (the reading view builds effective
   * pages), which is what makes marks/signature/field capture — whose
   * `rotationAtDraw` seam composes generally — and every re-projecting
   * overlay correct with no further work. This prop exists for the ONE
   * overlay family without that seam: annotations, whose stored rects stay
   * in the page.rotation frame and so must be projected by the delta at
   * render and un-projected at capture. Zero on the Organize board, always. */
  viewRotation?: 0 | 90 | 180 | 270;
  pdf: PDFDocumentProxy | null;
  pageHeight: number;
  renderVersion: number;
  selected: boolean;
  collapsed: boolean;
  visibleNumber: number;
  tool: CanvasTool;
  /** Mount pdf.js's selectable text over the page (§ 6.3). Reading view only —
   * the board is an arrangement surface, where text at thumbnail size isn't
   * usefully selectable and the spans would fight the page-drag. */
  textLayer?: boolean;
  // Overrides the kind-default color for newly created annotations (color
  // picker in the floating toolbar); undefined keeps the per-kind default.
  annotationColor?: string;
  // Selected stamp preset — required for the Stamp tool to place anything;
  // clicks are ignored while none is picked.
  stampPreset?: StampPreset | null;
  // Pending redaction marks on this page (transient view state — see
  // lib/redaction.ts); undefined when none.
  redactionMarks?: RedactionMark[];
  /** Edit-mode image placements (7.1), display-normalized at baked
   * orientation — pending rotation is applied at render like marks. */
  editImages?: EditImagePlacement[];
  editSelectedIndex?: number | null;
  onSelectEditImage?: (pageId: string, index: number) => void;
  /** Transform context for THIS page's selected image (9.C1), pre-filtered by
   * pageId upstream — non-null only on the page whose image is selected. */
  editImageTransform?: EditImageTransformCtx | null;
  onCommitImageTransform?: (pageId: string, index: number, matrix: number[]) => void;
  /** Edit-mode text runs (7.2+7.3), same projection rules as images.
   * Since 7.5 these are only the runs NOT covered by an editable
   * paragraph (refused paragraphs decompose back to run boxes). */
  editTextRuns?: EditTextRun[];
  editTextSelectedIndex?: number | null;
  /** The run whose inline editor is OPEN on this page (input state is
   * local to the editor; commit/cancel report up). */
  editingTextIndex?: number | null;
  onSelectEditText?: (pageId: string, index: number) => void;
  onOpenTextEditor?: (pageId: string, index: number) => void;
  onCommitTextEdit?: (
    pageId: string,
    index: number,
    newText: string,
    opts?: { convert?: boolean },
  ) => void;
  onCancelTextEdit?: () => void;
  /** Edit-mode paragraph boxes (7.5) — the PRIMARY text surface. */
  editParagraphs?: EditParagraph[];
  editParaSelectedIndex?: number | null;
  editingParaIndex?: number | null;
  onSelectEditParagraph?: (pageId: string, index: number) => void;
  onOpenParagraphEditor?: (pageId: string, index: number) => void;
  onCommitParagraphEdit?: (
    pageId: string,
    index: number,
    newText: string,
    opts?: ParagraphEditOpts,
  ) => void;
  onCancelParagraphEdit?: () => void;
  // Pending visible-signature placement, when it sits on THIS page (transient
  // view state with mark lifecycle — see lib/signature-placement.ts).
  signaturePlacement?: SignaturePlacement | null;
  // Find (2m): this page matches the active query. OCR'd pages additionally
  // get per-word highlight boxes (display-normalized at the page's BAKED
  // orientation — projected by the current in-memory rotation like marks).
  findMatch?: boolean;
  findWords?: OcrWord[];
  // Form widgets on this page (2n.4b) — display-normalized at the BAKED
  // orientation like findWords; interactive only in the 'forms' tool, but a
  // widget with a pending value stays visible in every tool (marks
  // precedent: pending state must never be invisible).
  formWidgets?: OverlayWidget[];
  // Pending values for THIS page's file, keyed by field name.
  formValues?: ReadonlyMap<string, FormFieldValue>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  // Clicking an empty signature widget in forms mode targets it for signing
  // (2n.4d — the sign card opens in fill-this-field mode).
  onSignFieldRequest: (path: string, fieldName: string) => void;
  // band instead of being inert on empty page area.
  // Pending new-field placement, when it sits on THIS page (transient view
  // state with the signature-placement lifecycle).
  newFieldPlacement?: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  // Pending Add-Text placement (9.A2), same lifecycle as newFieldPlacement:
  // single, transient view state, dies on buffer-identity change.
  addTextPlacement?: SignaturePlacement | null;
  onSetAddTextRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearAddTextPlacement: () => void;
  // Add-Image band release (9.C2): converts + hands off to App's picker+embed.
  onAddImageRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onSelectPage: (docId: string, pageId: string, e?: React.MouseEvent) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
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
}

function PageCellImpl({
  docId,
  page,
  viewRotation = 0,
  pdf,
  pageHeight,
  renderVersion,
  selected,
  collapsed,
  visibleNumber,
  tool,
  textLayer,
  annotationColor,
  stampPreset,
  redactionMarks,
  editImages,
  editSelectedIndex,
  editImageTransform,
  onCommitImageTransform,
  onSelectEditImage,
  editTextRuns,
  editTextSelectedIndex,
  editingTextIndex,
  onSelectEditText,
  onOpenTextEditor,
  onCommitTextEdit,
  onCancelTextEdit,
  editParagraphs,
  editParaSelectedIndex,
  editingParaIndex,
  onSelectEditParagraph,
  onOpenParagraphEditor,
  onCommitParagraphEdit,
  onCancelParagraphEdit,
  signaturePlacement,
  findMatch,
  findWords,
  formWidgets,
  formValues,
  onSetFormValue,
  onSignFieldRequest,
  newFieldPlacement,
  onSetNewFieldRect,
  addTextPlacement,
  onSetAddTextRect,
  onClearAddTextPlacement,
  onAddImageRect,
  onClearNewFieldPlacement,
  onSelectPage,
  onOpenPage,
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
}: PageCellProps): React.JSX.Element {
  // The cell's width. Two formulas, deliberately:
  //  - The BOARD keeps `displayWidthOf`'s width-at-BASE_PAGE_HEIGHT, scaled by
  //    pageHeight (a factor of 1 there). Its integer-at-280 rounding is what the
  //    board's own packing math (`computeLayout`) measures with, so the two must
  //    not diverge.
  //  - The READING view takes the page's EXACT aspect. It scales the cell far
  //    past thumbnail size, and scaling an already-rounded width amplifies that
  //    rounding linearly with zoom — which the text layer (whose geometry comes
  //    from the page's real points, via pdf.js) then disagrees with, drifting
  //    selection off the glyphs (review-caught, measured: ~20px at 16x). The
  //    reading view is exactly where a page must be a page, to the pixel.
  // `textLayer` marks the reading view; raster, overlays and font all key off
  // pageHeight/displayWidth, so the whole cell stays consistent either way.
  const displayWidth = textLayer
    ? displayWidthAt(page, pageHeight)
    : displayWidthOf(page) * (pageHeight / BASE_PAGE_HEIGHT);
  // Hand is the OTHER non-annotating mode (M6.2): it must take the same
  // let-the-board-have-it branch as select, or a hand drag on the board
  // preventDefaults the pointerdown (suppressing the derived mouse events d3
  // pans with) and falls through to the band — painting a HIGHLIGHT instead
  // of panning (review-caught, CRITICAL).
  const annotateMode = tool !== 'select' && tool !== 'hand';
  // Rubber band for the annotation tools, in display-normalized coords.
  // Driven by window-level native listeners for the drag's duration — the
  // same pattern as usePageDrag — rather than React synthetic move/up through
  // pointer capture, which proved unreliable in the WebView.
  const [band, setBand] = useState<AnnotationRect | null>(null);
  const bandActive = useRef(false);
  // Cancels the in-flight band/stroke (removes window listeners, commits nothing).
  const cancelBand = useRef<(() => void) | null>(null);
  // Freetext annotation currently being edited inline.
  const [editing, setEditing] = useState<string | null>(null);
  // In-progress ink stroke, flat [x0,y0,x1,y1,...] display-normalized points.
  const [inkPoints, setInkPoints] = useState<number[] | null>(null);

  // Display px of the page's own point size — scales freetext to the cell.
  const freetextFontPx =
    (FREETEXT_FONT_PT / (page.rotation === 90 || page.rotation === 270 ? page.width : page.height)) *
      pageHeight || FREETEXT_FONT_PT;

  // Annotations store geometry in the page.rotation frame; the pointer works
  // in the DISPLAYED (view-rotated) frame. These translate at the edges —
  // capture un-projects (here), render projects (displayAnnot below) — so the
  // stored frame, the reducer's eager re-projection on REAL rotations, and
  // the builder's inversion all stay untouched by Rotate View (M6.1).
  const inverseView = (360 - viewRotation) % 360;
  const toStoredRect = (r: AnnotationRect): AnnotationRect =>
    viewRotation === 0 ? r : { ...r, ...rotateNormalizedRect(r, inverseView) };
  const toStoredPoints = (pts: number[]): number[] =>
    viewRotation === 0 ? pts : rotateNormalizedPoints(pts, inverseView);

  const handleInkDown = (e: React.PointerEvent<HTMLElement>): void => {
    bandActive.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const norm = (cx: number, cy: number): { x: number; y: number } => ({
      x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
    });
    const start = norm(e.clientX, e.clientY);
    let points = [start.x, start.y];
    setInkPoints(points);

    const onMove = (ev: PointerEvent): void => {
      const p = norm(ev.clientX, ev.clientY);
      points = [...points, p.x, p.y];
      setInkPoints(points);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      bandActive.current = false;
      cancelBand.current = null;
      setInkPoints(null);
      // Un-project the stroke into the stored frame FIRST, then take the
      // bbox — a bbox un-projected as a rect and one recomputed from
      // un-projected points agree, but deriving both from one source can't
      // drift.
      const stored = toStoredPoints(points);
      const xs = stored.filter((_, i) => i % 2 === 0);
      const ys = stored.filter((_, i) => i % 2 === 1);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(...xs) - minX;
      const h = Math.max(...ys) - minY;
      if (commit && (w > 0.005 || h > 0.005)) {
        onAddAnnotation(docId, page.id, {
          id: crypto.randomUUID(),
          kind: 'ink',
          x: minX,
          y: minY,
          w,
          h,
          color: annotationColor ?? INK_COLOR,
          points: stored,
        });
      }
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelBand.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!annotateMode) {
      onPagePointerDown(docId, page.id, e);
      return;
    }
    if (e.button !== 0 || bandActive.current || editing) return;
    // Fill mode has no rubber band — widgets handle their own pointer events
    // (with stopPropagation), and a press on empty page area must not start a
    // drag or a highlight band under an input. AUTHORING (formfields) is the
    // mode that bands, which is why the two are separate modes rather than one
    // mode and a boolean (2n.4c). Edit (7.1) is click-to-select the same way
    // — without this, a drag on empty page area fell through to the generic
    // band and silently created a HIGHLIGHT annotation (review-caught, the
    // same class as the 'hand' fix above).
    if (tool === 'forms' || tool === 'edit') return;
    e.preventDefault();
    e.stopPropagation();
    if (tool === 'ink') {
      handleInkDown(e);
      return;
    }
    if (tool === 'stamp') {
      if (!stampPreset) return; // no preset picked yet — clicks are a no-op
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const cy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      // Built in the DISPLAY frame (the stamp reads upright on the view you
      // placed it on), then stored un-projected like every annotation.
      const placed = toStoredRect({
        x: Math.max(0, Math.min(1 - STAMP_W, cx - STAMP_W / 2)),
        y: Math.max(0, Math.min(1 - STAMP_H, cy - STAMP_H / 2)),
        w: STAMP_W,
        h: STAMP_H,
      });
      onAddAnnotation(docId, page.id, {
        id: crypto.randomUUID(),
        kind: 'stamp',
        ...placed,
        color: annotationColor ?? stampPreset.color,
        note: stampPreset.label,
      });
      return;
    }
    bandActive.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const norm = (cx: number, cy: number): { x: number; y: number } => ({
      x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
    });
    const start = norm(e.clientX, e.clientY);
    // 'redact' shares the band mechanics but commits a transient mark, not a
    // PageAnnotation. `tool` is stable for the drag's duration — a mid-drag
    // tool switch cancels via the annotateMode effect below.
    const kind = tool === 'freetext' ? 'freetext' : 'highlight';
    let latest: AnnotationRect = { ...start, w: 0, h: 0 };
    setBand(latest);

    const onMove = (ev: PointerEvent): void => {
      const p = norm(ev.clientX, ev.clientY);
      latest = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      setBand(latest);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      bandActive.current = false;
      cancelBand.current = null;
      setBand(null);
      if (commit && latest.w > 0.01 && latest.h > 0.01) {
        if (tool === 'redact') {
          onAddRedactionMark(docId, page.id, latest, page.rotation);
        } else if (tool === 'signature') {
          // Single pending placement — drawing again (anywhere) replaces it.
          onSetSignaturePlacement(docId, page.id, latest, page.rotation);
        } else if (tool === 'formfields') {
          // Add-field placement (2n.4c) — single, drawing again replaces it.
          onSetNewFieldRect(docId, page.id, latest, page.rotation);
        } else if (tool === 'addtext') {
          // Add-text placement (9.A2) — single, drawing again replaces it.
          onSetAddTextRect(docId, page.id, latest, page.rotation);
        } else if (tool === 'addimage') {
          // Add-image (9.C2) — the box; App picks the file + embeds.
          onAddImageRect(docId, page.id, latest, page.rotation);
        } else {
          const annotation: PageAnnotation = {
            id: crypto.randomUUID(),
            kind,
            ...toStoredRect(latest),
            color: annotationColor ?? defaultColorFor(kind),
          };
          onAddAnnotation(docId, page.id, annotation);
          if (kind === 'freetext') setEditing(annotation.id);
        }
      }
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelBand.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  // Leaving annotate mode (Escape, tool toggle) mid-drag cancels the band —
  // the still-attached pointerup would otherwise commit a box the user
  // believes they abandoned.
  useEffect(() => {
    if (!annotateMode) cancelBand.current?.();
  }, [annotateMode]);

  // Cancel any in-flight band/stroke if the cell unmounts mid-gesture. The
  // band's pointermove/up listeners live on `window`, not this node, so under
  // the Document view's virtualization a big scroll (wheel/Page Down) with the
  // button still held can unmount the dragged page while its listeners keep
  // running — the trailing pointerup would then commit a rect for a cell that's
  // gone. Harmless on the always-mounted board (review-caught).
  useEffect(() => () => cancelBand.current?.(), []);

  const finishEditing = (annotation: PageAnnotation, value: string): void => {
    setEditing(null);
    const note = value.trim();
    if (!note) onRemoveAnnotation(docId, page.id, annotation.id);
    else if (note !== annotation.note) onUpdateAnnotation(docId, page.id, annotation.id, note);
  };

  return (
    <div
      data-page-id={page.id}
      className={
        'page' +
        (selected ? ' selected' : '') +
        (collapsed ? ' collapsing' : '') +
        (findMatch ? ' find-match' : '')
      }
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
        onSelectPage(docId, page.id, e);
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
      {textLayer && (
        <PageTextLayer
          pdf={pdf}
          pageNumber={page.sourcePageIndex + 1}
          rotation={page.rotation}
          displayWidth={displayWidth}
          displayHeight={pageHeight}
          active={tool === 'select'}
        />
      )}
      {(page.annotations ?? []).map((a) => {
        // pdf.js's base raster (PageView) already draws every real annotation
        // in the CURRENTLY LOADED file with AnnotationMode.ENABLE — including
        // ones we've imported but haven't touched. Painting our own visible
        // body on top of an untouched import would double it up. Only once
        // color/note diverges from the importedOriginal snapshot is the file
        // on disk stale relative to the edit, and the overlay must take over
        // (same as any brand-new, uncommitted annotation always does).
        const pristineImport =
          !!a.importedOriginal &&
          a.importedOriginal.hasAppearance && // else pdf.js draws nothing to avoid duplicating
          a.color === a.importedOriginal.color &&
          (a.note ?? '') === (a.importedOriginal.contents ?? '');
        // Rotate View (M6.1): stored geometry lives in the page.rotation
        // frame; the cell displays the view-rotated frame. Project here —
        // the capture path un-projects, so the pair is identity when flat.
        const da =
          viewRotation === 0
            ? a
            : {
                ...a,
                ...rotateNormalizedRect(a, viewRotation),
                points: a.points ? rotateNormalizedPoints(a.points, viewRotation) : a.points,
              };
        // Text bodies (freetext/stamp + the inline editor) turn WITH the page
        // — a counter-sized wrapper rotated about its center, the PageView
        // canvas technique. Hover chrome stays screen-upright outside it.
        const turnsWithPage =
          viewRotation !== 0 && (a.kind === 'freetext' || a.kind === 'stamp');
        const swapTurn = viewRotation === 90 || viewRotation === 270;
        const turnStyle: React.CSSProperties | undefined = turnsWithPage
          ? {
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: swapTurn ? da.h * pageHeight : da.w * displayWidth,
              height: swapTurn ? da.w * displayWidth : da.h * pageHeight,
              transform: `translate(-50%,-50%) rotate(${viewRotation}deg)`,
            }
          : undefined;
        return (
        <div
          key={a.id}
          className={
            'page-annot' +
            (a.kind === 'freetext' ? ' page-annot-text' : '') +
            (a.kind === 'ink' ? ' page-annot-ink' : '') +
            (a.kind === 'stamp' ? ' page-annot-stamp' : '')
          }
          title={a.kind === 'highlight' || a.kind === 'ink' ? a.note : undefined}
          style={{
            left: `${da.x * 100}%`,
            top: `${da.y * 100}%`,
            width: `${da.w * 100}%`,
            height: `${da.h * 100}%`,
            ...(pristineImport
              ? {}
              : a.kind === 'highlight'
                ? { backgroundColor: `${a.color}66`, borderColor: a.color }
                : a.kind === 'ink'
                  ? {}
                  : a.kind === 'stamp'
                    ? { backgroundColor: `${a.color}22`, borderColor: a.color, color: a.color }
                    : { borderColor: a.color, color: a.color, fontSize: freetextFontPx }),
            ...(a.kind === 'freetext' && tool === 'select' ? { pointerEvents: 'auto' } : {}),
          }}
          onPointerDown={a.kind === 'freetext' ? (e) => e.stopPropagation() : undefined}
          onDoubleClick={
            a.kind === 'freetext'
              ? (e) => {
                  e.stopPropagation();
                  setEditing(a.id);
                }
              : undefined
          }
        >
          {a.kind === 'ink' && !pristineImport && (
            <svg className="page-annot-ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
              <polyline
                points={(da.points ?? [])
                  .map((v, i) =>
                    i % 2 === 0 ? (da.w > 0 ? (v - da.x) / da.w : 0.5) : (da.h > 0 ? (v - da.y) / da.h : 0.5),
                  )
                  .reduce<string[]>((acc, v, i) => {
                    if (i % 2 === 0) acc.push(`${v}`);
                    else acc[acc.length - 1] += `,${v}`;
                    return acc;
                  }, [])
                  .join(' ')}
                fill="none"
                stroke={a.color}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          <MaybeTurn style={turnStyle}>
            {a.kind === 'freetext' && editing !== a.id && !pristineImport && (
              <span className="page-annot-text-body">{a.note}</span>
            )}
            {a.kind === 'stamp' && !pristineImport && (
              <span className="page-annot-stamp-label">{a.note}</span>
            )}
          </MaybeTurn>
          {editing === a.id ? (
            // The inline editor turns with the page too (same wrapper) — the
            // text you type reads the way it will render.
            <MaybeTurn style={turnStyle}>
              <textarea
                className="page-annot-editor"
                style={{ fontSize: freetextFontPx, color: a.color }}
                autoFocus
                defaultValue={a.note ?? ''}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={(e) => finishEditing(a, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    finishEditing(a, a.note ?? ''); // revert (removes if never had text)
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    finishEditing(a, e.currentTarget.value);
                  }
                }}
              />
            </MaybeTurn>
          ) : (
            !annotateMode && (
              <>
                <div className="page-annot-recolor" onPointerDown={(e) => e.stopPropagation()}>
                  {ANNOTATION_PALETTE.map((c) => (
                    <button
                      key={c}
                      className="page-annot-recolor-dot"
                      title={`Recolor to ${c}`}
                      style={{ backgroundColor: c }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRecolorAnnotation(docId, page.id, a.id, c);
                      }}
                    />
                  ))}
                </div>
                <button
                  className="page-annot-x"
                  title={
                    a.kind === 'freetext'
                      ? 'Remove text'
                      : a.kind === 'ink'
                        ? 'Remove drawing'
                        : a.kind === 'stamp'
                          ? 'Remove stamp'
                          : 'Remove highlight'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAnnotation(docId, page.id, a.id);
                  }}
                >
                  ×
                </button>
              </>
            )
          )}
        </div>
        );
      })}
      {(redactionMarks ?? []).map((m) => {
        // Marks store the rect as drawn; a page rotated in memory since then
        // just changes the projection (user space is unmoved by /Rotate).
        const r = projectMarkRect(m, page.rotation);
        return (
          <div
            key={m.id}
            className="page-redact"
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          >
            <span className="page-redact-label">REDACT</span>
            {(tool === 'select' || tool === 'redact') && (
              <button
                className="page-annot-x"
                title="Remove redaction mark"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveRedactionMark(m.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {tool === 'edit' &&
        (editParagraphs ?? []).map((para) => {
          const r = rotateNormalizedRect(para.rect, page.rotation);
          const selected = editParaSelectedIndex === para.index;
          if (editingParaIndex === para.index) {
            // Line thickness along the flow normal, rotation-proof: at a
            // quarter-turn the box's w/h swap (the 7.2 sizing rule, per
            // line here).
            const extent = page.rotation % 180 === 0 ? r.h : r.w;
            return (
              <ParagraphEditor
                key={`ep-${para.index}`}
                para={para}
                rect={r}
                lineHeightPx={(extent * pageHeight) / Math.max(para.lineCount, 1)}
                onCommit={(value, opts) =>
                  onCommitParagraphEdit?.(page.id, para.index, value, opts)
                }
                onCancel={() => onCancelParagraphEdit?.()}
              />
            );
          }
          return (
            <button
              key={`ep-${para.index}`}
              type="button"
              data-testid={`edit-para-${para.index}`}
              className={'page-editpara' + (selected ? ' selected' : '')}
              title="Paragraph — double-click to edit"
              aria-pressed={selected}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEditParagraph?.(page.id, para.index);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenParagraphEditor?.(page.id, para.index);
              }}
            />
          );
        })}
      {tool === 'edit' &&
        (editTextRuns ?? []).map((run) => {
          const r = rotateNormalizedRect(run.rect, page.rotation);
          const selected = editTextSelectedIndex === run.index;
          if (editingTextIndex === run.index) {
            return (
              <TextRunEditor
                key={`et-${run.index}`}
                run={run}
                rect={r}
                // The line's THICKNESS, rotation-proof: a 90°-turned page
                // swaps w/h, and sizing off the swapped h produced a ~300px
                // font (review-caught). min(w,h) is the line thickness
                // under any quarter-turn; the editor renders horizontal
                // (not counter-rotated) at a readable size — the v1 call.
                heightPx={Math.min(r.h, r.w) * pageHeight}
                onCommit={(value, opts) => onCommitTextEdit?.(page.id, run.index, value, opts)}
                onCancel={() => onCancelTextEdit?.()}
              />
            );
          }
          return (
            <button
              key={`et-${run.index}`}
              type="button"
              data-testid={`edit-text-${run.index}`}
              className={
                'page-edittext' +
                (selected ? ' selected' : '') +
                (run.editable ? '' : ' locked')
              }
              title={run.editable ? 'Text — double-click to edit' : run.reason ?? 'Not editable'}
              aria-pressed={selected}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEditText?.(page.id, run.index);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenTextEditor?.(page.id, run.index);
              }}
            />
          );
        })}
      {tool === 'edit' &&
        (editImages ?? []).map((img) => {
          // Placements are display-normalized at the BAKED orientation; a
          // pending in-memory rotation just changes the projection (the
          // redaction-mark rule — user space is unmoved by /Rotate).
          const r = rotateNormalizedRect(img.rect, page.rotation);
          const selected = editSelectedIndex === img.index;
          return (
            <button
              key={`ei-${img.index}`}
              type="button"
              data-testid={`edit-image-${img.index}`}
              className={'page-editimg' + (selected ? ' selected' : '')}
              title={img.nested ? 'Image (inside a form)' : 'Image'}
              aria-pressed={selected}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEditImage?.(page.id, img.index);
              }}
            />
          );
        })}
      {tool === 'edit' && editImageTransform && onCommitImageTransform && (
        <ImageTransformOverlay
          ctx={editImageTransform}
          pendingRotate={page.rotation}
          onCommit={(matrix) => onCommitImageTransform(page.id, editImageTransform.index, matrix)}
        />
      )}
      {(findWords ?? []).map((word, i) => {
        const r = rotateNormalizedRect(word, page.rotation);
        return (
          <div
            key={`fw-${i}`}
            className="page-find-word"
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          />
        );
      })}
      {(formWidgets ?? []).map((w, i) => (
        <FormWidgetView
          key={`fwid-${w.fieldName}-${i}`}
          widget={w}
          rotation={page.rotation}
          // FormWidgetView renders NOTHING without this — see showsFormWidgets
          // for which modes qualify and why authoring is one of them.
          formsMode={showsFormWidgets(tool)}
          pending={formValues?.get(w.fieldName)}
          fontPx={freetextFontPx * (10 / 12)}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
        />
      ))}
      {signaturePlacement && (
        (() => {
          const r = projectMarkRect(signaturePlacement, page.rotation);
          return (
            <div
              data-testid="signature-placement"
              className="page-signature"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            >
              <span className="page-signature-label">SIGNATURE</span>
              {(tool === 'select' || tool === 'signature') && (
                <button
                  className="page-annot-x"
                  title="Remove signature placement"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearSignaturePlacement();
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })()
      )}
      {newFieldPlacement && (
        (() => {
          const r = projectMarkRect(newFieldPlacement, page.rotation);
          return (
            <div
              data-testid="new-field-placement"
              className="page-form-new"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            >
              <span className="page-form-new-label">NEW FIELD</span>
              {(tool === 'select' || tool === 'forms' || tool === 'formfields') && (
                <button
                  className="page-annot-x"
                  title="Remove field placement"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearNewFieldPlacement();
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })()
      )}
      {addTextPlacement && (
        (() => {
          const r = projectMarkRect(addTextPlacement, page.rotation);
          return (
            <div
              data-testid="add-text-placement"
              className="page-form-new page-addtext-new"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            >
              <span className="page-form-new-label">NEW TEXT</span>
              {(tool === 'select' || tool === 'edit' || tool === 'addtext') && (
                <button
                  className="page-annot-x"
                  title="Remove text placement"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearAddTextPlacement();
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })()
      )}
      {band && (
        <div
          className={
            'page-annot page-annot-band' +
            (tool === 'redact'
              ? ' band-redact'
              : tool === 'signature'
                ? ' band-signature'
                : tool === 'formfields'
                  ? ' band-formfield'
                  : tool === 'addtext'
                    ? ' band-addtext'
                    : tool === 'addimage'
                      ? ' band-addimage'
                      : '')
          }
          style={{
            left: `${band.x * 100}%`,
            top: `${band.y * 100}%`,
            width: `${band.w * 100}%`,
            height: `${band.h * 100}%`,
          }}
        />
      )}
      {inkPoints && (
        <svg className="page-annot-ink-svg page-annot-ink-live" viewBox="0 0 1 1" preserveAspectRatio="none">
          <polyline
            points={inkPoints.reduce<string[]>((acc, v, i) => {
              if (i % 2 === 0) acc.push(`${v}`);
              else acc[acc.length - 1] += `,${v}`;
              return acc;
            }, []).join(' ')}
            fill="none"
            stroke={annotationColor ?? INK_COLOR}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <span className="page-number">{visibleNumber}</span>
    </div>
  );
}

/** The paragraph editor (7.5): a textarea at the box rect seeded with the
 * paragraph's logical text; per keystroke it re-derives the span mapping
 * (prefix/suffix diff, caret inheritance) and validates each range against
 * its style-source font — the 7.2 live-refusal discipline at paragraph
 * scale. Enter COMMITS (paragraphs are one flowing block; splitting is a
 * stated non-goal, pasted newlines become spaces); Escape cancels; blur
 * commits-if-valid-and-changed, else cancels. */
function ParagraphEditor({
  para,
  rect,
  lineHeightPx,
  onCommit,
  onCancel,
}: {
  para: EditParagraph;
  rect: { x: number; y: number; w: number; h: number };
  lineHeightPx: number;
  onCommit: (value: string, opts?: ParagraphEditOpts) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(para.text);
  // A1 restyle controls, seeded from the paragraph's own size/colour.
  const [size, setSize] = useState(para.fontSize);
  const [color, setColor] = useState(para.color);
  // A3a family swap — '' = keep the original fonts. The options name the
  // ACTUAL substitute faces (Liberation …): the swap is an honest
  // substitution, not a style toggle on the foundry font.
  const [family, setFamily] = useState<'' | 'serif' | 'sans' | 'mono'>('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // ONE outcome per editor instance: Enter-commit, Escape-cancel, blur,
  // and the convert button all race through here — whichever fires first
  // wins and any refire is a no-op (review-caught HIGH; the unmount-blur
  // refire otherwise turns an Escape-cancel into a commit).
  const settledRef = useRef(false);
  const settle = (fn: () => void): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    fn();
  };
  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.select();
  }, []);
  const spans = computeEditSpans(para.text, value, para.spans, para.runs[0]);
  const familyChanged = family !== '';
  // With a family swap EVERY character re-renders in the chosen Liberation
  // face, so the members' own coverage no longer applies — the live
  // run-inventory check would wrongly block (e.g. a char the original
  // subset lacks but Liberation has). Coverage the LIBERATION face lacks
  // (CJK, astral) refuses engine-side with a stated reason, surfaced as
  // the standard edit notice — the same honest boundary as convert.
  const missing = familyChanged ? [] : paragraphUnencodable(value, spans, para.encodableByRun);
  const valid = missing.length === 0;
  const sizeChanged = Math.abs(size - para.fontSize) > 0.01;
  const colorChanged = color.toLowerCase() !== para.color.toLowerCase();
  const changed = value !== para.text || sizeChanged || colorChanged || familyChanged;
  // The restyle overrides sent with a commit — only fields the user
  // actually changed from the seed (unchanged size/colour/family stay the
  // paragraph's own, engine-side).
  const restyleOpts = (extra?: ParagraphEditOpts): ParagraphEditOpts => {
    const o: ParagraphEditOpts = { ...extra };
    if (sizeChanged && size > 0) o.size = size;
    if (colorChanged) {
      const rgb = hexToRgb(color);
      if (rgb) o.color = rgb;
    }
    if (familyChanged) o.family = family;
    return o;
  };
  const finish = (): void => {
    if (valid && changed) settle(() => onCommit(value, restyleOpts()));
    else settle(onCancel);
  };
  const fontPx = Math.min(48, Math.max(8, lineHeightPx * 0.8));
  return (
    <div
      ref={wrapperRef}
      className="page-edittext-editor page-editpara-editor"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        minWidth: `${rect.w * 100}%`,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        // A press on non-focusable chrome (the error line) must not blur
        // the input — blur means commit-or-cancel. Focusable controls
        // (the size/colour inputs, buttons) ARE allowed to take focus;
        // the focus-within onBlur below keeps that from committing.
        const t = e.target as HTMLElement;
        if (!/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(t.tagName)) e.preventDefault();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Enter/Escape at the WRAPPER so they work from EVERY control
        // (the size/colour inputs, not just the textarea — review-caught
        // that Escape did nothing while a control had focus).
        if (e.key === 'Enter') {
          e.preventDefault(); // also stops a newline in the textarea
          if (valid && changed) settle(() => onCommit(value, restyleOpts()));
          else if (!changed) settle(onCancel);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          settle(onCancel);
        }
      }}
      onBlur={(e) => {
        // Commit only when focus leaves the WHOLE editor — moving between
        // the textarea and the restyle controls must not commit (A1).
        const next = e.relatedTarget as Node | null;
        if (next && wrapperRef.current?.contains(next)) return;
        finish();
      }}
    >
      <div className="page-editpara-toolbar" role="group" aria-label="Text style">
        <label className="page-editpara-ctl">
          Size
          <input
            type="number"
            data-testid="edit-para-size"
            min={1}
            max={1638}
            step={1}
            value={Number.isFinite(size) ? Math.round(size) : ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              // Clamp to the same [1,1638] the input declares; on an
              // empty/NaN field keep the last valid size (the old
              // `|| para.fontSize` snapped back to the ORIGINAL seed,
              // fighting a clear-and-retype — review-caught).
              if (Number.isFinite(v)) setSize(Math.max(1, Math.min(1638, v)));
            }}
          />
        </label>
        <label className="page-editpara-ctl">
          Colour
          <input
            type="color"
            data-testid="edit-para-color"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label className="page-editpara-ctl">
          Font
          <select
            data-testid="edit-para-family"
            value={family}
            title="Replaces the paragraph's font with the chosen bundled face"
            onChange={(e) => setFamily(e.target.value as '' | 'serif' | 'sans' | 'mono')}
          >
            <option value="">Keep original font</option>
            <option value="sans">Liberation Sans</option>
            <option value="serif">Liberation Serif</option>
            <option value="mono">Liberation Mono</option>
          </select>
        </label>
      </div>
      <textarea
        ref={areaRef}
        data-testid="edit-para-input"
        className={valid ? '' : 'invalid'}
        value={value}
        rows={Math.min(12, para.lineCount + 1)}
        style={{ fontSize: `${fontPx}px`, lineHeight: 1.25 }}
        onChange={(e) => setValue(sanitizeParagraphInput(e.target.value))}
        /* Enter/Escape handled at the wrapper (works from every control).
           Invalid+changed holds the editor open there — Enter never
           silently discards or commits the inexpressible. */
      />
      {!valid && (
        <div className="page-edittext-error" data-testid="edit-para-error" aria-live="polite">
          This document's font does not contain {missing.map((c) => `'${c}'`).join(' ')}
          <button
            type="button"
            data-testid="edit-para-convert"
            className="page-edittext-convert"
            onClick={() => settle(() => onCommit(value, restyleOpts({ convert: true })))}
          >
            Use a compatible font
          </button>
        </div>
      )}
    </div>
  );
}

/** The inline text-run editor (7.2+7.3): an input at the run's display
 * rect, seeded with the decoded text, validated LIVE against the run's
 * finite encodable inventory — apply disables with the offending character
 * named, never a save-time surprise. Enter commits (when valid+changed);
 * Escape cancels; blur commits-if-valid-and-changed, else cancels. Input
 * value is local state — the canvas only hears commit/cancel. */
function TextRunEditor({
  run,
  rect,
  heightPx,
  onCommit,
  onCancel,
}: {
  run: EditTextRun;
  rect: { x: number; y: number; w: number; h: number };
  heightPx: number;
  onCommit: (value: string, opts?: { convert?: boolean }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(run.text);
  const inputRef = useRef<HTMLInputElement>(null);
  // The same one-outcome rule as ParagraphEditor (see its comment): the
  // unmount-blur refire must never convert an Escape-cancel into a
  // commit. Inherited fix — the shape was identical here.
  const settledRef = useRef(false);
  const settle = (fn: () => void): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    fn();
  };
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const missing = unencodableChars(value, run.encodable);
  const valid = missing.length === 0;
  const changed = value !== run.text;
  const finish = (): void => {
    if (valid && changed) settle(() => onCommit(value));
    else settle(onCancel);
  };
  return (
    <div
      className="page-edittext-editor"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        minWidth: `${rect.w * 100}%`,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        // A press on the editor's own chrome (the error line under the
        // input) must not blur the input — blur means commit-or-cancel,
        // and clicking the error to READ it discarded the edit
        // (review-caught).
        if (e.target !== inputRef.current) e.preventDefault();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        data-testid="edit-text-input"
        className={valid ? '' : 'invalid'}
        value={value}
        style={{
          fontSize: `${Math.min(48, Math.max(8, heightPx * 0.8))}px`,
          height: `${Math.min(64, Math.max(12, heightPx * 1.15))}px`,
        }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // Invalid + changed: HOLD the editor open with the error named —
            // Enter never silently discards, and never commits the
            // inexpressible. Unchanged: Enter is a close.
            if (valid && changed) settle(() => onCommit(value));
            else if (!changed) settle(onCancel);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            settle(onCancel);
          }
        }}
        onBlur={finish}
      />
      {!valid && (
        <div className="page-edittext-error" data-testid="edit-text-error" aria-live="polite">
          This document's font does not contain {missing.map((c) => `'${c}'`).join(' ')}
          {/* 7.4: the coverage-refusal escape hatch — re-render the run in
              the bundled fallback font. The wrapper's pointerdown
              preventDefault keeps the input focused; click still fires. */}
          <button
            type="button"
            data-testid="edit-text-convert"
            className="page-edittext-convert"
            onClick={() => settle(() => onCommit(value, { convert: true }))}
          >
            Use a compatible font
          </button>
        </div>
      )}
    </div>
  );
}

export const PageCell = memo(PageCellImpl);
