import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { showsFormWidgets } from '../../commands/tools';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageAnnotation, PageRef } from '../../state/types';
import { displayWidthAt, displayWidthOf, BASE_PAGE_HEIGHT } from '../../canvas/layout';
import { projectMarkRect, rotateNormalizedPoints, rotateNormalizedRect } from '../../lib/redaction';
import type { RedactionMark } from '../../lib/redaction';
import type { OcrWord } from '../../ocr/types';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import { rgb01ToHex, hex01ToRgb, type EditVectorObject } from '../../lib/edit-vectors';
import ImageTransformOverlay from './ImageTransformOverlay';
import type { EditTextRun } from '../../lib/edit-text';
import { unencodableChars } from '../../lib/edit-text';
import type { EditParagraph, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import {
  applySpanColor,
  applySpanSize,
  styledSegments,
  segmentsToHtml,
  composeSpanFaces,
  composeSpanSizes,
  computeEditSpans,
  hexToRgb,
  mergeSpanColors,
  mergeSpanFaces,
  mergeSpanSizes,
  paragraphUnencodable,
  remapRanges,
  sanitizeParagraphInput,
  seedSpanColors,
  seedSpanFaces,
  seedSpanSizes,
  setSpanFaceFamily,
  setSpanFaceFeature,
  toggleSpanFaceAxis,
  spanColorsToStyles,
  spanFacesToStyles,
  spanSizesToStyles,
  type SpanColor,
  type SpanFace,
  type SpanSize,
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

/** Draw native text-markup quads (N1) inside the annotation's bbox. `quads` and
 * `box` share the page-normalized 0..1 space; each quad is normalized into the
 * 0..1 SVG viewBox and drawn per style: highlight = translucent fill, underline
 * = line at the quad bottom, strikeout = mid-line, squiggly = a wave at the
 * bottom. Non-scaling strokes keep line weight constant under zoom. */
function TextMarkupSvg({
  quads,
  box,
  markupType,
  color,
}: {
  quads: number[];
  box: { x: number; y: number; w: number; h: number };
  markupType: 'highlight' | 'underline' | 'strikeout' | 'squiggly';
  color: string;
}): React.ReactElement {
  const nx = (v: number) => (box.w > 0 ? (v - box.x) / box.w : 0);
  const ny = (v: number) => (box.h > 0 ? (v - box.y) / box.h : 0);
  const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i + 3 < quads.length; i += 4) {
    const x0 = nx(quads[i]);
    const y0 = ny(quads[i + 1]);
    const x1 = nx(quads[i + 2]);
    const y1 = ny(quads[i + 3]);
    rects.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  }
  return (
    <svg className="page-annot-ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
      {rects.map((r, i) => {
        if (markupType === 'highlight') {
          return (
            <rect key={i} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill={color} opacity={0.4} />
          );
        }
        const yLine = markupType === 'strikeout' ? (r.y0 + r.y1) / 2 : r.y1;
        if (markupType === 'squiggly') {
          // A small zigzag along the baseline.
          const steps = Math.max(2, Math.round((r.x1 - r.x0) / 0.04));
          const amp = Math.min(0.12, (r.y1 - r.y0) * 0.25);
          const pts: string[] = [];
          for (let s = 0; s <= steps; s++) {
            const x = r.x0 + ((r.x1 - r.x0) * s) / steps;
            const y = r.y1 - (s % 2 === 0 ? 0 : amp);
            pts.push(`${x},${y}`);
          }
          return (
            <polyline key={i} points={pts.join(' ')} fill="none" stroke={color} vectorEffect="non-scaling-stroke" />
          );
        }
        return (
          <line key={i} x1={r.x0} y1={yLine} x2={r.x1} y2={yLine} stroke={color} vectorEffect="non-scaling-stroke" />
        );
      })}
    </svg>
  );
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
  /** 9.D1: this page's vector path objects + the selected index (pre-filtered
   * by pageId upstream) + select/delete callbacks. */
  editVectors?: EditVectorObject[];
  selectedVectorIndex?: number | null;
  onSelectEditVector?: (pageId: string, index: number) => void;
  onDeleteVector?: () => void;
  /** 9.D3: recolour / re-width the selected vector object. */
  onRestyleVector?: (
    pageId: string,
    index: number,
    opts: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => void;
  /** 9.D2: transform context for THIS page's selected vector (pre-filtered by
   * pageId) — reuses the image transform overlay (crop null). */
  vectorTransform?: EditImageTransformCtx | null;
  onCommitVectorTransform?: (pageId: string, index: number, matrix: number[]) => void;
  /** Transform context for THIS page's selected image (9.C1), pre-filtered by
   * pageId upstream — non-null only on the page whose image is selected. */
  editImageTransform?: EditImageTransformCtx | null;
  onCommitImageTransform?: (pageId: string, index: number, matrix: number[]) => void;
  /** 9.C3: crop mode armed (toolbar toggle) — the overlay's body drag draws
   * the crop band instead of moving. */
  imageCropArmed?: boolean;
  onCommitImageCrop?: (pageId: string, index: number, rect: [number, number, number, number]) => void;
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
  /** A4: merge the paragraph being edited into the one above it (fires
   * only from an unchanged editor with the caret at position 0). */
  onMergeParagraphPrev?: (pageId: string, index: number) => void;
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

type VectorRestyleOpts = {
  fill?: [number, number, number];
  stroke?: [number, number, number];
  lineWidth?: number;
};

// 9.D3 restyle toolbar for the selected vector object. Keyed by the object
// index upstream, so it REMOUNTS (re-seeding local state) when the selection
// switches — the fill/stroke swatches AND the width field never show a stale
// prior object's value (round-38 HIGH #1). Every input previews LOCALLY and
// commits on a debounce that re-arms while a prior commit is in flight, so a
// colour-picker drag or multi-digit width edit is ONE undoable engine op with
// the FINAL value, not a stream of dropped intermediates (round-38 HIGH #2).
function VectorRestyleToolbar({
  obj,
  busy,
  className,
  style,
  testid,
  onCommit,
}: {
  obj: EditVectorObject;
  busy: boolean;
  className: string;
  style: React.CSSProperties;
  testid: string;
  onCommit: (opts: VectorRestyleOpts) => void;
}): React.ReactElement {
  const [fill, setFill] = useState(() => rgb01ToHex(obj.fill));
  const [stroke, setStroke] = useState(() => rgb01ToHex(obj.stroke));
  const [width, setWidth] = useState(() => String(obj.lineWidth));
  const pending = useRef<VectorRestyleOpts>({});
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    timer.current = null;
    const p = pending.current;
    if (p.fill === undefined && p.stroke === undefined && p.lineWidth === undefined) return;
    if (busyRef.current) {
      timer.current = setTimeout(flush, 150); // a commit is in flight — wait it out
      return;
    }
    pending.current = {};
    onCommit(p);
  }, [onCommit]);
  const schedule = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 250);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className={className} data-testid={testid} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {obj.kind !== 'stroke' && (
        <label className="page-editvec-ctl" title="Fill colour">
          Fill
          <input
            type="color"
            data-testid={`edit-vector-fill-${obj.index}`}
            value={fill}
            onChange={(e) => {
              setFill(e.target.value);
              pending.current.fill = hex01ToRgb(e.target.value);
              schedule();
            }}
          />
        </label>
      )}
      {obj.kind !== 'fill' && (
        <>
          <label className="page-editvec-ctl" title="Stroke colour">
            Line
            <input
              type="color"
              data-testid={`edit-vector-stroke-${obj.index}`}
              value={stroke}
              onChange={(e) => {
                setStroke(e.target.value);
                pending.current.stroke = hex01ToRgb(e.target.value);
                schedule();
              }}
            />
          </label>
          <label className="page-editvec-ctl" title="Line width">
            W
            <input
              type="number"
              min={0}
              step={0.5}
              className="page-editvec-width"
              data-testid={`edit-vector-width-${obj.index}`}
              value={width}
              onChange={(e) => {
                setWidth(e.target.value);
                const w = parseFloat(e.target.value);
                if (Number.isFinite(w) && w >= 0) {
                  pending.current.lineWidth = w;
                  schedule();
                }
              }}
            />
          </label>
        </>
      )}
    </div>
  );
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
  editVectors,
  selectedVectorIndex,
  onSelectEditVector,
  onDeleteVector,
  onRestyleVector,
  vectorTransform,
  onCommitVectorTransform,
  editImageTransform,
  onCommitImageTransform,
  imageCropArmed,
  onCommitImageCrop,
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
  onMergeParagraphPrev,
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
                // quads are corner pairs — rotating each (x,y) then min/max-ing
                // per quad in the SVG below reprojects them into the view frame.
                quads: a.quads ? rotateNormalizedPoints(a.quads, viewRotation) : a.quads,
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
            (a.kind === 'textmarkup' ? ' page-annot-ink' : '') + // SVG body, no default border
            (a.kind === 'stamp' ? ' page-annot-stamp' : '')
          }
          title={a.kind === 'highlight' || a.kind === 'ink' || a.kind === 'textmarkup' ? a.note : undefined}
          style={{
            left: `${da.x * 100}%`,
            top: `${da.y * 100}%`,
            width: `${da.w * 100}%`,
            height: `${da.h * 100}%`,
            ...(pristineImport
              ? {}
              : a.kind === 'highlight'
                ? { backgroundColor: `${a.color}66`, borderColor: a.color }
                : a.kind === 'ink' || a.kind === 'textmarkup'
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
          {a.kind === 'textmarkup' && !pristineImport && (
            <TextMarkupSvg
              quads={da.quads ?? []}
              box={{ x: da.x, y: da.y, w: da.w, h: da.h }}
              markupType={a.markupType ?? 'highlight'}
              color={a.color}
            />
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
                          : a.kind === 'textmarkup'
                            ? `Remove ${a.markupType ?? 'highlight'}`
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
      {/* 9.D1 vector objects — rendered FIRST (before paragraphs/text/images)
          so those inner-content overlays paint on top and win a click where
          they overlap a vector's bbox (a coloured rect behind a heading, a
          table-cell fill under text — the text stays selectable). A thin
          line/rule has a near-zero-extent bbox; the hit box inflates to a
          minimum clickable thickness (render-only — the object's real rect,
          for a later transform, is unchanged). */}
      {tool === 'edit' &&
        (editVectors ?? []).map((vec) => {
          const selected = selectedVectorIndex === vec.index;
          // The SELECTED vector is handled by the transform overlay + delete
          // affordance below; unselected ones are plain selectable boxes.
          if (selected) return null;
          const r0 = rotateNormalizedRect(vec.rect, page.rotation);
          const MIN_HIT = 0.012;
          const r = {
            x: r0.w < MIN_HIT ? r0.x - (MIN_HIT - r0.w) / 2 : r0.x,
            y: r0.h < MIN_HIT ? r0.y - (MIN_HIT - r0.h) / 2 : r0.y,
            w: Math.max(r0.w, MIN_HIT),
            h: Math.max(r0.h, MIN_HIT),
          };
          return (
            <div
              key={`ev-${vec.index}`}
              className="page-editvec"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            >
              <button
                type="button"
                data-testid={`edit-vector-${vec.index}`}
                className="page-editvec-hit"
                title={`Vector object (${vec.kind})${vec.nested ? ' — inside a group' : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEditVector?.(page.id, vec.index);
                }}
              />
            </div>
          );
        })}
      {/* 9.D2: the selected vector's transform overlay (move/resize/rotate —
          the image overlay reused, crop disabled) + a delete affordance
          positioned at its bbox. */}
      {tool === 'edit' &&
        vectorTransform &&
        onCommitVectorTransform &&
        (() => {
          const selVec = (editVectors ?? []).find((v) => v.index === vectorTransform.index);
          const dr = selVec ? rotateNormalizedRect(selVec.rect, page.rotation) : null;
          return (
            <>
              <ImageTransformOverlay
                ctx={vectorTransform}
                pendingRotate={page.rotation}
                onCommit={(matrix) =>
                  onCommitVectorTransform(page.id, vectorTransform.index, matrix)
                }
                cropArmed={false}
                onCommitCrop={() => {}}
              />
              {dr && onDeleteVector && (
                <button
                  type="button"
                  data-testid={`edit-vector-delete-${vectorTransform.index}`}
                  className="page-editvec-del"
                  title="Delete this vector object"
                  style={{ left: `${(dr.x + dr.w) * 100}%`, top: `${dr.y * 100}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteVector();
                  }}
                >
                  ×
                </button>
              )}
              {dr &&
                selVec &&
                onRestyleVector &&
                (() => {
                  // Round-38 MED #4: flip the toolbar ABOVE a near-bottom
                  // object and clamp its left so it can't render off the
                  // clipped page (a footer rule / far-right object).
                  const above = dr.y + dr.h > 0.82;
                  const left = Math.max(0, Math.min(dr.x, 0.6));
                  return (
                    <VectorRestyleToolbar
                      key={selVec.index}
                      obj={selVec}
                      busy={vectorTransform.busy}
                      className={'page-editvec-toolbar' + (above ? ' above' : '')}
                      style={{ left: `${left * 100}%`, top: `${(above ? dr.y : dr.y + dr.h) * 100}%` }}
                      testid={`edit-vector-toolbar-${vectorTransform.index}`}
                      onCommit={(opts) => onRestyleVector(page.id, vectorTransform.index, opts)}
                    />
                  );
                })()}
            </>
          );
        })()}
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
                onMergePrev={
                  para.index > 0 && onMergeParagraphPrev
                    ? () => onMergeParagraphPrev(page.id, para.index)
                    : undefined
                }
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
          cropArmed={Boolean(imageCropArmed)}
          onCommitCrop={(rect) => onCommitImageCrop?.(page.id, editImageTransform.index, rect)}
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
              <span className="page-form-new-label">
                NEW TEXT{' '}
                <span
                  className="inline-block"
                  data-testid="add-text-direction"
                  // Reading direction: −rotate in CSS (positive CSS = CW;
                  // rotate=90 reads bottom-to-top ⇒ arrow points up), spun
                  // WITH the pending view rotation like the box itself.
                  style={{
                    transform: `rotate(${page.rotation - (addTextPlacement.rotate ?? 0)}deg)`,
                  }}
                  aria-hidden
                >
                  →
                </span>
              </span>
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

/** 9.A5-tails-b contentEditable plumbing. The rich surface renders one <span>
 * per style segment, so a caret/selection lives at (text node, UTF-16 offset)
 * rather than a flat textarea index. These map that to and from the CODE-POINT
 * domain the engine's spans use (`Array.from` — an astral char is ONE unit).
 * They touch the DOM, so they are proven by e2e rather than unit tests (this
 * repo has no DOM test environment); the pure index arithmetic they lean on
 * (`segmentPosToCodePoint`/`codePointToSegmentPos`) IS unit-tested. */
function domPosToCodePoint(root: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return total + Array.from((current.textContent ?? '').slice(0, offset)).length;
    }
    total += Array.from(current.textContent ?? '').length;
    current = walker.nextNode();
  }
  // The position is an ELEMENT node (e.g. the editor itself when empty, or a
  // boundary between spans): `offset` counts child elements, so sum the text
  // of the children before it.
  if (node === root) {
    let seen = 0;
    for (let i = 0; i < offset && i < root.childNodes.length; i++) {
      seen += Array.from(root.childNodes[i].textContent ?? '').length;
    }
    return seen;
  }
  return total;
}

/** (text node, UTF-16 offset) for an absolute code-point index. */
function codePointToDomPos(root: HTMLElement, index: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? '';
    const chars = Array.from(text);
    if (seen + chars.length >= index) {
      return { node, offset: chars.slice(0, index - seen).join('').length };
    }
    seen += chars.length;
    last = node;
    node = walker.nextNode();
  }
  if (last) return { node: last, offset: (last.textContent ?? '').length };
  return { node: root, offset: 0 };
}

/** The editor's current selection in code points, or null when the browser
 * selection is absent or outside the editor (contentEditable drops it on
 * blur — see `lastSelRef`). */
function readEditorSelection(
  root: HTMLElement | null,
): { start: number; end: number } | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const a = domPosToCodePoint(root, range.startContainer, range.startOffset);
  const b = domPosToCodePoint(root, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Read just the caret (collapsed end) — used before a re-render replaces the
 * nodes the browser selection points into. */
function readCaret(root: HTMLElement): number {
  const sel = readEditorSelection(root);
  return sel ? sel.end : Array.from(root.textContent ?? '').length;
}

/** Put the selection back after a render, in code points. */
function setEditorSelection(root: HTMLElement, start: number, end: number): void {
  const a = codePointToDomPos(root, start);
  const b = codePointToDomPos(root, end);
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return; // stale offsets after an out-of-band change: leave the caret alone
  }
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The paragraph editor (7.5, rich surface since 9.A5-tails-b): a
 * contentEditable at the box rect seeded with the paragraph's logical text;
 * per keystroke it re-derives the span mapping (prefix/suffix diff, caret
 * inheritance) and validates each range against its style-source font — the
 * 7.2 live-refusal discipline at paragraph scale. Enter COMMITS (paragraphs
 * are one flowing block; splitting is a stated non-goal, pasted newlines
 * become spaces); Escape cancels; blur commits-if-valid-and-changed, else
 * cancels. The DOM is rendered FROM state every keystroke and is never the
 * source of truth, so the value is always a plain string. */
function ParagraphEditor({
  para,
  rect,
  lineHeightPx,
  onCommit,
  onCancel,
  onMergePrev,
}: {
  para: EditParagraph;
  rect: { x: number; y: number; w: number; h: number };
  lineHeightPx: number;
  onCommit: (value: string, opts?: ParagraphEditOpts) => void;
  onCancel: () => void;
  /** A4: merge into the previous paragraph — provided only when one
   * exists; fires only from an unchanged editor at caret 0. */
  onMergePrev?: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(para.text);
  // A1 restyle controls, seeded from the paragraph's own size/colour.
  const [size, setSize] = useState(para.fontSize);
  const [color, setColor] = useState(para.color);
  // A3a family swap — '' = keep the original fonts. The options name the
  // ACTUAL substitute faces (Liberation …): the swap is an honest
  // substitution, not a style toggle on the foundry font.
  const [family, setFamily] = useState<'' | 'serif' | 'sans' | 'mono'>('');
  // A3b style toggles, seeded from the paragraph's own weight/slant.
  // Toggling substitutes the whole paragraph into the styled Liberation
  // face (same honesty as the family swap).
  const [bold, setBold] = useState(para.bold);
  const [italic, setItalic] = useState(para.italic);
  // 9.K2 whole-paragraph OpenType features (the caret / whole-text case).
  // No seed: the listing does not report a paragraph's existing features
  // (detecting them would need reverse glyph analysis), so these start OFF
  // and a press is always an explicit request to apply.
  const [smallCaps, setSmallCaps] = useState(false);
  const [alternates, setAlternates] = useState(false);
  const [altIndex, setAltIndex] = useState(0);
  const areaRef = useRef<HTMLDivElement>(null);
  // 9.A5-tails-b: a contentEditable DROPS its selection when it loses focus,
  // where a textarea kept selectionStart/End. The dual-role controls (swatch,
  // size stepper, B/I, family) all take focus when clicked, so without this
  // every per-span action would see an empty selection and fall through to the
  // whole-paragraph branch — the exact silent-wrong-path failure the round-35
  // repair was about. `liveSel` therefore prefers the LIVE DOM selection and
  // falls back to the last one observed inside the editor.
  const lastSelRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Caret to restore after the next render (the segment spans the browser
  // selection pointed into are replaced on every keystroke).
  const pendingCaretRef = useRef<number | null>(null);
  // Render revision. The browser mutates the contentEditable's DOM directly,
  // so React's virtual DOM is stale by the time `input` fires. When the edit
  // leaves `value` UNCHANGED (the sanitizer collapsed it), `setValue` bails
  // out, nothing re-renders, and the browser's mutation would survive as a
  // silent DOM-vs-state divergence. Bumping this on every sync forces a
  // render, and the spans are KEYED on it so they remount and the DOM is
  // exactly what React rendered from `value`.
  const [rev, setRev] = useState(0);
  // IME composition (the CJK documents B2 exists for): the browser owns the
  // DOM mid-compose, so remounting the spans under it would break the
  // composition. Skip syncing until it ends.
  const composingRef = useRef(false);
  // The html last committed to the DOM — lets the layout effect tell a
  // DOM-rebuilding render (a text edit or a restyle) from an ordinary one.
  const lastHtmlRef = useRef<string>('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  // A5a per-span colour: the ranges (code points) painted a colour other
  // than the paragraph default, seeded from the listing's per-span colours.
  const [spanColors, setSpanColors] = useState<SpanColor[]>(() =>
    seedSpanColors(para.spans, para.color),
  );
  // A5b per-span faces: ranges the USER substituted into a bundled weight/
  // slant/family. These are the ONLY face ranges ever sent to the engine.
  const [spanFaces, setSpanFaces] = useState<SpanFace[]>([]);
  // A5c per-span sizes the USER set — likewise the only ones sent.
  const [spanSizes, setSpanSizes] = useState<SpanSize[]>([]);
  // 9.A5-tails-a DISPLAY seeds: what the paragraph's spans ALREADY are, from
  // the listing, so a reopened mixed-face/mixed-size paragraph shows its
  // styling instead of starting blank. Deliberately SEPARATE from the user
  // overrides above and never sent: a face entry SUBSTITUTES its range into a
  // bundled Liberation face, so echoing a seed back would silently replace
  // the document's own foundry font just for opening the editor and pressing
  // Enter. (That hazard is why A5b shipped with no seed at all.) They still
  // ride the text diff so they stay attached to their characters.
  const [seedFaces, setSeedFaces] = useState<SpanFace[]>(() =>
    seedSpanFaces(para.spans, { bold: para.bold, italic: para.italic }),
  );
  const [seedSizes, setSeedSizes] = useState<SpanSize[]>(() =>
    seedSpanSizes(para.spans, para.fontSize),
  );
  // What the user can SEE: overrides laid over the seeds. Toggles and the
  // backdrop read this; the commit still reads the overrides alone.
  const shownFaces = composeSpanFaces(seedFaces, spanFaces);
  const shownSizes = composeSpanSizes(seedSizes, spanSizes);
  const fontPx = Math.min(48, Math.max(8, lineHeightPx * 0.8));
  // The rich surface's content, computed once: the JSX assigns it and the
  // layout effect compares against the last committed copy to know when the
  // DOM was rebuilt (and the selection therefore needs restoring).
  const html = segmentsToHtml(styledSegments(value, spanColors, shownFaces, shownSizes), {
    basePx: fontPx,
    baseSize: Math.max(1, size),
    rev,
  });
  // The face covering a code-point position (for a per-span toggle to flip
  // one axis while keeping the others), or the plain default.
  const faceAt = (
    pos: number,
  ): {
    bold: boolean;
    italic: boolean;
    family?: 'serif' | 'sans' | 'mono';
    smallCaps: boolean;
    alternates: boolean;
  } => {
    const hit = shownFaces.find((f) => pos >= f.start && pos < f.end);
    return hit
      ? {
          bold: hit.bold,
          italic: hit.italic,
          family: hit.family,
          smallCaps: Boolean(hit.smallCaps),
          alternates: Boolean(hit.alternates),
        }
      : { bold: false, italic: false, smallCaps: false, alternates: false };
  };
  // A5c: the size field's displayed value (a string so a clear-and-retype
  // works), driven by typing and by the current selection's per-span size.
  const [sizeField, setSizeField] = useState<string>(() => String(Math.round(para.fontSize)));
  // A5a: the colour swatch's displayed value, driven the same way as the
  // size field — a per-span pick doesn't touch the whole-paragraph `color`,
  // so the native picker (a controlled input) needs its own state to hold
  // what was picked, and to reflect the current selection's per-span colour.
  const [colorField, setColorField] = useState<string>(() => para.color);
  // 9.A5-tails-a/b: the B/I buttons' PRESSED look. A partial selection shows
  // that range's actual face (seeds included, so a paragraph opened on
  // already-bold text shows B pressed and the click un-bolds); a caret or
  // select-all shows the whole-paragraph override, which is what those target.
  // null = "use the paragraph state", mirroring sizeField/colorField.
  const [faceField, setFaceField] = useState<{
    bold: boolean;
    italic: boolean;
    smallCaps: boolean;
    alternates: boolean;
  } | null>(null);
  // The editor's LIVE selection in code points, read at the instant a
  // dual-role control fires — and, unlike an onSelect capture, it works when a
  // test drives the DOM selection directly (no synthetic `select` event
  // needed; the round-35 repair's requirement). Falls back to the last
  // selection seen inside the editor for the blur case above.
  const liveSel = (): { start: number; end: number } => {
    const live = readEditorSelection(areaRef.current);
    if (live) {
      lastSelRef.current = live;
      return live;
    }
    return lastSelRef.current;
  };
  // The dual-role controls target a PARTIAL selection per-span; a collapsed
  // caret OR a whole-text selection targets the whole paragraph. Returns the
  // range for the per-span case, else null. This is what keeps "open editor
  // (select-all) → click Bold" a clean whole-paragraph substitution (the
  // shipped A3 path) rather than a per-span face over every character — and
  // an explicit select-all still styles everything, just via the whole-para
  // path (functionally identical). Code-point domain, matching liveSel.
  const spanTarget = (): { start: number; end: number } | null => {
    const sel = liveSel();
    if (sel.end <= sel.start) return null; // collapsed → whole paragraph
    const cpLen = Array.from(value).length;
    if (sel.start === 0 && sel.end >= cpLen) return null; // whole text → whole paragraph
    return sel;
  };
  // The size field AND colour swatch reflect the current per-span target's
  // value (or the whole-paragraph value otherwise), so each control edits
  // what it will actually change — a display sync only (the apply re-reads
  // spanTarget). A collapsed OR whole-text selection shows the whole-para
  // value, honestly matching what the control then targets (round-34 MED).
  const captureSelection = (): void => {
    const sel = spanTarget();
    if (sel) {
      // 9.A5-tails-a: read the SHOWN sizes (seeds + overrides) so the field
      // reports the size the selected text actually has, not just one the
      // user set this session.
      const sizeHit = shownSizes.find((r) => sel.start >= r.start && sel.start < r.end);
      setSizeField(String(Math.round(sizeHit ? sizeHit.size : size)));
      const colorHit = mergeSpanColors(spanColors).find(
        (r) => sel.start >= r.start && sel.start < r.end,
      );
      setColorField(colorHit ? colorHit.color : color);
      const f = faceAt(sel.start);
      // Stable identity — this runs on every `selectionchange`, so allocating
      // a fresh object each tick would re-render the editor continuously.
      setFaceField((prev) =>
        prev &&
        prev.bold === f.bold &&
        prev.italic === f.italic &&
        prev.smallCaps === f.smallCaps &&
        prev.alternates === f.alternates
          ? prev
          : { bold: f.bold, italic: f.italic, smallCaps: f.smallCaps, alternates: f.alternates },
      );
    } else {
      setSizeField(String(Math.round(size)));
      setColorField(color);
      setFaceField(null);
    }
  };
  // 9.A5-tails-b: the ONE path text changes take (typing, IME commit, paste).
  // `next` is already sanitized; `caret` is a code-point offset in it.
  const applyText = (next: string, caret: number): void => {
    // Per-span overrides follow the text edit (same diff as the spans), then
    // flatten to disjoint — a retype whose window spans two different ranges
    // would otherwise leave them overlapping and the preview would show a
    // different winner than the commit (round-32 HIGH). The merge resolves it
    // the way the engine folds, so state stays canonical.
    setSpanColors((prev) => mergeSpanColors(remapRanges(value, next, prev)));
    setSpanFaces((prev) => mergeSpanFaces(remapRanges(value, next, prev)));
    setSpanSizes((prev) => mergeSpanSizes(remapRanges(value, next, prev)));
    // 9.A5-tails-a: the DISPLAY seeds ride the same diff, so they stay
    // attached to their characters as the text is edited (never sent).
    setSeedFaces((prev) => mergeSpanFaces(remapRanges(value, next, prev)));
    setSeedSizes((prev) => mergeSpanSizes(remapRanges(value, next, prev)));
    setValue(next);
    // Always bump: when `next === value` React would otherwise skip the
    // render and leave the browser's raw DOM mutation in place.
    setRev((r) => r + 1);
    // Sanitizing can SHORTEN the text (a pasted CRLF becomes one space).
    pendingCaretRef.current = Math.max(0, Math.min(caret, Array.from(next).length));
  };
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
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    // Open with everything selected (the textarea's `.select()`), so typing
    // replaces the paragraph — the shipped behaviour every spec relies on.
    setEditorSelection(el, 0, Array.from(el.textContent ?? '').length);
    lastSelRef.current = { start: 0, end: Array.from(para.text).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 9.A5-tails-b: track the selection from the DOCUMENT's `selectionchange`.
  // React's `onSelect` is reliable for <input>/<textarea> but NOT for a
  // contentEditable, and `selectionchange` is the signal browsers actually
  // fire for caret/selection movement here. Without it the dual-role controls
  // read a stale range and every per-span action falls through to the
  // whole-paragraph branch — the round-35 failure in new clothing.
  // `captureSelection` is held in a ref so the listener never closes over
  // stale state.
  const captureRef = useRef(captureSelection);
  captureRef.current = captureSelection;
  useEffect(() => {
    const onSelectionChange = (): void => {
      const s = readEditorSelection(areaRef.current);
      if (!s) return; // selection elsewhere: keep the last one we saw
      lastSelRef.current = s;
      captureRef.current();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);
  // 9.A5-tails-b: restore the caret after a keystroke re-renders the segment
  // spans (the nodes the browser selection pointed into no longer exist).
  // useLayoutEffect so it lands before paint — no visible caret jump.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const pending = pendingCaretRef.current;
    if (pending !== null) {
      pendingCaretRef.current = null;
      setEditorSelection(el, pending, pending);
      lastSelRef.current = { start: pending, end: pending };
      lastHtmlRef.current = html;
      return;
    }
    // A RESTYLE also rebuilds the DOM (the new colour/weight/size is in the
    // html), which drops the browser selection. Put it back: the user's word
    // stays selected so a second control acts on the same range — and without
    // this, the transient collapse gets cached and the NEXT control falls
    // through to the whole-paragraph branch, silently restyling everything.
    const rebuilt = lastHtmlRef.current !== html;
    lastHtmlRef.current = html;
    const s = lastSelRef.current;
    if (s.end <= s.start) return; // nothing meaningful to put back
    if (rebuilt) {
      setEditorSelection(el, s.start, s.end);
      return;
    }
    // SELF-HEAL. A re-render can drop the selection even when the html is
    // unchanged (observed: the first `captureSelection` after selecting a word
    // left the caret collapsed on the editor element). The signature is
    // precise and worth keying on: a programmatic clobber anchors on the
    // ELEMENT, whereas a user clicking to place a caret always lands inside a
    // TEXT node. So restore only when the live selection sits on the element
    // itself — never fighting a deliberate caret placement.
    const live = window.getSelection();
    if (!live || live.rangeCount === 0) return;
    const range = live.getRangeAt(0);
    if (!el.contains(range.startContainer)) return;
    const onElement = range.startContainer.nodeType !== Node.TEXT_NODE;
    if (onElement && range.collapsed) setEditorSelection(el, s.start, s.end);
  });
  const spans = computeEditSpans(para.text, value, para.spans, para.runs[0]);
  const familyChanged = family !== '';
  const styleChanged = bold !== para.bold || italic !== para.italic;
  // A substitution (family picked or a style toggle changed) re-renders
  // EVERY character in a bundled Liberation face, so the members' own
  // coverage no longer applies — the live run-inventory check would
  // wrongly block (e.g. a char the original subset lacks but Liberation
  // has). Coverage the LIBERATION face lacks (CJK, astral) refuses
  // engine-side with a stated reason, surfaced as the standard edit
  // notice — the same honest boundary as convert.
  const substituting = familyChanged || styleChanged;
  // 9.K2 whole-paragraph features (caret case). Applying one re-renders every
  // character through the feature source — in place if the paragraph's own
  // font carries the feature, else the Libertinus switch — so, like a
  // substitution, the original run inventory no longer governs and the live
  // check would wrongly block (the Libertinus switch may encode a character
  // the original subset lacked). The engine refuses a genuinely unencodable
  // char with a stated reason, the same honest boundary as convert.
  const featuresChanged = smallCaps || alternates;
  const missing =
    substituting || featuresChanged
      ? []
      : paragraphUnencodable(value, spans, para.encodableByRun, para.sequencesByRun);
  const valid = missing.length === 0;
  const sizeChanged = Math.abs(size - para.fontSize) > 0.01;
  const colorChanged = color.toLowerCase() !== para.color.toLowerCase();
  // A5a: a per-span colour edit is a change even when nothing else moved.
  const seededSpanColors = seedSpanColors(para.spans, para.color);
  const spanColorsChanged =
    JSON.stringify(spanColors) !== JSON.stringify(seededSpanColors);
  const changed =
    value !== para.text ||
    sizeChanged ||
    colorChanged ||
    substituting ||
    featuresChanged ||
    spanColorsChanged ||
    spanFaces.length > 0 ||
    spanSizes.length > 0;
  // The restyle overrides sent with a commit — only fields the user
  // actually changed from the seed (unchanged size/colour/face stay the
  // paragraph's own, engine-side). On a substitution the style pair rides
  // along ABSOLUTE (a family-only swap of a visually-bold paragraph keeps
  // its weight).
  const restyleOpts = (extra?: ParagraphEditOpts): ParagraphEditOpts => {
    const o: ParagraphEditOpts = { ...extra };
    if (sizeChanged && size > 0) o.size = size;
    if (colorChanged) {
      const rgb = hexToRgb(color);
      if (rgb) o.color = rgb;
    }
    if (substituting) {
      if (familyChanged) o.family = family;
      o.bold = bold;
      o.italic = italic;
    }
    // 9.K2 whole-paragraph features ride their OWN param, NOT the substitution
    // path: the engine applies them in place when it can, so forcing a
    // bold/italic pair here would needlessly collapse the paragraph into a
    // Liberation weight. `alt_index` travels only with alternates.
    if (featuresChanged) {
      o.features = [...(smallCaps ? ['small_caps'] : []), ...(alternates ? ['salt'] : [])];
      if (alternates) o.alt_index = altIndex;
    }
    // A5a/A5b/A5c: send per-span colour, face, AND size entries (the engine
    // folds each field independently, so they ride the one span_styles list
    // with possibly-unaligned ranges). 9.K2 per-span features ride the face
    // entry (spanFacesToStyles emits small_caps/alternates on it).
    const perSpan = [
      ...spanColorsToStyles(spanColors),
      ...spanFacesToStyles(spanFaces),
      ...spanSizesToStyles(spanSizes),
    ];
    if (perSpan.length > 0) o.span_styles = perSpan;
    return o;
  };
  const finish = (): void => {
    if (valid && changed) settle(() => onCommit(value, restyleOpts()));
    else settle(onCancel);
  };
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
          // A4 split: Enter with the caret strictly INSIDE the textarea's
          // text splits there (code-point domain — the Array.from rule).
          // Caret at the end (the committed shape every prior spec uses)
          // falls through to the shipped commit.
          const ta = areaRef.current;
          const caret = readEditorSelection(ta); // code points already
          const cpLen = Array.from(value).length;
          if (
            ta &&
            (e.target === ta || ta.contains(e.target as Node)) &&
            caret &&
            caret.start === caret.end &&
            caret.start > 0 &&
            caret.start < cpLen
          ) {
            if (valid) {
              settle(() => onCommit(value, restyleOpts({ split_at: caret.start })));
            }
            return;
          }
          if (valid && changed) settle(() => onCommit(value, restyleOpts()));
          else if (!changed) settle(onCancel);
        } else if (
          e.key === 'Backspace' &&
          onMergePrev &&
          areaRef.current &&
          (e.target === areaRef.current || areaRef.current.contains(e.target as Node)) &&
          (() => {
            const c = readEditorSelection(areaRef.current);
            return c !== null && c.start === 0 && c.end === 0;
          })() &&
          value === para.text
        ) {
          // A4 merge: backspace at the very start of an UNCHANGED editor
          // joins into the previous paragraph (edits-then-merge would
          // silently drop the edits, so a dirty editor just no-ops here).
          e.preventDefault();
          settle(onMergePrev);
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
            title="With text selected, sizes the selection; otherwise the whole paragraph"
            value={sizeField}
            onChange={(e) => {
              setSizeField(e.target.value);
              const v = parseFloat(e.target.value);
              if (!Number.isFinite(v)) return; // empty/NaN: keep the field
              const clamped = Math.max(1, Math.min(1638, v));
              // A5c dual role: a PARTIAL selection sizes just that range
              // (per-span); a caret or whole-text selection sizes the whole
              // paragraph (the shipped A1 size).
              const sel = spanTarget();
              if (sel) {
                setSpanSizes((prev) => applySpanSize(prev, sel.start, sel.end, clamped));
              } else {
                setSize(clamped);
              }
            }}
          />
        </label>
        <label className="page-editpara-ctl">
          Colour
          <input
            type="color"
            data-testid="edit-para-color"
            value={/^#[0-9a-f]{6}$/i.test(colorField) ? colorField : '#000000'}
            title="With text selected, recolours the selection; otherwise the whole paragraph"
            onChange={(e) => {
              // A5a dual role: a PARTIAL selection recolours just that range
              // (per-span); a caret or whole-text selection recolours the
              // whole paragraph (the shipped A1 colour). spanTarget reads the
              // textarea's live selection, so it survives the picker's focus.
              const hex = e.target.value;
              setColorField(hex); // the swatch holds the pick either way
              const sel = spanTarget();
              if (sel) {
                setSpanColors((prev) => applySpanColor(prev, sel.start, sel.end, hex));
              } else {
                setColor(hex);
              }
            }}
          />
        </label>
        <label className="page-editpara-ctl">
          Font
          <select
            data-testid="edit-para-family"
            value={family}
            disabled={para.vertical}
            title={
              para.vertical
                ? 'Vertical text keeps its font — the bundled faces are horizontal'
                : "Replaces the paragraph's font with the chosen bundled face"
            }
            onChange={(e) => {
              // A5b dual role: a real family + a PARTIAL selection → per-span
              // face on that range; otherwise the shipped whole-paragraph
              // family swap.
              const fam = e.target.value as '' | 'serif' | 'sans' | 'mono';
              const sel = spanTarget();
              if (fam !== '' && sel) {
                // 9.A5-tails-a: PER SEGMENT, like the B/I toggles — each piece
                // of the selection keeps its own weight and slant and only the
                // family changes. (This shared the toggles' collapse bug:
                // it painted the selection-start's bold/italic over the lot.)
                setSpanFaces((prev) => setSpanFaceFamily(prev, shownFaces, sel.start, sel.end, fam));
              } else {
                setFamily(fam);
              }
            }}
          >
            <option value="">Keep original font</option>
            <option value="sans">Liberation Sans</option>
            <option value="serif">Liberation Serif</option>
            <option value="mono">Liberation Mono</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="edit-para-bold"
          className={`page-editpara-style${(faceField ? faceField.bold : bold) ? ' pressed' : ''}`}
          aria-pressed={faceField ? faceField.bold : bold}
          disabled={para.vertical}
          title={
            para.vertical
              ? 'Vertical text keeps its font — the bundled faces are horizontal'
              : 'Bold — substitutes the bundled bold face'
          }
          onClick={() => {
            // A5b dual role: a PARTIAL selection toggles bold on that range
            // (keeping its other axes); a caret or whole-text selection
            // toggles the whole paragraph (the shipped A3b).
            const sel = spanTarget();
            if (sel) {
              // 9.A5-tails-a: PER SEGMENT — each differently-faced piece of
              // the selection keeps its own family and slant and flips only
              // bold. (The shipped version read the START face and painted it
              // across everything, collapsing a mixed selection to one face.)
              // Computed over the SHOWN faces so it flips what the user sees,
              // and written into the overrides because an explicit toggle IS
              // the request to substitute.
              const target = !faceAt(sel.start).bold;
              setSpanFaces((prev) =>
                toggleSpanFaceAxis(prev, shownFaces, sel.start, sel.end, 'bold', target),
              );
              // The selection does not change, so captureSelection will not
              // re-fire — refresh the pressed look here (keeping the feature
              // axes, which this toggle does not touch).
              setFaceField((f) => ({
                bold: target,
                italic: f ? f.italic : italic,
                smallCaps: f ? f.smallCaps : smallCaps,
                alternates: f ? f.alternates : alternates,
              }));
            } else {
              setBold((b) => !b);
            }
          }}
        >
          B
        </button>
        <button
          type="button"
          data-testid="edit-para-italic"
          className={`page-editpara-style page-editpara-style-i${(faceField ? faceField.italic : italic) ? ' pressed' : ''}`}
          aria-pressed={faceField ? faceField.italic : italic}
          disabled={para.vertical}
          title={
            para.vertical
              ? 'Vertical text keeps its font — the bundled faces are horizontal'
              : 'Italic — substitutes the bundled italic face'
          }
          onClick={() => {
            // A5b dual role: PARTIAL → per-span italic on that range; caret
            // or whole-text → the shipped whole-paragraph toggle. Per SEGMENT
            // (9.A5-tails-a) — the bold button's comment has the rationale.
            const sel = spanTarget();
            if (sel) {
              const target = !faceAt(sel.start).italic;
              setSpanFaces((prev) =>
                toggleSpanFaceAxis(prev, shownFaces, sel.start, sel.end, 'italic', target),
              );
              setFaceField((f) => ({
                bold: f ? f.bold : bold,
                italic: target,
                smallCaps: f ? f.smallCaps : smallCaps,
                alternates: f ? f.alternates : alternates,
              }));
            } else {
              setItalic((i) => !i);
            }
          }}
        >
          I
        </button>
        {/* 9.K2 OpenType features — dual role like B/I. A partial selection
            applies the feature to that range (per span, riding the face
            entry); a caret or whole-text selection applies it to the whole
            paragraph. Disabled for vertical text: applying a feature switches
            to a horizontal bundled face, which the engine refuses. */}
        <button
          type="button"
          data-testid="edit-para-smallcaps"
          className={`page-editpara-style${
            (faceField ? faceField.smallCaps : smallCaps) ? ' pressed' : ''
          }`}
          aria-pressed={faceField ? faceField.smallCaps : smallCaps}
          disabled={para.vertical}
          title={
            para.vertical
              ? 'Vertical text keeps its font — the bundled faces are horizontal'
              : 'Small caps — uses the font’s own if it has them, else Libertinus Serif'
          }
          onClick={() => {
            const sel = spanTarget();
            if (sel) {
              const target = !faceAt(sel.start).smallCaps;
              setSpanFaces((prev) =>
                setSpanFaceFeature(prev, shownFaces, sel.start, sel.end, 'smallCaps', target),
              );
              setFaceField((f) => ({
                bold: f ? f.bold : bold,
                italic: f ? f.italic : italic,
                smallCaps: target,
                alternates: f ? f.alternates : alternates,
              }));
            } else {
              setSmallCaps((s) => !s);
            }
          }}
        >
          SC
        </button>
        <button
          type="button"
          data-testid="edit-para-alternates"
          className={`page-editpara-style${
            (faceField ? faceField.alternates : alternates) ? ' pressed' : ''
          }`}
          aria-pressed={faceField ? faceField.alternates : alternates}
          disabled={para.vertical}
          title={
            para.vertical
              ? 'Vertical text keeps its font — the bundled faces are horizontal'
              : 'Stylistic alternates (salt) — uses the font’s own if it has them, else Libertinus Serif'
          }
          onClick={() => {
            const sel = spanTarget();
            if (sel) {
              const target = !faceAt(sel.start).alternates;
              setSpanFaces((prev) =>
                setSpanFaceFeature(
                  prev,
                  shownFaces,
                  sel.start,
                  sel.end,
                  'alternates',
                  target,
                  altIndex,
                ),
              );
              setFaceField((f) => ({
                bold: f ? f.bold : bold,
                italic: f ? f.italic : italic,
                smallCaps: f ? f.smallCaps : smallCaps,
                alternates: target,
              }));
            } else {
              setAlternates((a) => !a);
            }
          }}
        >
          Alt
        </button>
        {(faceField ? faceField.alternates : alternates) && (
          <label className="page-editpara-ctl">
            #
            <input
              type="number"
              data-testid="edit-para-altindex"
              min={0}
              max={99}
              step={1}
              value={altIndex}
              title="Which stylistic alternate to use, when the font offers several"
              onChange={(e) => {
                const v = Math.max(0, Math.min(99, Math.trunc(parseFloat(e.target.value) || 0)));
                setAltIndex(v);
                // Per-span: re-apply the alternate at the new index over a
                // selection that already has alternates on (leave a plain
                // selection untouched — the index picker is not a way to turn
                // the feature on).
                const sel = spanTarget();
                if (sel && faceAt(sel.start).alternates) {
                  setSpanFaces((prev) =>
                    setSpanFaceFeature(prev, shownFaces, sel.start, sel.end, 'alternates', true, v),
                  );
                }
              }}
            />
          </label>
        )}
      </div>
      {/* 9.A5-tails-b RICH SURFACE. One contentEditable: the styled text the
          user sees IS the input, so the caret, the selection and the line
          wrapping are computed by the browser from these very glyphs and agree
          BY CONSTRUCTION. It replaces a mirror overlay (styled backdrop +
          transparent textarea) which positioned the caret from a SEPARATE
          uniform-metric textarea — measurably wrong: Arial Bold runs +2.32px
          on "Hello" and +10.83px on "The quick brown fox" at 14px, so the
          caret drifted from the visible glyphs after any bolded word, and
          per-span size (+9..+36px) and substituted families could never be
          rendered at all.

          The DOM is a VIEW rendered from `value` every keystroke — never the
          source of truth — so no pasted markup can enter the value: input is
          read as text, sanitized, and re-rendered. */}
      <div className="page-editpara-inputwrap">
        <div
          ref={areaRef}
          data-testid="edit-para-input"
          className={`page-editpara-rich${valid ? '' : ' invalid'}`}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Paragraph text"
          spellCheck={false}
          style={{
            fontSize: `${fontPx}px`,
            lineHeight: 1.25,
            maxHeight: `${Math.min(12, para.lineCount + 1) * fontPx * 1.25 + 8}px`,
          }}
          onInput={(e) => {
            // Mid-IME the browser owns the DOM; sync when composition ends.
            if (composingRef.current) return;
            const el = e.currentTarget;
            // Read the caret BEFORE React re-renders the segments (the DOM
            // nodes it points into are about to be replaced).
            applyText(sanitizeParagraphInput(el.textContent ?? ''), readCaret(el));
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const el = e.currentTarget;
            applyText(sanitizeParagraphInput(el.textContent ?? ''), readCaret(el));
          }}
          onPaste={(e) => {
            // Plain text only — styles come from the controls, never from
            // pasted content, and the value must stay a plain string.
            e.preventDefault();
            const text = sanitizeParagraphInput(e.clipboardData.getData('text/plain'));
            const sel = liveSel();
            const chars = Array.from(value);
            const next = sanitizeParagraphInput(
              chars.slice(0, sel.start).join('') + text + chars.slice(sel.end).join(''),
            );
            applyText(next, sel.start + Array.from(text).length);
          }}
          onSelect={captureSelection}
          onKeyUp={captureSelection}
          onMouseUp={captureSelection}
          /* Enter/Escape handled at the wrapper (works from every control).
             Invalid+changed holds the editor open there — Enter never
             silently discards or commits the inexpressible. */
          /* ONE opaque html string, never React children: the browser edits
             this DOM directly (merging text nodes, deleting spans), so a React
             child reconcile would removeChild nodes that no longer exist and
             throw. Family and size RENDER here — the Liberation faces were
             chosen for metric compatibility with Arial/Times/Courier (B1), so
             the browser stand-ins preview the substituted face honestly; the
             committed page remains the fidelity authority. */
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {!valid && (
        <div className="page-edittext-error" data-testid="edit-para-error" aria-live="polite">
          This document's font does not contain {missing.map((c) => `'${c}'`).join(' ')}
          {/* 9.B4b: no fallback for vertical — the engine refuses convert
              (the bundled fallback face is horizontal), so the offer would
              only ever produce an error notice. */}
          {!para.vertical && (
            <button
              type="button"
              data-testid="edit-para-convert"
              className="page-edittext-convert"
              onClick={() => settle(() => onCommit(value, restyleOpts({ convert: true })))}
            >
              Use a compatible font
            </button>
          )}
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
  const missing = unencodableChars(value, run.encodable, run.sequences);
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
