import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import ImageGroupOverlay from './ImageGroupOverlay';
import type { EditTextRun } from '../../lib/edit-text';
import { unencodableChars } from '../../lib/edit-text';
import type { EditParagraph, ParagraphEditOpts , MergeRestyle } from '../../lib/edit-paragraphs';
import {
  getSystemFonts,
  pickFace,
  subscribeSystemFonts,
  type SystemFontListing,
} from '../../lib/system-fonts';
import { parseRichHtml, type RichPasteResult } from '../../lib/rich-paste';
import {
  applySpanColor,
  applySpanFace,
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
  relaxUnencodableSpans,
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
import {
  DEFAULT_MEASURE_SCALE,
  formatArea,
  formatDistance,
  measureRatioLabel,
  measureUnitsPerPoint,
  polylineLengthPts,
  ringAreaPts2,
  type MeasureScale,
} from '../../lib/measure';
import { resolveStampTokens } from '../../lib/stamp-library';
import { getSettings } from '../../lib/app-settings';
import {
  buildSnapIndex,
  constrainAngle,
  EMPTY_SNAP_INDEX,
  objectSnapPoints,
  snapDelta,
  snapPoint,
  type SnapGuide,
  type SnapHit,
  type SnapIndex,
  type SnapOptions,
  type SnapPath,
  type SnapPoint,
  type SnapType,
} from '../../lib/snap';
import { gridForPage, gridLines } from '../../lib/rulers';
import { guidesOnPage, isOffPage, toSnapGuides, type GuideAxis, type PageGuide } from '../../lib/guides';
import type { SnapSettings } from '../../lib/snap-settings';
import type { PageSnapGeometry } from '../../lib/snap-geometry';
import {
  isTransformable,
  isResizable,
  translated,
  translatedBy,
  resized,
  recomputedMeasureNote,
  hasVertexHandles,
  vertexDragged,
  cloudBumps,
  paddedPointsBbox,
  eraseFromStrokes,
  strokesBbox,
  type AnnotationTransform,
  type ResizeHandle,
} from '../../lib/annotation-manipulation';
import type { ShapeType } from '../../state/types';
import { useTranslation } from 'react-i18next';
import i18next, { tChrome, tNumber, type UiKey } from '../../i18n';

// Measure overlays draw in amber — legible over both white paper and the
// annotation palette's blues/yellows, and distinct from ink's default.
const MEASURE_COLOR = '#f59e0b';

// N11 slice B: the closest two grid lines may be drawn, in CSS pixels. Below
// this the grid is a grey wash over the drawing rather than a reading aid, so
// that axis is not drawn at all — snapping to it is unaffected.
const GRID_MIN_PX = 4;

// N11 slice A: the snap marker's per-type name key. A distinct GLYPH per type
// (below) plus the name in a badge — a colour-only distinction would be
// invisible to a reader who cannot tell them apart, and the badge is what
// the aria-live announcement reads out.
const SNAP_TYPE_KEY: Record<SnapType, UiKey> = {
  endpoint: 'canvas.snap.type.endpoint',
  intersection: 'canvas.snap.type.intersection',
  midpoint: 'canvas.snap.type.midpoint',
  center: 'canvas.snap.type.center',
  guide: 'canvas.snap.type.guide',
  grid: 'canvas.snap.type.grid',
  edge: 'canvas.snap.type.edge',
};

/** The snap marker's glyph: square = endpoint, × = intersection, triangle =
 * midpoint, circle = centre, diamond = guide, dot = grid, chevron = edge.
 * Drawn in its own 16×16 viewBox so the shapes stay undistorted whatever the
 * page's aspect ratio (the annotation overlays' 0..1 viewBox would squash
 * them). */
function SnapGlyph({ type }: { type: SnapType }): React.JSX.Element {
  const common = { fill: 'none', stroke: MEASURE_COLOR, strokeWidth: 1.6 } as const;
  switch (type) {
    case 'endpoint':
      return <rect x={3.5} y={3.5} width={9} height={9} {...common} />;
    case 'intersection':
      return (
        <g {...common}>
          <line x1={3} y1={3} x2={13} y2={13} />
          <line x1={13} y1={3} x2={3} y2={13} />
        </g>
      );
    case 'midpoint':
      return <polygon points="8,3 13.5,12.5 2.5,12.5" {...common} />;
    case 'center':
      return <circle cx={8} cy={8} r={5} {...common} />;
    case 'guide':
      return <polygon points="8,2.5 13.5,8 8,13.5 2.5,8" {...common} />;
    case 'grid':
      return <circle cx={8} cy={8} r={2.5} fill={MEASURE_COLOR} />;
    default:
      return <polyline points="4,4 11,8 4,12" {...common} />;
  }
}
// Drawing shapes default to review red (the king's shape default).
const SHAPE_COLOR = '#e0393e';

export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StampPreset {
  /** Stable id for the BUILT-IN presets (absent on user-made stamps, which
   * are identified by their own `id` in the library). N12 slice C: the label
   * localizes — it is the text stamped INTO the document — so nothing may
   * derive identity, a test id, or a comparison from it. */
  id?: string;
  label: string;
  color: string;
  /** Custom IMAGE stamps (parity map § 2): the raster as a data URL plus its
   * height/width ratio — placement sizes the box so the image lands
   * undistorted, and the commit embeds it as the /Stamp appearance. */
  imageData?: string;
  aspect?: number;
}

export const STAMP_PRESETS: StampPreset[] = [
  { id: 'approved', label: 'APPROVED', color: '#2fbf71' },
  { id: 'rejected', label: 'REJECTED', color: '#e0393e' },
  { id: 'draft', label: 'DRAFT', color: '#8a8a93' },
  { id: 'confidential', label: 'CONFIDENTIAL', color: '#e0393e' },
  { id: 'reviewed', label: 'REVIEWED', color: '#2f6fed' },
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
// N5: pen lifts within this window extend the previous ink annotation (a
// signature is one annotation). Long enough for a deliberate lift-and-cross,
// short enough that a new thought starts a new drawing.
const INK_MERGE_WINDOW_MS = 2500;

function defaultColorFor(kind: PageAnnotation['kind']): string {
  if (kind === 'freetext') return FREETEXT_COLOR;
  if (kind === 'ink') return INK_COLOR;
  if (kind === 'measure') return MEASURE_COLOR;
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
  onFormButton,
}: {
  widget: OverlayWidget;
  rotation: 0 | 90 | 180 | 270;
  formsMode: boolean;
  pending: FormFieldValue | undefined;
  fontPx: number;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  onFormButton: (path: string, fieldName: string, action: import('../../lib/forms').ButtonAction | null) => void;
}): React.JSX.Element | null {
  useTranslation();
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
        title={tChrome('canvas.widget.pending', { field: widget.fieldName })}
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
          title={tChrome('canvas.widget.signHere', { field: widget.fieldName })}
          onClick={(e) => {
            stop(e);
            onSignFieldRequest(widget.path, widget.fieldName);
          }}
        >
          <span>{tChrome('canvas.widget.badge.signHere')}</span>
        </button>
      );
    }
    return (
      <div
        {...common}
        className={'page-form-widget page-form-sig' + (widget.sigFilled ? ' signed' : '')}
        style={style}
        title={tChrome(
          widget.sigFilled ? 'canvas.widget.signed' : 'canvas.widget.readonlySig',
          { field: widget.fieldName },
        )}
      >
        <span>
          {tChrome(
            widget.sigFilled ? 'canvas.widget.badge.signed' : 'canvas.widget.badge.signature',
          )}
        </span>
      </div>
    );
  }
  if (widget.type === 'button') {
    // F8: pushbuttons ACT — the page raster already draws the button's own
    // face, so the overlay is a transparent click surface. What the click
    // does is the classified /A action; App runs reset for real and stays
    // honest about the rest (no shell-open, no JS engine).
    const label =
      widget.action?.kind === 'reset'
        ? tChrome('canvas.widget.action.reset')
        : widget.action?.kind === 'uri'
          ? tChrome('canvas.widget.action.uri', { uri: widget.action.uri })
          : widget.action
            ? tChrome('canvas.widget.action.other', { kind: widget.action.kind })
            : tChrome('canvas.widget.action.none');
    return (
      <button
        {...common}
        type="button"
        className="page-form-widget page-form-button"
        style={style}
        title={tChrome('canvas.widget.button', { field: widget.fieldName, action: label })}
        onClick={(e) => {
          stop(e);
          onFormButton(widget.path, widget.fieldName, widget.action ?? null);
        }}
      />
    );
  }
  if (!widget.editable) {
    return (
      <div
        {...common}
        className="page-form-widget page-form-locked"
        style={style}
        title={tChrome('canvas.widget.readonly', { field: widget.fieldName })}
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
        title={tChrome('canvas.widget.radio', {
          field: widget.fieldName,
          option: widget.radioOption ?? tChrome('canvas.widget.radioUnmapped'),
        })}
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
  /** Measure modes (parity map § 2): the scale ratio, whether a finished
   * measurement lands as an ink annotation, and where the value reports
   * (the secondary toolbar's readout). */
  measureScale?: MeasureScale;
  measureLeaveMarkup?: boolean;
  onMeasureResult?: (text: string) => void;
  /** N11 slice A: this page's snap geometry (display-normalized at the page's
   * BAKED orientation, like every other engine-derived overlay — the pending
   * rotation is applied here at query time) plus the live snap preferences.
   * Absent or disabled means every gesture behaves exactly as it did before
   * snapping existed, which is the guarantee the gesture specs assert. */
  snapGeometry?: PageSnapGeometry;
  snapSettings?: SnapSettings;
  /** N11 slice B: this page's ruler guides, in the frame each was drawn in
   * (they project here, the `projectMarkRect` precedent). Pre-filtered by
   * page upstream, like every other per-page overlay. */
  guides?: readonly PageGuide[];
  /** Commit a guide drag. The moved guide is re-stamped into the CURRENT
   * display frame — a moved guide is a freshly placed one, so its axis and
   * `rotationAtDraw` come from where it landed rather than from where it
   * originally came off the ruler. */
  onMoveGuide?: (
    guideId: string,
    axis: GuideAxis,
    pos: number,
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** Dragged past the page's edge — the king's "drag it back to the ruler". */
  onRemoveGuide?: (guideId: string) => void;
  // Pending redaction marks on this page (transient view state — see
  // lib/redaction.ts); undefined when none.
  redactionMarks?: RedactionMark[];
  /** Edit-mode image placements (7.1), display-normalized at baked
   * orientation — pending rotation is applied at render like marks. */
  editImages?: EditImagePlacement[];
  /** P7 multi-select: every selected index on this page (single = one). */
  editSelectedIndexes?: number[] | null;
  onSelectEditImage?: (pageId: string, index: number, additive?: boolean) => void;
  /** P7: the group transform context for THIS page (N>1, pre-filtered by
   * pageId upstream) + its multi-target commit. */
  editImageGroup?: import('./ImageGroupOverlay').ImageGroupCtx | null;
  onCommitImageGroupTransform?: (
    pageId: string,
    targets: { index: number; matrix: number[] }[],
  ) => void;
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
  /** P7 slice E: the overlay's gradient-mask dot commit. */
  onCommitImageMask?: (
    pageId: string,
    index: number,
    mask: import('../../lib/edit-images').EditImageMaskParam,
  ) => void;
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
  /** T14: run-scoped size/color restyle from the run editor. */
  onRestyleTextEdit?: (
    pageId: string,
    index: number,
    style: { size?: number; color?: [number, number, number] },
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
  onMergeParagraphPrev?: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  onMergeParagraphNext?: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
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
  // F8: a pushbutton widget's click, with its classified /A action.
  onFormButton: (path: string, fieldName: string, action: import('../../lib/forms').ButtonAction | null) => void;
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
  cropPlacement?: SignaturePlacement | null;
  onClearCropPlacement?: () => void;
  onSetAddTextRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearAddTextPlacement: () => void;
  // P5b: a crop band. Display-normalised like every other banded gesture,
  // with the rotation AT DRAW — the insets are computed against the page as
  // the user saw it, so a landscape scan trims the edges they pointed at.
  onSetCropRect?: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
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
  // Which figure the armed 'shape' mode draws (the secondary toolbar picker).
  shapeType: ShapeType;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  // Click-selection for the properties bar (I.6) + manipulation (rung 1).
  // Select tool only — armed modes keep their band/stroke gestures untouched.
  // Selection is SAME-PAGE (multi via ctrl-click / ctrl-marquee); ids are
  // globally unique so the cell checks membership without a page key.
  // null clears; `additive` is the ctrl/cmd state of the gesture.
  selectedAnnotationIds: readonly string[];
  onSelectAnnotation: (
    docId: string,
    pageId: string,
    annotationId: string | null,
    additive: boolean,
  ) => void;
  // One gesture = one dispatch = one undo step (move, resize, nudge, align).
  onTransformAnnotations: (docId: string, edits: AnnotationTransform[]) => void;
  // Rung 3: the calibration drag's measured span (PDF points) — the toolbar
  // turns it into a ratio once the user states the real value.
  onCalibrate: (lengthPts: number) => void;
  // Rung 3: right-click on a measurement body (Select tool) — the view opens
  // the recalibrate popover at the screen point.
  onMeasureContextMenu: (docId: string, pageId: string, annotationId: string, x: number, y: number) => void;
  // Ctrl-marquee result — the view decides how it merges into the selection.
  onMarqueeSelect: (docId: string, pageId: string, annotationIds: string[], additive: boolean) => void;
  // N3 marquee zoom: band in DISPLAY page-normalized coords; the reading
  // view zooms until it fills the pane. Optional — the board has no zoom.
  onZoomToRect?: (pageId: string, rect: { x: number; y: number; w: number; h: number }) => void;
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
  useTranslation();
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
  if (obj.kind === 'shading') {
    // P8 slice D: a gradient fill has no flat colour or width to restyle —
    // move/delete apply; the engine names the same refusal as belt.
    return (
      <div
        className={className}
        data-testid={testid}
        style={style}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span
          className="page-editvec-ctl"
          title={tChrome('canvas.editvec.shadingTitle')}
        >
          {tChrome('canvas.editvec.shading')}
        </span>
      </div>
    );
  }
  return (
    <div className={className} data-testid={testid} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {obj.kind !== 'stroke' && (
        <label className="page-editvec-ctl" title={tChrome('canvas.editvec.fillTitle')}>
          {tChrome('canvas.editvec.fill')}
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
          <label className="page-editvec-ctl" title={tChrome('canvas.editvec.strokeTitle')}>
            {tChrome('canvas.editvec.stroke')}
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
          <label className="page-editvec-ctl" title={tChrome('canvas.editvec.widthTitle')}>
            {tChrome('canvas.editvec.width')}
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
  measureScale,
  measureLeaveMarkup = true,
  onMeasureResult,
  snapGeometry,
  snapSettings,
  guides,
  onMoveGuide,
  onRemoveGuide,
  redactionMarks,
  editImages,
  editSelectedIndexes,
  editImageGroup,
  onCommitImageGroupTransform,
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
  onCommitImageMask,
  onSelectEditImage,
  editTextRuns,
  editTextSelectedIndex,
  editingTextIndex,
  onSelectEditText,
  onOpenTextEditor,
  onCommitTextEdit,
  onRestyleTextEdit,
  onCancelTextEdit,
  editParagraphs,
  editParaSelectedIndex,
  editingParaIndex,
  onSelectEditParagraph,
  onOpenParagraphEditor,
  onCommitParagraphEdit,
  onCancelParagraphEdit,
  onMergeParagraphPrev,
  onMergeParagraphNext,
  signaturePlacement,
  findMatch,
  findWords,
  formWidgets,
  formValues,
  onSetFormValue,
  onSignFieldRequest,
  onFormButton,
  newFieldPlacement,
  onSetNewFieldRect,
  addTextPlacement,
  cropPlacement,
  onClearCropPlacement,
  onSetAddTextRect,
  onSetCropRect,
  onClearAddTextPlacement,
  onAddImageRect,
  onClearNewFieldPlacement,
  onSelectPage,
  onOpenPage,
  onPageContextMenu,
  onPagePointerDown,
  shapeType,
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
  onZoomToRect,
  onAddRedactionMark,
  onRemoveRedactionMark,
  onSetSignaturePlacement,
  onClearSignaturePlacement,
}: PageCellProps): React.JSX.Element {
  useTranslation();
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
  // In-progress measurement (parity map § 2): committed vertices + the live
  // cursor, display-normalized like ink. Distance is a drag; perimeter/area
  // accumulate click-vertices until a double-click finishes.
  const [measurePts, setMeasurePts] = useState<number[] | null>(null);
  const [measureCursor, setMeasureCursor] = useState<{ x: number; y: number } | null>(null);
  const measureSeqActive = useRef(false);

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

  // ── Snapping (N11 slice A) ────────────────────────────────────────────
  // Every gesture's client→page conversion goes through `pagePoint` below,
  // and snapping is a PARAMETER of that one function. Ten sites used to do
  // this arithmetic inline; that is the `ui.tool` situation verbatim — "fixed
  // four times at four dispatchers before it was fixed once at the rule" —
  // so a gesture added next year gets snapping by construction rather than by
  // someone remembering.
  //
  // Frames: engine geometry arrives display-normalized at the page's BAKED
  // orientation and is projected by the EFFECTIVE `page.rotation` (the same
  // `rotateNormalizedRect(vec.rect, page.rotation)` the vector overlay uses);
  // annotations are stored in the page.rotation frame and project by
  // `viewRotation`. Both land in the DISPLAY frame, which is the frame the
  // pointer and every one of the ten sites work in.
  // The DISPLAYED page size in PDF points (axes swapped at 90/270; `page`
  // already carries the effective rotation). Defined up here rather than beside
  // the measure tool because slice B's GRID needs the same pair — a grid
  // spacing is a length on paper, and this is what turns it into a fraction of
  // the page.
  const measDispW = page.rotation === 90 || page.rotation === 270 ? page.height : page.width;
  const measDispH = page.rotation === 90 || page.rotation === 270 ? page.width : page.height;
  const measScale = measureScale ?? DEFAULT_MEASURE_SCALE;

  const snapArmed = snapSettings?.enabled === true;
  // The grid exists independently of whether it is DRAWN: "snap to a grid you
  // cannot see" is an ordinary way to draft, and the king separates Show Grid
  // from Snap to Grid for exactly that reason. `types.grid` gates the snap;
  // `showGrid` gates the ink.
  const gridCfg = snapSettings?.grid;
  const grid = useMemo(
    () => (gridCfg ? gridForPage(gridCfg, measScale, measDispW, measDispH) : null),
    [gridCfg, measScale, measDispW, measDispH],
  );
  // Guides project through the rotation they were drawn in — the same rule a
  // redaction mark follows, and for the same reason: the paper can turn under
  // them, from Rotate View or a pending page-tier rotation.
  const shownGuides = useMemo(
    () =>
      snapSettings?.showGuides === false
        ? []
        : guidesOnPage(guides ?? [], page.id, page.rotation),
    [guides, page.id, page.rotation, snapSettings?.showGuides],
  );
  const snapGuides = useMemo<SnapGuide[]>(() => toSnapGuides(shownGuides), [shownGuides]);
  /**
   * The grid's LINE positions, or null when there is nothing to draw.
   *
   * Density is the whole subtlety: a 1 mm grid zoomed out is a grey wash that
   * hides the drawing it exists to help you read, so an axis whose lines would
   * land closer together than `GRID_MIN_PX` is simply not drawn. SNAPPING is
   * unaffected — quantization needs no line list — which is the honest split:
   * the aid stops being drawn when it stops being legible, it does not stop
   * working.
   */
  const gridOverlay = useMemo<{ xs: number[]; ys: number[] } | null>(() => {
    if (!snapSettings?.showGrid || !grid) return null;
    const xs = grid.spacingX * displayWidth >= GRID_MIN_PX ? gridLines(grid.spacingX, grid.originX) : [];
    const ys = grid.spacingY * pageHeight >= GRID_MIN_PX ? gridLines(grid.spacingY, grid.originY) : [];
    return xs.length > 0 || ys.length > 0 ? { xs, ys } : null;
  }, [snapSettings?.showGrid, grid, displayWidth, pageHeight]);

  // A live guide drag, previewed locally and committed on release — the same
  // shape every other canvas gesture uses (window listeners, one dispatch).
  const [guideDrag, setGuideDrag] = useState<{ id: string; axis: GuideAxis; pos: number } | null>(
    null,
  );
  const cancelGuideDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelGuideDrag.current?.(), []);
  const handleGuideDown = (id: string, axis: GuideAxis, e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).closest('[data-page-id]') as HTMLElement | null;
    if (!cell) return;
    // Through the choke point like everything else — but UNCLAMPED, because
    // "dragged past the edge" is the delete gesture and a clamped point can
    // never express it. It does not snap: a guide IS a snap target, and one
    // that jumped onto another would make two guides impossible to separate.
    const posOf = (cx: number, cy: number): number => {
      const p = pagePoint(cell, cx, cy, { snap: false, unclamped: true });
      return axis === 'x' ? p.x : p.y;
    };
    let latest = posOf(e.clientX, e.clientY);
    setGuideDrag({ id, axis, pos: latest });
    const onMove = (ev: PointerEvent): void => {
      latest = posOf(ev.clientX, ev.clientY);
      setGuideDrag({ id, axis, pos: latest });
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      cancelGuideDrag.current = null;
      setGuideDrag(null);
      if (!commit) return;
      if (isOffPage(latest)) onRemoveGuide?.(id);
      // Re-stamped into the CURRENT display frame: a moved guide is a freshly
      // placed one, so it takes today's axis and rotation rather than
      // carrying the frame it originally came off the ruler in.
      else onMoveGuide?.(id, axis, latest, page.rotation);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelGuideDrag.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  };
  const snapOptions: SnapOptions = {
    radiusPx: snapSettings?.radiusPx ?? 0,
    viewW: displayWidth,
    viewH: pageHeight,
    types: snapSettings?.types ?? ({} as SnapOptions['types']),
    guides: snapGuides,
    grid,
  };
  const pageSnapPaths = useMemo<SnapPath[]>(() => {
    if (!snapArmed || !snapGeometry) return [];
    const rot = page.rotation;
    if (rot === 0) return snapGeometry.paths;
    return snapGeometry.paths.map((p) => ({
      subpaths: p.subpaths.map((s) => rotateNormalizedPoints([...s], rot)),
      closed: p.closed,
    }));
  }, [snapArmed, snapGeometry, page.rotation]);
  // Live markup is a snap source too — the king snaps to page content only,
  // and snapping to the markup you already placed is a plus-extra that costs
  // nothing (no engine call, the geometry is already in hand). Keyed by
  // annotation id so a DRAGGED object can be excluded from its own targets.
  const markupSnapPaths = useMemo<Map<string, SnapPath>>(() => {
    const out = new Map<string, SnapPath>();
    if (!snapArmed) return out;
    for (const a of page.annotations ?? []) {
      const b = viewRotation === 0 ? a : rotateNormalizedRect(a, viewRotation);
      const subpaths: number[][] = [
        [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h],
      ];
      const closed: boolean[] = [true];
      if (a.points && a.points.length >= 4) {
        subpaths.push(
          viewRotation === 0 ? [...a.points] : rotateNormalizedPoints([...a.points], viewRotation),
        );
        closed.push(false);
      }
      for (const stroke of a.strokes ?? []) {
        if (stroke.length < 4) continue;
        subpaths.push(
          viewRotation === 0 ? [...stroke] : rotateNormalizedPoints([...stroke], viewRotation),
        );
        closed.push(false);
      }
      out.set(a.id, { subpaths, closed });
    }
    return out;
  }, [snapArmed, page.annotations, viewRotation]);
  const snapIndex = useMemo<SnapIndex>(
    () =>
      snapArmed
        ? buildSnapIndex(pageSnapPaths, [...markupSnapPaths.values()])
        : EMPTY_SNAP_INDEX,
    [snapArmed, pageSnapPaths, markupSnapPaths],
  );
  /** The index a MANIPULATION gesture uses: the same targets minus the
   * objects being dragged. Without the exclusion a moved corner snaps to
   * where that same corner started, and the object refuses to leave. */
  const snapIndexExcluding = (ids: readonly string[]): SnapIndex => {
    if (!snapArmed) return EMPTY_SNAP_INDEX;
    const keep: SnapPath[] = [];
    for (const [id, path] of markupSnapPaths) if (!ids.includes(id)) keep.push(path);
    return buildSnapIndex(pageSnapPaths, keep);
  };

  // The live marker: pure VIEW state, never the page tier (the redaction-mark
  // rule). Tab advances the cycle while a gesture is live; leaving the radius
  // resets it, so pressing Tab as many times as there are candidates lands
  // back on the first.
  const [snapMarker, setSnapMarker] = useState<SnapHit | null>(null);
  const snapCycleRef = useRef(0);
  const gestureLive = useRef(false);
  useEffect(() => {
    if (!snapArmed) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !gestureLive.current) return;
      e.preventDefault();
      e.stopPropagation();
      snapCycleRef.current += 1;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [snapArmed]);
  const publishSnap = (hit: SnapHit | null): void => {
    setSnapMarker((prev) =>
      prev && hit && prev.type === hit.type && prev.x === hit.x && prev.y === hit.y ? prev : hit,
    );
  };
  // The angle-constrain ANCHOR (slice B): the point Shift measures from — a
  // drag's start, or a vertex sequence's last committed vertex. ONE owner, set
  // by whichever gesture is live and cleared with it, so a new gesture can
  // never inherit a stale anchor and a gesture with no anchor (the generic
  // band, a placement click) simply cannot constrain.
  const constrainAnchor = useRef<SnapPoint | null>(null);
  const endSnapGesture = (): void => {
    gestureLive.current = false;
    snapCycleRef.current = 0;
    constrainAnchor.current = null;
    setSnapMarker(null);
  };

  interface PagePointOpts {
    /** false for gestures that must never snap: a freehand stroke (snapping
     * every sample would deform it) and a SELECTION marquee (a selection is
     * not a placement). */
    snap?: boolean;
    /** Alt suspends snapping for the remainder of the gesture — read off the
     * event rather than tracked through key listeners, so a lost keyup or a
     * webview swallowing Alt can never strand the suspension. Independent of
     * Shift (angle constrain), so the two compose. */
    suspend?: boolean;
    /** Shift holds the segment to the nearest angle increment, measured from
     * `constrainAnchor`. Independent of the snap MASTER toggle: a drawing
     * constraint is not a snap, and the king's Shift works with snapping off
     * exactly as it does with it on. */
    constrain?: boolean;
    /** A manipulation gesture's own index (the object excluded). */
    index?: SnapIndex;
    /** Skip the 0..1 clamp. Only the GUIDE drag wants this: "dragged past the
     * page edge" is how a guide is deleted, and a clamped point cannot say
     * it. Every placement gesture keeps the clamp. */
    unclamped?: boolean;
  }

  /** Shift's constraint, applied to a point that did NOT snap. An explicit
   * geometric target beats a constraint when both are available (the king's
   * precedence), which is why every caller runs the snap first. */
  const constrained = (p: { x: number; y: number }, on: boolean | undefined): { x: number; y: number } => {
    const from = constrainAnchor.current;
    if (!on || !from) return p;
    return constrainAngle(
      from,
      p,
      snapSettings?.angleDeg ?? 0,
      displayWidth,
      pageHeight,
    );
  };

  /**
   * THE choke point. Client coordinates → a display-normalized page point,
   * snapped when snapping is armed.
   */
  const pagePoint = (
    el: HTMLElement,
    cx: number,
    cy: number,
    o?: PagePointOpts,
  ): { x: number; y: number; snap: SnapHit | null } => {
    const rect = el.getBoundingClientRect();
    const fx = (cx - rect.left) / rect.width;
    const fy = (cy - rect.top) / rect.height;
    const raw = o?.unclamped
      ? { x: fx, y: fy }
      : { x: Math.max(0, Math.min(1, fx)), y: Math.max(0, Math.min(1, fy)) };
    if (!snapArmed || o?.snap === false || o?.suspend) {
      // Unconditional, deliberately: a window listener holds the closure from
      // the render the gesture STARTED in, so a `if (snapMarker)` guard here
      // reads a stale value and can strand the marker on screen. The
      // functional update below is a no-op when there is nothing to clear.
      publishSnap(null);
      return { ...constrained(raw, o?.constrain), snap: null };
    }
    const res = snapPoint(o?.index ?? snapIndex, raw, snapOptions, snapCycleRef.current);
    if (res.candidates.length === 0) snapCycleRef.current = 0;
    publishSnap(res.hit);
    if (res.hit) return { x: res.point.x, y: res.point.y, snap: res.hit };
    return { ...constrained(res.point, o?.constrain), snap: null };
  };

  /**
   * The second entry, and the asymmetry the choke point must carry: a MOVE
   * snaps the dragged object's own geometry, not the pointer. Dragging a
   * rectangle by its middle and having the pointer land on an endpoint is not
   * what any CAD tool does — the corner nearest a target is what should land
   * on it. Returns the corrected DISPLAY-frame travel.
   */
  const pageDelta = (
    raw: { dx: number; dy: number },
    own: readonly SnapPoint[],
    index: SnapIndex,
    suspend: boolean,
    constrain = false,
  ): { dx: number; dy: number } => {
    // Shift on a MOVE constrains the TRAVEL, so the anchor is the origin of
    // the delta rather than a page point — same math, same increment, and it
    // gives the king's axis-locked drag at 90°.
    const held = (d: { dx: number; dy: number }): { dx: number; dy: number } => {
      if (!constrain) return d;
      const p = constrainAngle(
        { x: 0, y: 0 },
        { x: d.dx, y: d.dy },
        snapSettings?.angleDeg ?? 0,
        displayWidth,
        pageHeight,
      );
      return { dx: p.x, dy: p.y };
    };
    if (!snapArmed || suspend) {
      publishSnap(null);
      return held(raw);
    }
    const res = snapDelta(index, own, raw, snapOptions, snapCycleRef.current);
    if (res.candidates.length === 0) snapCycleRef.current = 0;
    publishSnap(res.hit);
    return res.hit ? res.delta : held(res.delta);
  };

  /** An annotation's display-frame candidate points (box corners, box centre,
   * vertices) — what `pageDelta` moves and matches against the targets. */
  const ownSnapPoints = (members: readonly PageAnnotation[]): SnapPoint[] => {
    const out: SnapPoint[] = [];
    for (const m of members) {
      const b = viewRotation === 0 ? m : rotateNormalizedRect(m, viewRotation);
      const pts =
        m.points && viewRotation !== 0
          ? rotateNormalizedPoints([...m.points], viewRotation)
          : m.points;
      out.push(...objectSnapPoints({ x: b.x, y: b.y, w: b.w, h: b.h, points: pts }));
    }
    return out;
  };

  // ── Annotation manipulation (rung 1): move / resize / marquee ─────────
  // Gestures run with window-level listeners (the canvas invariant), preview
  // through local state in the STORED frame (so the render-side projection is
  // the ONE projection), and dispatch a single batch edit on release — one
  // gesture, one undo step. Escape/blur/pointercancel abandon cleanly.
  const [manipPreview, setManipPreview] = useState<Map<
    string,
    { x: number; y: number; w: number; h: number; points?: number[] }
  > | null>(null);
  const manipActive = useRef(false);
  const cancelManip = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelManip.current?.(), []);
  // A real drag's release must not land as a click anywhere (the usePageDrag
  // swallow pattern) — a plain press-release keeps its click.
  const swallowNextClick = (): void => {
    const swallow = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true } as EventListenerOptions), 0);
  };
  const cellElOf = (e: React.PointerEvent<HTMLElement>): HTMLElement =>
    (e.currentTarget as HTMLElement).closest('[data-page-id]') as HTMLElement;

  /** Press on an annotation body (Select tool): selection on the press, a
   * move gesture past a 3px threshold. Dragging a selected member moves the
   * whole same-page selection; dragging an unselected one selects it first
   * (ctrl adds instead of replacing, Acrobat's model). */
  const handleAnnotMoveDown = (a: PageAnnotation, e: React.PointerEvent<HTMLElement>): void => {
    if (tool !== 'select' || e.button !== 0 || editing || manipActive.current) return;
    e.stopPropagation();
    const additive = e.ctrlKey || e.metaKey;
    const wasSelected = selectedAnnotationIds.includes(a.id);
    // Selection resolves on the PRESS (drag needs the group now). The
    // subsequent click is a no-op — additive toggling of an already-selected
    // member happens here too, and only when the press never becomes a drag.
    let groupIds: string[];
    if (wasSelected) {
      groupIds = [...selectedAnnotationIds];
    } else {
      onSelectAnnotation(docId, page.id, a.id, additive);
      groupIds = additive ? [...selectedAnnotationIds, a.id] : [a.id];
    }
    if (!isTransformable(a)) return; // text markup: selectable, never movable
    const cell = cellElOf(e);
    if (!cell) return;
    const group = (page.annotations ?? []).filter(
      (x) => groupIds.includes(x.id) && isTransformable(x),
    );
    if (group.length === 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;
    // N11: this gesture snaps the OBJECT, not the pointer, so it needs the
    // group's own candidate points and an index with those same objects
    // EXCLUDED (or a moved corner snaps to where it started). Both are built
    // LAZILY — a press that never becomes a drag must not pay for indexing a
    // dense sheet, and a click on an annotation is the common case.
    let ownPts: SnapPoint[] | null = null;
    let moveIndex: SnapIndex | null = null;

    const storedDelta = (ev: PointerEvent): { dx: number; dy: number } => {
      // Un-project the pointer TRAVEL as two points — a delta is the
      // difference of un-projected positions, never an un-projected pair of
      // raw distances (axes swap at 90/270). One rect read serves both, so
      // the pair can never straddle a layout change.
      const rect = cell.getBoundingClientRect();
      const d0 = {
        x: (startX - rect.left) / rect.width,
        y: (startY - rect.top) / rect.height,
      };
      const raw = {
        dx: (ev.clientX - rect.left) / rect.width - d0.x,
        dy: (ev.clientY - rect.top) / rect.height - d0.y,
      };
      ownPts ??= ownSnapPoints(group);
      moveIndex ??= snapIndexExcluding(group.map((m) => m.id));
      const moved = pageDelta(raw, ownPts, moveIndex, ev.altKey, ev.shiftKey);
      const p0 = toStoredPoints([d0.x, d0.y]);
      const p1 = toStoredPoints([d0.x + moved.dx, d0.y + moved.dy]);
      return { dx: p1[0] - p0[0], dy: p1[1] - p0[1] };
    };

    const onMove = (ev: PointerEvent): void => {
      if (!activated) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        activated = true;
        manipActive.current = true;
        gestureLive.current = true;
      }
      const { dx, dy } = storedDelta(ev);
      // The pressed annotation leads; its CLAMPED delta moves the group in
      // formation (members still clamp individually at the page edge).
      const lead = translated(a, dx, dy);
      const next = new Map<string, { x: number; y: number; w: number; h: number; points?: number[] }>();
      for (const m of group) {
        const t = m.id === a.id ? lead : translatedBy(m, lead.dx, lead.dy);
        next.set(m.id, { x: t.x, y: t.y, w: m.w, h: m.h, ...(t.points ? { points: t.points } : {}) });
      }
      setManipPreview(next);
    };
    const finish = (commit: boolean, ev?: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      cancelManip.current = null;
      endSnapGesture();
      if (!activated) {
        // A plain press-release. Ctrl-click on an already-selected member
        // TOGGLES it off; a plain click on one COLLAPSES the selection to
        // just it (both Acrobat) — either way only now, when it provably
        // wasn't the start of a group drag.
        if (commit && wasSelected) onSelectAnnotation(docId, page.id, a.id, additive);
        return;
      }
      manipActive.current = false;
      setManipPreview(null);
      swallowNextClick();
      if (!commit || !ev) return;
      const { dx, dy } = storedDelta(ev);
      const lead = translated(a, dx, dy);
      if (lead.dx === 0 && lead.dy === 0) return;
      const edits: AnnotationTransform[] = group.map((m) => {
        const t = m.id === a.id ? lead : translatedBy(m, lead.dx, lead.dy);
        return {
          pageId: page.id,
          annotationId: m.id,
          x: t.x,
          y: t.y,
          w: m.w,
          h: m.h,
          ...(t.points ? { points: t.points } : {}),
        };
      });
      onTransformAnnotations(docId, edits);
    };
    const onUp = (ev: PointerEvent): void => finish(true, ev);
    const onCancel = (): void => finish(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    const onBlur = (): void => finish(false);
    cancelManip.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  };

  /** Drag a resize handle (single selection only — handles only render
   * then). Math runs in the VIEW frame (the handle the user grabbed), the
   * result un-projects through the same helpers as every capture path. */
  const handleResizeDown = (
    a: PageAnnotation,
    handle: ResizeHandle,
    e: React.PointerEvent<HTMLElement>,
  ): void => {
    if (tool !== 'select' || e.button !== 0 || manipActive.current) return;
    e.stopPropagation();
    e.preventDefault();
    const cell = cellElOf(e);
    if (!cell) return;
    // The annotation projected into the view frame — the frame the pointer
    // and the grabbed handle live in.
    const viewBox = viewRotation === 0 ? { x: a.x, y: a.y, w: a.w, h: a.h } : rotateNormalizedRect(a, viewRotation);
    const viewA: PageAnnotation = {
      ...a,
      ...viewBox,
      points: a.points && viewRotation !== 0 ? rotateNormalizedPoints(a.points, viewRotation) : a.points,
    };
    // Image stamps default to their own aspect (they are pictures); Shift
    // locks the rest on demand.
    const aspectByDefault = a.kind === 'stamp' && !!a.imageData;
    let activated = false;
    let lastStored: { x: number; y: number; w: number; h: number; points?: number[] } | null = null;
    // A resize DRAGS one handle, so the pointer IS the moving geometry —
    // `pagePoint`, not the delta entry — with this annotation excluded from
    // its own targets. Built lazily, like the move gesture's.
    let resizeIndex: SnapIndex | null = null;

    const applyAt = (ev: PointerEvent): void => {
      resizeIndex ??= snapIndexExcluding([a.id]);
      const p = pagePoint(cell, ev.clientX, ev.clientY, {
        suspend: ev.altKey,
        index: resizeIndex,
      });
      const keepAspect = aspectByDefault ? !ev.shiftKey : ev.shiftKey;
      const r = resized(viewA, handle, p.x, p.y, keepAspect);
      const storedBox = toStoredRect({ x: r.x, y: r.y, w: r.w, h: r.h });
      const stored = {
        ...storedBox,
        ...(r.points ? { points: toStoredPoints(r.points) } : {}),
      };
      lastStored = stored;
      setManipPreview(new Map([[a.id, stored]]));
    };
    const onMove = (ev: PointerEvent): void => {
      if (!activated) {
        activated = true;
        manipActive.current = true;
        gestureLive.current = true;
      }
      applyAt(ev);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      cancelManip.current = null;
      endSnapGesture();
      if (!activated) return;
      manipActive.current = false;
      setManipPreview(null);
      swallowNextClick();
      if (!commit || !lastStored) return;
      const s = lastStored;
      if (s.x === a.x && s.y === a.y && s.w === a.w && s.h === a.h && !s.points) return;
      // Stored points live in the REAL page-rotation frame; `page.rotation`
      // here is the EFFECTIVE rotation (real + view, composed by the reading
      // view) — subtract the view part or the dims swap against the wrong
      // frame at 90/270 view turns.
      const realRotation = (((page.rotation - viewRotation) % 360) + 360) % 360;
      const note = s.points
        ? recomputedMeasureNote(a, s.points, page.width, page.height, realRotation)
        : undefined;
      onTransformAnnotations(docId, [
        {
          pageId: page.id,
          annotationId: a.id,
          x: s.x,
          y: s.y,
          w: s.w,
          h: s.h,
          ...(s.points ? { points: s.points } : {}),
          ...(note !== undefined ? { note } : {}),
        },
      ]);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    const onBlur = (): void => finish(false);
    cancelManip.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  };

  // Ctrl-marquee rubber band (Select tool): plain drags stay text selection,
  // the modifier claims multi-select — no fight over the text layer.
  const [marquee, setMarquee] = useState<AnnotationRect | null>(null);
  const handleMarqueeDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || manipActive.current) return;
    e.preventDefault();
    e.stopPropagation();
    manipActive.current = true;
    const el = e.currentTarget;
    // A SELECTION marquee never snaps: it is not a placement, and a band that
    // jumped to a vector endpoint would select a different set than the one
    // the user drew around.
    const norm = (cx: number, cy: number): { x: number; y: number } => {
      const p = pagePoint(el, cx, cy, { snap: false });
      return { x: p.x, y: p.y };
    };
    const start = norm(e.clientX, e.clientY);
    let latest: AnnotationRect = { ...start, w: 0, h: 0 };
    setMarquee(latest);
    const onMove = (ev: PointerEvent): void => {
      const p = norm(ev.clientX, ev.clientY);
      latest = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      setMarquee(latest);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      manipActive.current = false;
      cancelManip.current = null;
      setMarquee(null);
      swallowNextClick();
      if (!commit || (latest.w < 0.005 && latest.h < 0.005)) return;
      // Intersect in the VIEW frame — the marquee's own frame.
      const hits = (page.annotations ?? [])
        .filter((x) => {
          const b = viewRotation === 0 ? x : rotateNormalizedRect(x, viewRotation);
          return (
            b.x < latest.x + latest.w &&
            b.x + b.w > latest.x &&
            b.y < latest.y + latest.h &&
            b.y + b.h > latest.y
          );
        })
        .map((x) => x.id);
      if (hits.length > 0) onMarqueeSelect(docId, page.id, hits, true);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    cancelManip.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  /** Drag one vertex of a points shape (or the callout leader) — single
   * selection only, same preview/dispatch discipline as move/resize. */
  const handleVertexDown = (
    a: PageAnnotation,
    vertexIndex: number,
    e: React.PointerEvent<HTMLElement>,
  ): void => {
    if (tool !== 'select' || e.button !== 0 || manipActive.current) return;
    e.stopPropagation();
    e.preventDefault();
    const cell = cellElOf(e);
    if (!cell) return;
    let activated = false;
    let last: ReturnType<typeof vertexDragged> | null = null;
    // The dragged VERTEX is the moving geometry and the pointer carries it,
    // so this is a `pagePoint` site — with the annotation itself excluded
    // from the targets (a vertex must not snap to its own leader).
    let vertexIndexTargets: SnapIndex | null = null;
    const onMove = (ev: PointerEvent): void => {
      if (!activated) {
        activated = true;
        manipActive.current = true;
        gestureLive.current = true;
      }
      vertexIndexTargets ??= snapIndexExcluding([a.id]);
      const p = pagePoint(cell, ev.clientX, ev.clientY, {
        suspend: ev.altKey,
        index: vertexIndexTargets,
      });
      const stored = toStoredPoints([p.x, p.y]);
      last = vertexDragged(a, vertexIndex, stored[0], stored[1]);
      setManipPreview(new Map([[a.id, last]]));
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      cancelManip.current = null;
      endSnapGesture();
      if (!activated) return;
      manipActive.current = false;
      setManipPreview(null);
      swallowNextClick();
      if (!commit || !last) return;
      onTransformAnnotations(docId, [
        {
          pageId: page.id,
          annotationId: a.id,
          x: last.x,
          y: last.y,
          w: last.w,
          h: last.h,
          points: last.points,
          ...(last.calloutBox ? { calloutBox: last.calloutBox } : {}),
        },
      ]);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    const onBlur = (): void => finish(false);
    cancelManip.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  };

  // ── Shape + callout creation (rung 2) ────────────────────────────────
  // Line/arrow: a drag. Polygon/polyline/cloud: a vertex-click sequence
  // (double-click or click-the-last-vertex finishes — the measure tools'
  // convention). Rect/ellipse and the callout box ride the generic band at
  // the bottom of handlePointerDown. The dashed draft previews here.
  const [shapeDraft, setShapeDraft] = useState<number[] | null>(null);
  const [shapeCursor, setShapeCursor] = useState<{ x: number; y: number } | null>(null);
  const shapeSeqActive = useRef(false);
  const appendShapeVertexRef = useRef<((p: { x: number; y: number }, done: boolean) => void) | null>(null);

  const commitShape = (type: ShapeType, viewPts: number[]): void => {
    const stored = toStoredPoints(viewPts);
    onAddAnnotation(docId, page.id, {
      id: crypto.randomUUID(),
      kind: 'shape',
      shapeType: type,
      // Flat-padded box (a horizontal line still needs a clickable body).
      ...paddedPointsBbox(stored),
      color: annotationColor ?? SHAPE_COLOR,
      strokeWidth: 2,
      points: stored,
    });
  };

  const handleShapeLineDown = (e: React.PointerEvent<HTMLElement>): void => {
    bandActive.current = true;
    gestureLive.current = true;
    const el = e.currentTarget;
    const start = normPoint(el, e.clientX, e.clientY, e);
    constrainAnchor.current = start;
    let lastP = start;
    setShapeDraft([start.x, start.y]);
    setShapeCursor(start);
    const onMove = (ev: PointerEvent): void => {
      lastP = normPoint(el, ev.clientX, ev.clientY, ev);
      setShapeCursor(lastP);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      bandActive.current = false;
      cancelBand.current = null;
      endSnapGesture();
      setShapeDraft(null);
      setShapeCursor(null);
      if (commit && (Math.abs(lastP.x - start.x) > 0.005 || Math.abs(lastP.y - start.y) > 0.005)) {
        commitShape(shapeType, [start.x, start.y, lastP.x, lastP.y]);
      }
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelBand.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const handleShapeVertexDown = (e: React.PointerEvent<HTMLElement>): void => {
    const el = e.currentTarget;
    const p = normPoint(el, e.clientX, e.clientY, e);
    if (!shapeSeqActive.current) {
      // The SECOND press of a double-click that just FINISHED a sequence
      // (via the click-the-last-vertex rule) must not seed a phantom new one.
      if (e.detail >= 2) return;
      shapeSeqActive.current = true;
      gestureLive.current = true;
      constrainAnchor.current = p;
      let pts = [p.x, p.y];
      setShapeDraft(pts);
      setShapeCursor(p);
      const onMove = (ev: PointerEvent): void =>
        setShapeCursor(normPoint(el, ev.clientX, ev.clientY, ev));
      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove);
        shapeSeqActive.current = false;
        cancelBand.current = null;
        endSnapGesture();
        appendShapeVertexRef.current = null;
        setShapeDraft(null);
        setShapeCursor(null);
      };
      appendShapeVertexRef.current = (q, dblclick) => {
        const nearLast =
          pts.length >= 2 &&
          Math.abs(q.x - pts[pts.length - 2]) < 0.008 &&
          Math.abs(q.y - pts[pts.length - 1]) < 0.008;
        if (dblclick || nearLast) {
          const minVerts = shapeType === 'polyline' ? 2 : 3;
          const finished = pts.length / 2 >= minVerts ? [...pts] : null;
          const type = shapeType;
          cleanup();
          if (finished) commitShape(type, finished);
          return;
        }
        pts = [...pts, q.x, q.y];
        constrainAnchor.current = q; // the anchor walks with the sequence
        setShapeDraft(pts);
      };
      cancelBand.current = cleanup;
      window.addEventListener('pointermove', onMove);
      return;
    }
    appendShapeVertexRef.current?.(p, e.detail >= 2);
  };

  // N5 stroke merging: the last ink annotation this cell created/extended.
  const lastInkRef = useRef<{ id: string; pageId: string; color: string; time: number } | null>(null);

  // N5b eraser: swath samples (display frame) for the live feedback stroke.
  const [eraseSwath, setEraseSwath] = useState<number[] | null>(null);
  const ERASER_PX = 10;

  const handleEraseDown = (e: React.PointerEvent<HTMLElement>): void => {
    bandActive.current = true;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    // A freehand swath never snaps — snapping every sample would deform the
    // very stroke the gesture is drawing.
    const norm = (cx: number, cy: number): { x: number; y: number } => {
      const p = pagePoint(el, cx, cy, { snap: false });
      return { x: p.x, y: p.y };
    };
    const start = norm(e.clientX, e.clientY);
    let path = [start.x, start.y];
    setEraseSwath(path);
    const onMove = (ev: PointerEvent): void => {
      const p = norm(ev.clientX, ev.clientY);
      path = [...path, p.x, p.y];
      setEraseSwath(path);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      bandActive.current = false;
      cancelBand.current = null;
      endSnapGesture();
      setEraseSwath(null);
      if (!commit) return;
      // The cut runs in the STORED frame (strokes live there): un-project
      // the swath like any capture, and swap the per-axis radius when the
      // effective rotation swaps the axes.
      const storedPath = toStoredPoints(path);
      const rxDisp = ERASER_PX / rect.width;
      const ryDisp = ERASER_PX / rect.height;
      const swapped = page.rotation === 90 || page.rotation === 270;
      const radius = swapped ? { x: ryDisp, y: rxDisp } : { x: rxDisp, y: ryDisp };
      const edits: AnnotationTransform[] = [];
      const emptied: string[] = [];
      for (const a of page.annotations ?? []) {
        if (a.kind !== 'ink' || !a.strokes) continue;
        const remaining = eraseFromStrokes(a.strokes, storedPath, radius);
        if (remaining === null) continue;
        const box = strokesBbox(remaining);
        if (!box) {
          emptied.push(a.id);
          continue;
        }
        edits.push({ pageId: page.id, annotationId: a.id, ...box, strokes: remaining });
      }
      // One undo step for the cuts; a fully-erased annotation removes
      // separately (TRANSFORM cannot delete — the rare gesture that both
      // trims one drawing and finishes another costs one extra Ctrl+Z).
      if (edits.length > 0) onTransformAnnotations(docId, edits);
      for (const id of emptied) onRemoveAnnotation(docId, page.id, id);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelBand.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const handleInkDown = (e: React.PointerEvent<HTMLElement>): void => {
    bandActive.current = true;
    const el = e.currentTarget;
    // Freehand, like the eraser: never snapped.
    const norm = (cx: number, cy: number): { x: number; y: number } => {
      const p = pagePoint(el, cx, cy, { snap: false });
      return { x: p.x, y: p.y };
    };
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
      endSnapGesture();
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
        const color = annotationColor ?? INK_COLOR;
        // N5: pen lifts within the merge window EXTEND the previous ink
        // annotation instead of spawning a new one — a signature drawn in
        // four strokes is ONE annotation (one /InkList with four paths),
        // exactly how it would import. The window resets on every stroke;
        // a color change, another page, deletion, or undo breaks the chain
        // (the target must still exist with its strokes intact).
        const prev = lastInkRef.current;
        const target =
          prev && prev.pageId === page.id && prev.color === color &&
          performance.now() - prev.time < INK_MERGE_WINDOW_MS
            ? page.annotations?.find((a) => a.id === prev.id && a.kind === 'ink' && a.strokes)
            : undefined;
        if (target) {
          const strokes = [...(target.strokes ?? []), stored];
          const sx = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 0));
          const sy = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1));
          const bx = Math.min(...sx);
          const by = Math.min(...sy);
          onTransformAnnotations(docId, [{
            pageId: page.id,
            annotationId: target.id,
            x: bx,
            y: by,
            w: Math.max(...sx) - bx,
            h: Math.max(...sy) - by,
            strokes,
          }]);
          lastInkRef.current = { id: target.id, pageId: page.id, color, time: performance.now() };
        } else {
          const id = crypto.randomUUID();
          onAddAnnotation(docId, page.id, {
            id,
            kind: 'ink',
            x: minX,
            y: minY,
            w,
            h,
            color,
            strokes: [stored],
          });
          lastInkRef.current = { id, pageId: page.id, color, time: performance.now() };
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

  // ── Measure (parity map § 2) ──────────────────────────────────────────
  // Values are computed against the DISPLAYED page dims in PDF points
  // (`measDispW`/`measDispH`, defined up in the snapping block — the grid
  // needs the same pair). Lengths are rotation-invariant, so the VALUE needs
  // no un-projection; the left-behind annotation's points un-project exactly
  // like ink's.
  const measureValueFor = (pts: number[]): string => {
    if (tool === 'measurearea') {
      const area = formatArea(ringAreaPts2(pts, measDispW, measDispH), measScale);
      // The king reports the ring's perimeter beside its area; close the ring
      // for the length.
      const ring = [...pts, pts[0], pts[1]];
      return `${area} · perimeter ${formatDistance(polylineLengthPts(ring, measDispW, measDispH), measScale)}`;
    }
    return formatDistance(polylineLengthPts(pts, measDispW, measDispH), measScale);
  };

  const commitMeasurement = (pts: number[]): void => {
    const value = measureValueFor(pts);
    onMeasureResult?.(value);
    if (!measureLeaveMarkup) return;
    // Land as a REAL dimension annotation (kind 'measure' → /Line //PolyLine
    // //Polygon + /IT + /Measure at commit, re-measurable in other tools);
    // undoable through the existing lifecycle, the value in the note. An
    // area ring closes so the on-page stroke reads closed too. The scale is
    // CAPTURED NOW — changing the toolbar ratio later must never rewrite a
    // finished measurement.
    const shape = tool === 'measurearea' ? [...pts, pts[0], pts[1]] : pts;
    const stored = toStoredPoints(shape);
    onAddAnnotation(docId, page.id, {
      id: crypto.randomUUID(),
      kind: 'measure',
      measureKind:
        tool === 'measurearea' ? 'area' : tool === 'measureperim' ? 'perimeter' : 'distance',
      measureRatio: measureRatioLabel(measScale),
      measureUnitsPerPt: measureUnitsPerPoint(measScale),
      measureUnit: measScale.toUnit,
      // Flat-padded box (rung 3): a horizontal dimension needs a clickable
      // body for selection and the right-click recalibrate. Points exact.
      ...paddedPointsBbox(stored),
      color: annotationColor ?? MEASURE_COLOR,
      points: stored,
      note: value,
    });
  };

  // N11: `normPoint` was the seed of the choke point and is now just
  // `pagePoint` with snapping on — kept as a name only because four call
  // sites read better with it. Do NOT add a second conversion beside it.
  const normPoint = (
    el: HTMLElement,
    cx: number,
    cy: number,
    ev?: { altKey?: boolean; shiftKey?: boolean },
  ): { x: number; y: number } => {
    const p = pagePoint(el, cx, cy, {
      suspend: ev?.altKey === true,
      constrain: ev?.shiftKey === true,
    });
    return { x: p.x, y: p.y };
  };

  /** Distance: a drag, like ink but keeping only the endpoints. */
  const handleMeasureDragDown = (e: React.PointerEvent<HTMLElement>): void => {
    bandActive.current = true;
    gestureLive.current = true;
    const el = e.currentTarget;
    const start = normPoint(el, e.clientX, e.clientY, e);
    constrainAnchor.current = start;
    let last = start;
    setMeasurePts([start.x, start.y]);
    setMeasureCursor(start);
    const onMove = (ev: PointerEvent): void => {
      last = normPoint(el, ev.clientX, ev.clientY, ev);
      setMeasureCursor(last);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      bandActive.current = false;
      cancelBand.current = null;
      endSnapGesture();
      setMeasurePts(null);
      setMeasureCursor(null);
      const pts = [start.x, start.y, last.x, last.y];
      // A sub-half-percent drag is a click, not a measurement.
      if (commit && (Math.abs(last.x - start.x) > 0.005 || Math.abs(last.y - start.y) > 0.005)) {
        if (tool === 'measurecal') {
          // Calibration commits NOTHING — it reports the dragged span so the
          // toolbar can ask what it really measures.
          onCalibrate(polylineLengthPts(pts, measDispW, measDispH));
        } else {
          commitMeasurement(pts);
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

  /** Perimeter/area: click adds a vertex, double-click finishes, Escape (or
   * leaving the mode) cancels — the sequence persists BETWEEN pointer events,
   * so its cancel lives in the same cancelBand seam the drags use. */
  const appendVertexRef = useRef<((p: { x: number; y: number }, done: boolean) => void) | null>(null);
  const handleMeasureVertexDown = (e: React.PointerEvent<HTMLElement>): void => {
    const el = e.currentTarget;
    const p = normPoint(el, e.clientX, e.clientY, e);
    if (!measureSeqActive.current) {
      // Same phantom-sequence guard as shapes: a double-click whose first
      // press finished the sequence (click-the-last-vertex) must not have
      // its second press start a fresh one.
      if (e.detail >= 2) return;
      measureSeqActive.current = true;
      gestureLive.current = true;
      constrainAnchor.current = p;
      let pts = [p.x, p.y];
      setMeasurePts(pts);
      setMeasureCursor(p);
      const onMove = (ev: PointerEvent): void =>
        setMeasureCursor(normPoint(el, ev.clientX, ev.clientY, ev));
      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove);
        measureSeqActive.current = false;
        cancelBand.current = null;
        endSnapGesture();
        appendVertexRef.current = null;
        setMeasurePts(null);
        setMeasureCursor(null);
      };
      appendVertexRef.current = (q, dblclick) => {
        // Finish on a double-click OR a click landing on the previous vertex
        // (the CAD "click the same spot" convention) — e.detail is unreliable
        // for synthesized input, and clicking where you already are can only
        // mean "done".
        const nearLast =
          pts.length >= 2 &&
          Math.abs(q.x - pts[pts.length - 2]) < 0.008 &&
          Math.abs(q.y - pts[pts.length - 1]) < 0.008;
        if (dblclick || nearLast) {
          const minVerts = tool === 'measurearea' ? 3 : 2;
          const finished = pts.length / 2 >= minVerts ? [...pts] : null;
          cleanup();
          if (finished) commitMeasurement(finished);
          return;
        }
        pts = [...pts, q.x, q.y];
        // The anchor walks with the sequence: Shift holds the NEXT leg to an
        // increment from the vertex just committed, not from the first one.
        constrainAnchor.current = q;
        setMeasurePts(pts);
      };
      cancelBand.current = cleanup;
      window.addEventListener('pointermove', onMove);
      return;
    }
    // e.detail === 2 is the second press of a double-click: the first press
    // already appended this point, so finish without appending again.
    appendVertexRef.current?.(p, e.detail >= 2);
  };

  // Switching MODES mid-sequence (dist ↔ perim ↔ area via the secondary
  // toolbar pills) keeps annotateMode true, so the annotate-mode cancel
  // below never fires — cancel the vertex sequence explicitly.
  useEffect(() => {
    if (measureSeqActive.current) cancelBand.current?.();
  }, [tool]);

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!annotateMode) {
      // Ctrl-drag in Select mode is the annotation marquee; plain drags stay
      // text selection / page interaction untouched.
      if (tool === 'select' && (e.ctrlKey || e.metaKey) && e.button === 0) {
        handleMarqueeDown(e);
        return;
      }
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
    if (tool === 'inkerase') {
      handleEraseDown(e);
      return;
    }
    if (tool === 'measuredist' || tool === 'measurecal') {
      handleMeasureDragDown(e);
      return;
    }
    if (tool === 'measureperim' || tool === 'measurearea') {
      handleMeasureVertexDown(e);
      return;
    }
    if (tool === 'shape') {
      if (shapeType === 'line' || shapeType === 'arrow') {
        handleShapeLineDown(e);
        return;
      }
      if (shapeType === 'polygon' || shapeType === 'polyline' || shapeType === 'cloud') {
        handleShapeVertexDown(e);
        return;
      }
      // rect/ellipse fall through to the generic band below.
    }
    if (tool === 'note') {
      // N3: click places a native /Text sticky note at the point (fixed icon
      // size — rung 1's kind rule) and opens its text editor immediately,
      // the king's gesture. An editor left empty removes the note.
      const { x: cx, y: cy } = pagePoint(e.currentTarget, e.clientX, e.clientY, {
        suspend: e.altKey,
      });
      const w = Math.min(0.2, 18 / measDispW);
      const h = Math.min(0.2, 18 / measDispH);
      const placed = toStoredRect({
        x: Math.max(0, Math.min(1 - w, cx - w / 2)),
        y: Math.max(0, Math.min(1 - h, cy - h / 2)),
        w,
        h,
      });
      const annotation: PageAnnotation = {
        id: crypto.randomUUID(),
        kind: 'note',
        ...placed,
        color: annotationColor ?? HIGHLIGHT_COLOR,
        note: '',
      };
      onAddAnnotation(docId, page.id, annotation);
      setEditing(annotation.id);
      return;
    }
    if (tool === 'stamp') {
      if (!stampPreset) return; // no preset picked yet — clicks are a no-op
      const { x: cx, y: cy } = pagePoint(e.currentTarget, e.clientX, e.clientY, {
        suspend: e.altKey,
      });
      // Image stamps size from their own aspect (normalized height = width ×
      // aspect × the displayed page's width/height ratio, so the image is
      // undistorted on paper); text stamps keep the fixed footprint.
      const w = STAMP_W;
      const h =
        stampPreset.imageData && stampPreset.aspect
          ? Math.min(0.6, STAMP_W * stampPreset.aspect * (measDispW / measDispH))
          : STAMP_H;
      // Built in the DISPLAY frame (the stamp reads upright on the view you
      // placed it on), then stored un-projected like every annotation.
      const placed = toStoredRect({
        x: Math.max(0, Math.min(1 - w, cx - w / 2)),
        y: Math.max(0, Math.min(1 - h, cy - h / 2)),
        w,
        h,
      });
      // Dynamic tokens ({date}/{time}/{name}) resolve AT PLACEMENT — a stamp
      // records when it was placed; committing later must not re-date it.
      const label = stampPreset.imageData
        ? stampPreset.label
        : resolveStampTokens(
            stampPreset.label,
            new Date(),
            getSettings().identityName,
            i18next.language,
          );
      onAddAnnotation(docId, page.id, {
        id: crypto.randomUUID(),
        kind: 'stamp',
        ...placed,
        color: annotationColor ?? stampPreset.color,
        note: label,
        ...(stampPreset.imageData ? { imageData: stampPreset.imageData } : {}),
      });
      return;
    }
    bandActive.current = true;
    gestureLive.current = true;
    const el = e.currentTarget;
    // The generic band IS a placement (a highlight box, a redaction region, a
    // signature/field/crop/add-text/add-image rect, a shape's rect or
    // ellipse), so it snaps like the rest. `zoommarquee` rides it too and is
    // harmless to snap — it lands on the same page geometry either way.
    const norm = (cx: number, cy: number, alt = false): { x: number; y: number } => {
      const p = pagePoint(el, cx, cy, { suspend: alt });
      return { x: p.x, y: p.y };
    };
    const start = norm(e.clientX, e.clientY, e.altKey);
    // 'redact' shares the band mechanics but commits a transient mark, not a
    // PageAnnotation. `tool` is stable for the drag's duration — a mid-drag
    // tool switch cancels via the annotateMode effect below.
    const kind = tool === 'freetext' ? 'freetext' : 'highlight';
    let latest: AnnotationRect = { ...start, w: 0, h: 0 };
    setBand(latest);

    const onMove = (ev: PointerEvent): void => {
      const p = norm(ev.clientX, ev.clientY, ev.altKey);
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
      endSnapGesture();
      setBand(null);
      if (commit && tool === 'addimage' && (latest.w <= 0.01 || latest.h <= 0.01)) {
        // P7 (slice C): a bare CLICK places at natural size — the rect
        // degenerates to the click point (w=h=0) and App routes it to the
        // engine's `at` placement instead of a drawn box.
        onAddImageRect(
          docId,
          page.id,
          { x: latest.x + latest.w / 2, y: latest.y + latest.h / 2, w: 0, h: 0 },
          page.rotation,
        );
      } else if (commit && latest.w > 0.01 && latest.h > 0.01) {
        if (tool === 'zoommarquee') {
          // N3: the band is a VIEW request, not an annotation — zoom the
          // reading view until this display-frame region fills it.
          onZoomToRect?.(page.id, latest);
        } else if (tool === 'redact') {
          onAddRedactionMark(docId, page.id, latest, page.rotation);
        } else if (tool === 'signature') {
          // Single pending placement — drawing again (anywhere) replaces it.
          onSetSignaturePlacement(docId, page.id, latest, page.rotation);
        } else if (tool === 'formfields') {
          // Add-field placement (2n.4c) — single, drawing again replaces it.
          onSetNewFieldRect(docId, page.id, latest, page.rotation);
        } else if (tool === 'cropdraw') {
          // P5b: the band is the region to KEEP. Nothing commits here —
          // the panel turns it into insets and the user applies.
          onSetCropRect?.(docId, page.id, latest, page.rotation);
        } else if (tool === 'addtext') {
          // Add-text placement (9.A2) — single, drawing again replaces it.
          onSetAddTextRect(docId, page.id, latest, page.rotation);
        } else if (tool === 'addimage') {
          // Add-image (9.C2) — the box; App picks the file + embeds.
          onAddImageRect(docId, page.id, latest, page.rotation);
        } else if (tool === 'shape') {
          // rect/ellipse: the band IS the box.
          const b = toStoredRect(latest);
          onAddAnnotation(docId, page.id, {
            id: crypto.randomUUID(),
            kind: 'shape',
            shapeType,
            ...b,
            color: annotationColor ?? SHAPE_COLOR,
            strokeWidth: 2,
          });
        } else if (tool === 'callout') {
          // The band is the TEXT BOX; the default leader lands to its left,
          // pointing at nothing in particular yet — vertex handles move it.
          // Built in the stored frame (box + leader must agree).
          const cb = toStoredRect(latest);
          const attach: [number, number] = [cb.x, cb.y + cb.h / 2];
          const tip: [number, number] = [Math.max(0.01, cb.x - 0.08), Math.min(0.99, attach[1] + 0.06)];
          const knee: [number, number] = [(tip[0] + attach[0]) / 2, tip[1]];
          const points = [tip[0], tip[1], knee[0], knee[1], attach[0], attach[1]];
          const xs = [cb.x, cb.x + cb.w, ...points.filter((_, i) => i % 2 === 0)];
          const ys = [cb.y, cb.y + cb.h, ...points.filter((_, i) => i % 2 === 1)];
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const annotation: PageAnnotation = {
            id: crypto.randomUUID(),
            kind: 'callout',
            x: minX,
            y: minY,
            w: Math.max(...xs) - minX,
            h: Math.max(...ys) - minY,
            calloutBox: [cb.x, cb.y, cb.w, cb.h],
            points,
            color: annotationColor ?? SHAPE_COLOR,
            strokeWidth: 1,
          };
          onAddAnnotation(docId, page.id, annotation);
          setEditing(annotation.id); // type the text straight away, like freetext
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
      // P10: the page's natural DISPLAYED extents in PDF points (rotation-
      // swapped) — the board camera's Actual Size / Fit Width solve their
      // zoom from these against the cell's world-unit box.
      data-natural-w={page.rotation === 90 || page.rotation === 270 ? page.height : page.width}
      data-natural-h={page.rotation === 90 || page.rotation === 270 ? page.width : page.height}
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
        // A click that reached the cell (not an annotation — those stop
        // propagation in select mode) clears the annotation selection.
        // Ctrl-clicks keep it: an additive gesture over empty page must not
        // throw away what it was adding to.
        if (tool === 'select' && !e.ctrlKey && !e.metaKey)
          onSelectAnnotation(docId, page.id, null, false);
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
      {/* The grid draws UNDER the annotation layer and OVER the raster — it is
          a drafting aid on the paper, never part of it. `forced-color-adjust`
          is inherited from the page rasters' rule (N14): a high-contrast theme
          re-tints the shell, never the document surface. */}
      {gridOverlay && (
        <svg
          className="page-grid"
          data-testid="page-grid"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {gridOverlay.xs.map((x) => (
            <line key={`gx${x}`} x1={x} y1={0} x2={x} y2={1} vectorEffect="non-scaling-stroke" />
          ))}
          {gridOverlay.ys.map((y) => (
            <line key={`gy${y}`} x1={0} y1={y} x2={1} y2={y} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      {shownGuides.length > 0 && (
        <div
          className="page-guides"
          data-testid="page-guides"
          role="group"
          aria-label={tChrome('canvas.guides.layer')}
        >
          {shownGuides.map((g) => {
            const live = guideDrag && guideDrag.id === g.id ? guideDrag : null;
            const axis = live ? live.axis : g.axis;
            const pos = live ? live.pos : g.pos;
            return (
              <div
                key={g.id}
                className={'page-guide page-guide-' + axis + (live ? ' dragging' : '')}
                data-testid="page-guide"
                data-guide-id={g.id}
                data-guide-axis={axis}
                data-guide-pos={pos}
                style={{
                  ...(axis === 'x' ? { left: `${pos * 100}%` } : { top: `${pos * 100}%` }),
                  // Only the Select tool grabs a guide. Every other mode is
                  // DRAWING, and a hit strip that stayed interactive would
                  // swallow the first pixel of a measurement — the `ui.tool`
                  // failure in miniature. The HANDLER alone is not enough:
                  // an element with `pointer-events: auto` and no listener
                  // still eats the press.
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                onPointerDown={tool === 'select' ? (e) => handleGuideDown(g.id, axis, e) : undefined}
              />
            );
          })}
        </div>
      )}
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
      {(page.annotations ?? []).map((raw) => {
        // A live manipulation gesture previews through the SAME projection as
        // committed geometry — the override is stored-frame, `da` below does
        // the rest. Preview implies divergence (the body must show mid-drag).
        const previewBox = manipPreview?.get(raw.id);
        const a = previewBox ? { ...raw, ...previewBox, geometryDiverged: true } : raw;
        // pdf.js's base raster (PageView) already draws every real annotation
        // in the CURRENTLY LOADED file with AnnotationMode.ENABLE — including
        // ones we've imported but haven't touched. Painting our own visible
        // body on top of an untouched import would double it up. Only once
        // color/note — or, since rung 1, geometry (geometryDiverged) —
        // diverges from the importedOriginal snapshot is the file on disk
        // stale relative to the edit, and the overlay must take over
        // (same as any brand-new, uncommitted annotation always does).
        const pristineImport =
          !!a.importedOriginal &&
          a.importedOriginal.hasAppearance && // else pdf.js draws nothing to avoid duplicating
          !a.geometryDiverged &&
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
                // The callout's text sub-rect projects like the bbox.
                calloutBox: a.calloutBox
                  ? (() => {
                      const r2 = rotateNormalizedRect(
                        { x: a.calloutBox[0], y: a.calloutBox[1], w: a.calloutBox[2], h: a.calloutBox[3] },
                        viewRotation,
                      );
                      return [r2.x, r2.y, r2.w, r2.h] as [number, number, number, number];
                    })()
                  : a.calloutBox,
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
          data-annot-id={a.id}
          className={
            'page-annot' +
            (a.kind === 'freetext' ? ' page-annot-text' : '') +
            (a.kind === 'ink' || a.kind === 'measure' ? ' page-annot-ink' : '') +
            (a.kind === 'textmarkup' ? ' page-annot-ink' : '') + // SVG body, no default border
            (a.kind === 'shape' || a.kind === 'callout' ? ' page-annot-ink' : '') + // SVG bodies too
            (a.kind === 'stamp' ? ' page-annot-stamp' : '') +
            (selectedAnnotationIds.includes(a.id) ? ' page-annot-selected' : '')
          }
          title={a.kind === 'highlight' || a.kind === 'ink' || a.kind === 'measure' || a.kind === 'textmarkup' || a.kind === 'note' || a.kind === 'shape' ? a.note : undefined}
          style={{
            left: `${da.x * 100}%`,
            top: `${da.y * 100}%`,
            width: `${da.w * 100}%`,
            height: `${da.h * 100}%`,
            ...(pristineImport
              ? {}
              : a.kind === 'highlight'
                ? { backgroundColor: `${a.color}66`, borderColor: a.color }
                : a.kind === 'ink' || a.kind === 'measure' || a.kind === 'textmarkup' || a.kind === 'shape' || a.kind === 'callout'
                  ? {}
                  : a.kind === 'note'
                    ? { backgroundColor: `${a.color}dd`, borderColor: a.color, borderRadius: 2 }
                    : a.kind === 'stamp'
                      ? a.imageData
                        ? {} // image stamps are the raster alone — no box chrome
                        : { backgroundColor: `${a.color}22`, borderColor: a.color, color: a.color }
                      : { borderColor: a.color, color: a.color, fontSize: freetextFontPx }),
            // Select tool: every annotation body is clickable (the properties
            // bar's selection gesture — an object on top of the page, Acrobat's
            // model) and movable (rung 1). Other modes keep pointer-events:
            // none, so bands, strokes and page pickup behave exactly as before.
            ...(tool === 'select'
              ? { pointerEvents: 'auto', cursor: isTransformable(a) ? 'move' : 'pointer' }
              : {}),
          }}
          onPointerDown={
            tool === 'select'
              ? (e) => handleAnnotMoveDown(raw, e)
              : a.kind === 'freetext'
                ? (e) => e.stopPropagation()
                : undefined
          }
          onClick={
            tool === 'select'
              ? (e) => {
                  // Selection resolved on the PRESS (handleAnnotMoveDown);
                  // the click only stays off the cell root, which would
                  // clear the selection the instant it bubbled.
                  e.stopPropagation();
                }
              : undefined
          }
          onDoubleClick={
            a.kind === 'freetext' || a.kind === 'callout'
              ? (e) => {
                  e.stopPropagation();
                  setEditing(a.id);
                }
              : undefined
          }
          onContextMenu={
            tool === 'select' && a.kind === 'measure'
              ? (e) => {
                  // Rung 3: right-click a dimension → the recalibrate popover.
                  e.preventDefault();
                  e.stopPropagation();
                  onMeasureContextMenu(docId, page.id, a.id, e.clientX, e.clientY);
                }
              : undefined
          }
        >
          {(a.kind === 'ink' || a.kind === 'measure') && !pristineImport && (
            <svg
              className="page-annot-ink-svg"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              style={a.opacity !== undefined && a.opacity < 1 ? { opacity: a.opacity } : undefined}
            >
              {/* N2: ink draws one polyline PER STROKE (da.strokes); measure
                  keeps its single vertex path (da.points). */}
              {(a.kind === 'ink' ? (da.strokes ?? []) : [da.points ?? []]).map((stroke, si) => (
                <polyline
                  key={si}
                  points={stroke
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
                  {...(a.strokeWidth !== undefined
                    ? { strokeWidth: Math.max(0.75, a.strokeWidth * (pageHeight / measDispH)) }
                    : {})}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
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
          {(a.kind === 'shape' || a.kind === 'callout') && !pristineImport && (() => {
            // Shapes draw in the body's PIXEL space (not a normalized
            // viewBox) so stroke widths and arrowhead angles are true — a
            // non-uniform viewBox would shear them. Same geometry as the
            // committed AP, cloud bumps included (shared cloudBumps).
            const bw = Math.max(1, da.w * displayWidth);
            const bh = Math.max(1, da.h * pageHeight);
            const pxPerPt = pageHeight / measDispH;
            const swPt = a.strokeWidth ?? (a.kind === 'callout' ? 1 : 2);
            const sw = Math.max(0.75, swPt * pxPerPt);
            const px = (nx: number): number => (da.w > 0 ? ((nx - da.x) / da.w) * bw : bw / 2);
            const py = (ny: number): number => (da.h > 0 ? ((ny - da.y) / da.h) * bh : bh / 2);
            const pts = da.points ?? [];
            const fill = a.fillColor ?? 'none';
            const endings =
              a.lineEndings ?? (a.kind === 'shape' && a.shapeType === 'arrow' ? ['None', 'OpenArrow'] : null);
            const head = (
              at: [number, number],
              from: [number, number],
              style: string,
              key: string,
            ): React.JSX.Element | null => {
              if (!style || style === 'None') return null;
              const dxv = at[0] - from[0];
              const dyv = at[1] - from[1];
              const len = Math.hypot(dxv, dyv) || 1;
              const hl = (4 * swPt + 6) * pxPerPt;
              const ux = dxv / len;
              const uy = dyv / len;
              const bxp = at[0] - ux * hl;
              const byp = at[1] - uy * hl;
              const p1 = `${bxp - uy * hl * 0.45},${byp + ux * hl * 0.45}`;
              const p2 = `${bxp + uy * hl * 0.45},${byp - ux * hl * 0.45}`;
              if (style === 'ClosedArrow')
                return (
                  <polygon
                    key={key}
                    points={`${p1} ${at[0]},${at[1]} ${p2}`}
                    fill={a.fillColor ?? a.color}
                    stroke={a.color}
                    strokeWidth={sw}
                  />
                );
              return (
                <polyline
                  key={key}
                  points={`${p1} ${at[0]},${at[1]} ${p2}`}
                  fill="none"
                  stroke={a.color}
                  strokeWidth={sw}
                />
              );
            };
            const common = { stroke: a.color, strokeWidth: sw, fill } as const;
            let body: React.JSX.Element | null = null;
            const extras: (React.JSX.Element | null)[] = [];
            if (a.kind === 'callout') {
              const cb = da.calloutBox ?? [da.x, da.y, da.w, da.h];
              const bx = px(cb[0]);
              const by = py(cb[1]);
              const bwid = da.w > 0 ? (cb[2] / da.w) * bw : bw;
              const bhei = da.h > 0 ? (cb[3] / da.h) * bh : bh;
              body = (
                <>
                  {pts.length >= 4 && (
                    <polyline
                      points={Array.from({ length: pts.length / 2 }, (_, i) => `${px(pts[i * 2])},${py(pts[i * 2 + 1])}`).join(' ')}
                      fill="none"
                      stroke={a.color}
                      strokeWidth={sw}
                    />
                  )}
                  <rect x={bx} y={by} width={bwid} height={bhei} fill="#fbfaf5" stroke={a.color} strokeWidth={Math.max(0.75, sw)} />
                </>
              );
              if (pts.length >= 4)
                extras.push(
                  head([px(pts[0]), py(pts[1])], [px(pts[2]), py(pts[3])], a.lineEndings?.[0] ?? 'OpenArrow', 'tip'),
                );
            } else if (a.shapeType === 'rect') {
              body = <rect x={sw / 2} y={sw / 2} width={Math.max(0, bw - sw)} height={Math.max(0, bh - sw)} {...common} />;
            } else if (a.shapeType === 'ellipse') {
              body = (
                <ellipse cx={bw / 2} cy={bh / 2} rx={Math.max(0, (bw - sw) / 2)} ry={Math.max(0, (bh - sw) / 2)} {...common} />
              );
            } else if (a.shapeType === 'line' || a.shapeType === 'arrow') {
              if (pts.length >= 4) {
                const p0: [number, number] = [px(pts[0]), py(pts[1])];
                const p1: [number, number] = [px(pts[2]), py(pts[3])];
                body = <line x1={p0[0]} y1={p0[1]} x2={p1[0]} y2={p1[1]} stroke={a.color} strokeWidth={sw} />;
                if (endings) {
                  extras.push(head(p0, p1, endings[0], 'h0'));
                  extras.push(head(p1, p0, endings[1], 'h1'));
                }
              }
            } else if (a.shapeType === 'polyline') {
              const str = Array.from({ length: pts.length / 2 }, (_, i) => `${px(pts[i * 2])},${py(pts[i * 2 + 1])}`).join(' ');
              body = <polyline points={str} fill="none" stroke={a.color} strokeWidth={sw} />;
              if (endings && pts.length >= 4) {
                const n = pts.length;
                extras.push(head([px(pts[0]), py(pts[1])], [px(pts[2]), py(pts[3])], endings[0], 'h0'));
                extras.push(
                  head([px(pts[n - 2]), py(pts[n - 1])], [px(pts[n - 4]), py(pts[n - 3])], endings[1], 'h1'),
                );
              }
            } else if (a.shapeType === 'cloud') {
              const verts = Array.from({ length: pts.length / 2 }, (_, i): [number, number] => [px(pts[i * 2]), py(pts[i * 2 + 1])]);
              const r2 = (4 * (a.cloudIntensity ?? 2) + 2) * pxPerPt;
              const bumps = cloudBumps(verts, r2);
              if (bumps.length > 0) {
                const d =
                  `M ${bumps[0].s[0]} ${bumps[0].s[1]} ` +
                  bumps.map((b) => `C ${b.c1[0]} ${b.c1[1]} ${b.c2[0]} ${b.c2[1]} ${b.e[0]} ${b.e[1]}`).join(' ');
                body = <path d={d} {...common} />;
              }
            } else {
              // polygon
              const str = Array.from({ length: pts.length / 2 }, (_, i) => `${px(pts[i * 2])},${py(pts[i * 2 + 1])}`).join(' ');
              body = <polygon points={str} {...common} />;
            }
            return (
              <svg
                className="page-annot-shape-svg"
                viewBox={`0 0 ${bw} ${bh}`}
                preserveAspectRatio="none"
                style={{ opacity: a.opacity ?? 1 }}
              >
                {body}
                {extras}
              </svg>
            );
          })()}
          {a.kind === 'callout' && editing !== a.id && !pristineImport && da.calloutBox && (
            <span
              className="page-annot-callout-text"
              style={{
                left: `${da.w > 0 ? ((da.calloutBox[0] - da.x) / da.w) * 100 : 0}%`,
                top: `${da.h > 0 ? ((da.calloutBox[1] - da.y) / da.h) * 100 : 0}%`,
                width: `${da.w > 0 ? (da.calloutBox[2] / da.w) * 100 : 100}%`,
                height: `${da.h > 0 ? (da.calloutBox[3] / da.h) * 100 : 100}%`,
                color: a.color,
                fontSize: freetextFontPx,
              }}
            >
              {a.note}
            </span>
          )}
          <MaybeTurn style={turnStyle}>
            {a.kind === 'freetext' && editing !== a.id && !pristineImport && (
              <span className="page-annot-text-body">{a.note}</span>
            )}
            {a.kind === 'stamp' && !pristineImport && (
              a.imageData ? (
                <img
                  src={a.imageData}
                  alt={a.note ?? 'Stamp'}
                  draggable={false}
                  className="page-annot-stamp-image"
                />
              ) : (
                <span className="page-annot-stamp-label">{a.note}</span>
              )
            )}
          </MaybeTurn>
          {editing === a.id ? (
            // The inline editor turns with the page too (same wrapper) — the
            // text you type reads the way it will render. A callout's editor
            // covers its TEXT BOX, not the whole (leader-including) extent.
            <MaybeTurn style={turnStyle}>
              <textarea
                className="page-annot-editor"
                style={{
                  fontSize: freetextFontPx,
                  color: a.color,
                  ...(a.kind === 'callout' && da.calloutBox
                    ? {
                        position: 'absolute' as const,
                        left: `${da.w > 0 ? ((da.calloutBox[0] - da.x) / da.w) * 100 : 0}%`,
                        top: `${da.h > 0 ? ((da.calloutBox[1] - da.y) / da.h) * 100 : 0}%`,
                        width: `${da.w > 0 ? (da.calloutBox[2] / da.w) * 100 : 100}%`,
                        height: `${da.h > 0 ? (da.calloutBox[3] / da.h) * 100 : 100}%`,
                      }
                    : {}),
                  // A sticky note's box is its ICON — the editor pops out
                  // beside it at a typable size instead (N3), like the
                  // king's note popup.
                  ...(a.kind === 'note'
                    ? {
                        position: 'absolute' as const,
                        left: '100%',
                        top: 0,
                        width: 180,
                        height: 90,
                        background: '#fffbe8',
                        border: `1px solid ${a.color}`,
                        color: '#16161a',
                        zIndex: 5,
                      }
                    : {}),
                }}
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
                      title={tChrome('canvas.annot.recolorTo', { color: c })}
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
                      ? tChrome('canvas.annot.removeText')
                      : a.kind === 'ink'
                        ? tChrome('canvas.annot.removeDrawing')
                        : a.kind === 'stamp'
                          ? tChrome('canvas.annot.removeStamp')
                          : a.kind === 'textmarkup'
                            ? tChrome(
                                `canvas.annot.removeMarkup.${a.markupType ?? 'highlight'}` as UiKey,
                              )
                            : a.kind === 'note'
                              ? tChrome('canvas.annot.removeNote')
                              : tChrome('canvas.annot.removeHighlight')
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
          {tool === 'select' &&
            selectedAnnotationIds.length === 1 &&
            selectedAnnotationIds[0] === a.id &&
            isResizable(a) &&
            // A two-point line's box handles are its vertex handles' worse
            // twin (a flat bbox has no height to grab) — vertices only.
            !(a.kind === 'shape' && (a.shapeType === 'line' || a.shapeType === 'arrow')) && (
              <>
                {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => (
                  <div
                    key={h}
                    className={`annot-handle annot-handle-${h}`}
                    data-testid={`annot-handle-${h}`}
                    onPointerDown={(e) => handleResizeDown(raw, h, e)}
                  />
                ))}
              </>
            )}
          {tool === 'select' &&
            selectedAnnotationIds.length === 1 &&
            selectedAnnotationIds[0] === a.id &&
            hasVertexHandles(a) &&
            (da.points ?? []).length >= 4 && (
              <>
                {Array.from({ length: (da.points?.length ?? 0) / 2 }, (_, vi) => (
                  <div
                    key={`v${vi}`}
                    className="annot-vertex"
                    data-testid={`annot-vertex-${vi}`}
                    style={{
                      left: `${da.w > 0 ? ((da.points![vi * 2] - da.x) / da.w) * 100 : 50}%`,
                      top: `${da.h > 0 ? ((da.points![vi * 2 + 1] - da.y) / da.h) * 100 : 50}%`,
                    }}
                    onPointerDown={(e) => handleVertexDown(raw, vi, e)}
                  />
                ))}
              </>
            )}
        </div>
        );
      })}
      {marquee && (
        <div
          className="page-annot page-annot-band annot-marquee"
          style={{
            left: `${marquee.x * 100}%`,
            top: `${marquee.y * 100}%`,
            width: `${marquee.w * 100}%`,
            height: `${marquee.h * 100}%`,
          }}
        />
      )}
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
            <span className="page-redact-label">{tChrome('canvas.mark.redact')}</span>
            {(tool === 'select' || tool === 'redact') && (
              <button
                className="page-annot-x"
                title={tChrome('canvas.mark.redactRemove')}
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
                title={tChrome(
                  vec.nested ? 'canvas.editvec.hitNested' : 'canvas.editvec.hit',
                  { kind: vec.kind },
                )}
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
                  title={tChrome('canvas.editvec.delete')}
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
                    ? (editedText?: string, restyle?: MergeRestyle) =>
                        onMergeParagraphPrev(page.id, para.index, editedText, restyle)
                    : undefined
                }
                onMergeNext={
                  onMergeParagraphNext &&
                  (editParagraphs ?? []).some((p) => p.index === para.index + 1)
                    ? (editedText?: string, restyle?: MergeRestyle) =>
                        onMergeParagraphNext(page.id, para.index, editedText, restyle)
                    : undefined
                }
                rotation={page.rotation}
              />
            );
          }
          return (
            <button
              key={`ep-${para.index}`}
              type="button"
              data-testid={`edit-para-${para.index}`}
              className={'page-editpara' + (selected ? ' selected' : '')}
              title={tChrome('canvas.editpara.hit')}
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
                onRestyle={(style) => onRestyleTextEdit?.(page.id, run.index, style)}
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
          const selected = (editSelectedIndexes ?? []).includes(img.index);
          return (
            <button
              key={`ei-${img.index}`}
              type="button"
              data-testid={`edit-image-${img.index}`}
              className={'page-editimg' + (selected ? ' selected' : '')}
              title={tChrome(
                img.kind === 'vector'
                  ? 'canvas.editimg.vector'
                  : img.nested
                    ? 'canvas.editimg.nested'
                    : 'canvas.editimg.image',
              )}
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
                // P7: Shift/Ctrl-click grows a same-page group.
                onSelectEditImage?.(
                  page.id,
                  img.index,
                  e.shiftKey || e.ctrlKey || e.metaKey,
                );
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
          onCommitMask={(mask) => onCommitImageMask?.(page.id, editImageTransform.index, mask)}
        />
      )}
      {tool === 'edit' && editImageGroup && onCommitImageGroupTransform && (
        <ImageGroupOverlay
          ctx={editImageGroup}
          pendingRotate={page.rotation}
          onCommit={(targets) => onCommitImageGroupTransform(page.id, targets)}
          onToggleMember={(index) => onSelectEditImage?.(page.id, index, true)}
          onFocusMember={(index) => onSelectEditImage?.(page.id, index, false)}
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
          onFormButton={onFormButton}
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
              <span className="page-signature-label">{tChrome('canvas.mark.signature')}</span>
              {(tool === 'select' || tool === 'signature') && (
                <button
                  className="page-annot-x"
                  title={tChrome('canvas.mark.signatureRemove')}
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
              <span className="page-form-new-label">{tChrome('canvas.mark.newField')}</span>
              {(tool === 'select' || tool === 'forms' || tool === 'formfields') && (
                <button
                  className="page-annot-x"
                  title={tChrome('canvas.mark.newFieldRemove')}
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
                {tChrome('canvas.mark.newText')}{' '}
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
                  title={tChrome('canvas.mark.newTextRemove')}
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
      {cropPlacement && (
        (() => {
          // Follows in-memory rotation like every other placement: the rect
          // was stored in the frame it was drawn in, projectMarkRect puts it
          // back in the frame shown now.
          const r = projectMarkRect(cropPlacement, page.rotation);
          return (
            <div
              data-testid="crop-placement"
              className="page-crop-placement"
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            >
              <span className="page-crop-label">{tChrome('canvas.mark.keep')}</span>
              <button
                className="page-annot-x"
                title={tChrome('canvas.mark.cropRemove')}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClearCropPlacement?.();
                }}
              >
                ×
              </button>
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
                      : tool === 'cropdraw'
                        ? ' band-cropdraw'
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
      {eraseSwath && (
        // N5b feedback: the eraser's swath, wide and translucent — the cut
        // itself lands on release (one undo step).
        <svg className="page-annot-ink-svg page-annot-ink-live" viewBox="0 0 1 1" preserveAspectRatio="none">
          <polyline
            points={eraseSwath.reduce<string[]>((acc, v, i) => {
              if (i % 2 === 0) acc.push(`${v}`);
              else acc[acc.length - 1] += `,${v}`;
              return acc;
            }, []).join(' ')}
            fill="none"
            stroke="#9aa0a6"
            strokeOpacity={0.4}
            strokeWidth={ERASER_PX * 2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {shapeDraft && shapeCursor && (
        <svg className="page-annot-ink-svg page-annot-ink-live" viewBox="0 0 1 1" preserveAspectRatio="none">
          <polyline
            points={[...shapeDraft, shapeCursor.x, shapeCursor.y]
              .reduce<string[]>((acc, v, i) => {
                if (i % 2 === 0) acc.push(`${v}`);
                else acc[acc.length - 1] += `,${v}`;
                return acc;
              }, [])
              .join(' ')}
            fill="none"
            stroke={annotationColor ?? SHAPE_COLOR}
            vectorEffect="non-scaling-stroke"
          />
          {(shapeType === 'polygon' || shapeType === 'cloud') && shapeDraft.length >= 4 && (
            <line
              x1={shapeCursor.x}
              y1={shapeCursor.y}
              x2={shapeDraft[0]}
              y2={shapeDraft[1]}
              stroke={annotationColor ?? SHAPE_COLOR}
              strokeDasharray="0.01 0.008"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}
      {measurePts && measureCursor && (
        <>
          <svg className="page-annot-ink-svg page-annot-ink-live" viewBox="0 0 1 1" preserveAspectRatio="none">
            <polyline
              points={[...measurePts, measureCursor.x, measureCursor.y]
                .reduce<string[]>((acc, v, i) => {
                  if (i % 2 === 0) acc.push(`${v}`);
                  else acc[acc.length - 1] += `,${v}`;
                  return acc;
                }, [])
                .join(' ')}
              fill={tool === 'measurearea' ? `${MEASURE_COLOR}22` : 'none'}
              stroke={MEASURE_COLOR}
              vectorEffect="non-scaling-stroke"
            />
            {tool === 'measurearea' && measurePts.length >= 4 && (
              <line
                x1={measureCursor.x}
                y1={measureCursor.y}
                x2={measurePts[0]}
                y2={measurePts[1]}
                stroke={MEASURE_COLOR}
                strokeDasharray="0.01 0.008"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <div
            className="measure-live-label"
            data-testid="measure-live-label"
            style={{
              left: `${Math.min(measureCursor.x * 100, 82)}%`,
              top: `${Math.max(measureCursor.y * 100 - 4, 0)}%`,
            }}
          >
            {measureValueFor([...measurePts, measureCursor.x, measureCursor.y])}
          </div>
        </>
      )}
      {snapMarker && (
        <>
          <svg
            className="page-snap-marker"
            data-testid="snap-marker"
            data-snap-type={snapMarker.type}
            viewBox="0 0 16 16"
            width={16}
            height={16}
            aria-hidden="true"
            style={{ left: `${snapMarker.x * 100}%`, top: `${snapMarker.y * 100}%` }}
          >
            <SnapGlyph type={snapMarker.type} />
          </svg>
          <div
            className="page-snap-badge"
            data-testid="snap-type-badge"
            style={{
              left: `${Math.min(snapMarker.x * 100, 84)}%`,
              top: `${Math.max(snapMarker.y * 100 - 4, 0)}%`,
            }}
          >
            {tChrome(SNAP_TYPE_KEY[snapMarker.type])}
          </div>
          {/* The snap type must be available without sight (the spec-95/96
              bar): the badge is visual, this is the announcement. */}
          <div className="page-snap-live" aria-live="polite">
            {tChrome('canvas.snap.announce', {
              type: tChrome(SNAP_TYPE_KEY[snapMarker.type]),
            })}
          </div>
        </>
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
  onMergeNext,
  rotation = 0,
}: {
  para: EditParagraph;
  rect: { x: number; y: number; w: number; h: number };
  lineHeightPx: number;
  onCommit: (value: string, opts?: ParagraphEditOpts) => void;
  onCancel: () => void;
  /** A4/T18: merge into the previous paragraph — provided only when one
   * exists; fires from caret 0. An EDITED editor passes its text along
   * (the merge carries it as the selected side's override). */
  onMergePrev?: (editedText?: string, restyle?: MergeRestyle) => void;
  /** T18: merge the NEXT paragraph into this one — Delete at the end. */
  onMergeNext?: (editedText?: string, restyle?: MergeRestyle) => void;
  /** T18: the page's view rotation — the resize grips map their screen
   * drag back onto the paragraph's inline axis through it. */
  rotation?: number;
}): React.JSX.Element {
  useTranslation();
  const [value, setValue] = useState(para.text);
  // T18: the split gap the NEXT Enter-inside split uses, in leading
  // multiples. 2 = the engine default (not sent); adjustable by typing or
  // by dragging the grip beside the field.
  const [gapField, setGapField] = useState('2');
  const gapVal = ((): number => {
    const v = parseFloat(gapField);
    return Number.isFinite(v) ? Math.max(1.3, Math.min(10, v)) : 2;
  })();
  // T18 resize: the live box width (points) while a grip drags, for the
  // floating readout. null = no drag in flight.
  const [gripPreview, setGripPreview] = useState<number | null>(null);
  // A1 restyle controls, seeded from the paragraph's own size/colour.
  const [size, setSize] = useState(para.fontSize);
  const [color, setColor] = useState(para.color);
  // A3a family swap — '' = keep the original fonts. The options name the
  // ACTUAL substitute faces (Liberation …): the swap is an honest
  // substitution, not a style toggle on the foundry font.
  // 9.T6: '' keeps the original fonts, the three names are the bundled
  // families, and anything else is an ABSOLUTE PATH to an installed face —
  // the engine's own selector grammar, so the picker sends exactly what the
  // op accepts with nothing in between to get out of step.
  const [family, setFamily] = useState<string>('');
  const [installed, setInstalled] = useState<SystemFontListing | null>(getSystemFonts);
  useEffect(() => subscribeSystemFonts(() => setInstalled(getSystemFonts())), []);
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
    family?: string;
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
  const spans0 = computeEditSpans(para.text, value, para.spans, para.runs[0]);
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
  // T21 position-aware relaxation: a char stranded in a span whose font
  // can't encode it reassigns to the nearest span whose run CAN — the
  // commit route applies the identical relaxation (one implementation),
  // so validation and commit can never disagree about the mapping.
  const relaxed =
    substituting || featuresChanged
      ? null
      : relaxUnencodableSpans(value, spans0, para.encodableByRun, para.sequencesByRun);
  const missing = relaxed?.missing ?? [];
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
  // T18: the whole-paragraph restyle deltas a MERGE carries along — the
  // same values a commit would send, minus everything a merge cannot
  // express (per-span ranges, split, features).
  const mergeRestyle = (): MergeRestyle | undefined => {
    const o = restyleOpts();
    const r: MergeRestyle = {};
    if (o.size !== undefined) r.size = o.size;
    if (o.color !== undefined) r.color = o.color;
    if (o.family !== undefined) r.family = o.family;
    if (o.bold !== undefined) r.bold = o.bold;
    if (o.italic !== undefined) r.italic = o.italic;
    return Object.keys(r).length > 0 ? r : undefined;
  };
  // T18 resize: the screen direction of the paragraph's +inline axis under
  // the page's view rotation. Display space is top-left-origin and the card
  // rect is already rotated through rotateNormalizedRect — this table
  // mirrors that helper's clockwise quarter-turn exactly (horizontal
  // paragraphs advance +x at 0°; vertical columns advance +y).
  const inlineDir = ((): [number, number] => {
    const d = ((rotation % 360) + 360) % 360;
    if (!para.vertical) {
      if (d === 90) return [0, 1];
      if (d === 180) return [-1, 0];
      if (d === 270) return [0, -1];
      return [1, 0];
    }
    if (d === 90) return [-1, 0];
    if (d === 180) return [0, -1];
    if (d === 270) return [1, 0];
    return [0, 1];
  })();
  const beginResize = (e: React.PointerEvent<HTMLDivElement>, side: 'start' | 'end'): void => {
    e.preventDefault();
    e.stopPropagation();
    const cell = wrapperRef.current?.parentElement;
    if (!cell) return;
    const ptInline = para.vertical
      ? para.boxPt[3] - para.boxPt[1]
      : para.boxPt[2] - para.boxPt[0];
    const dispInlinePx =
      inlineDir[0] !== 0 ? rect.w * cell.clientWidth : rect.h * cell.clientHeight;
    if (!(ptInline > 0) || !(dispInlinePx > 0)) return;
    const pxPerPt = dispInlinePx / ptInline;
    const startX = e.clientX;
    const startY = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let deltaPt = 0;
    // Native listeners, not React synthetic — the WebView drops synthetic
    // pointermove under capture (the standing canvas-drag rule).
    const onMove = (ev: PointerEvent): void => {
      const along =
        (ev.clientX - startX) * inlineDir[0] + (ev.clientY - startY) * inlineDir[1];
      deltaPt = along / pxPerPt;
      const w = side === 'end' ? ptInline + deltaPt : ptInline - deltaPt;
      setGripPreview(w > 0 ? w : 0);
    };
    const detach = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onAbort);
      setGripPreview(null);
    };
    const onUp = (): void => {
      detach();
      if (Math.abs(deltaPt) < 1) return; // a click is not a resize
      const width = side === 'end' ? ptInline + deltaPt : ptInline - deltaPt;
      if (!(width > 4) || !valid) return; // a sub-4pt box is a mis-drag
      const opts: ParagraphEditOpts = { box_width: width };
      if (side === 'start') {
        // The START edge moved, so the engine must be told the new inline
        // origin. Horizontal: the new x0. Vertical: the transposed left is
        // −(top y) and the top chased the drag.
        opts.box_left = para.vertical
          ? -(para.boxPt[3] - deltaPt)
          : para.boxPt[0] + deltaPt;
      }
      settle(() => onCommit(value, restyleOpts(opts)));
    };
    const onAbort = (): void => detach();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onAbort);
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
              settle(() =>
                onCommit(
                  value,
                  restyleOpts({
                    split_at: caret.start,
                    // T18: only a non-default gap rides — 2.0 keeps the
                    // engine's byte-identical default path.
                    ...(gapVal !== 2 ? { split_gap: gapVal } : {}),
                  }),
                ),
              );
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
          })()
        ) {
          // A4/T18 merge: backspace at the very start joins into the
          // previous paragraph. An EDITED editor's text rides along as the
          // merge's override (one op, one undo) — the old unchanged-only
          // refusal is gone; only an INVALID edit still blocks (the engine
          // would refuse the unencodable text anyway, with less context).
          if (value !== para.text && !valid) return;
          e.preventDefault();
          settle(() => onMergePrev(value !== para.text ? value : undefined, mergeRestyle()));
        } else if (
          e.key === 'Delete' &&
          onMergeNext &&
          areaRef.current &&
          (e.target === areaRef.current || areaRef.current.contains(e.target as Node)) &&
          (() => {
            const c = readEditorSelection(areaRef.current);
            const cpLen = Array.from(value).length;
            return c !== null && c.start === cpLen && c.end === cpLen;
          })()
        ) {
          // T18: Delete at the very end folds the NEXT paragraph into this
          // one — the mirror of Backspace-at-0, edits riding the same way.
          if (value !== para.text && !valid) return;
          e.preventDefault();
          settle(() => onMergeNext(value !== para.text ? value : undefined, mergeRestyle()));
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
      {(['start', 'end'] as const).map((side) => {
        const horizontalGrip = inlineDir[0] !== 0;
        const positive = inlineDir[0] + inlineDir[1] > 0;
        const cls = horizontalGrip
          ? (side === 'end') === positive
            ? 'grip-right'
            : 'grip-left'
          : (side === 'end') === positive
            ? 'grip-bottom'
            : 'grip-top';
        return (
          <div
            key={side}
            data-testid={`edit-para-grip-${side}`}
            className={`page-editpara-grip ${cls}`}
            title={tChrome('canvas.editpara.resizeGrip')}
            onPointerDown={(e) => beginResize(e, side)}
          />
        );
      })}
      {gripPreview !== null && (
        <div className="page-editpara-resize-readout" data-testid="edit-para-resize-readout">
          {tChrome('canvas.editpara.resizeReadout', {
            width: tNumber(Math.round(gripPreview)),
          })}
        </div>
      )}
      <div
        className="page-editpara-toolbar"
        role="group"
        aria-label={tChrome('canvas.editpara.styleGroup')}
      >
        <label className="page-editpara-ctl">
          {tChrome('canvas.editpara.size')}
          <input
            type="number"
            data-testid="edit-para-size"
            min={1}
            max={1638}
            step={1}
            title={tChrome('canvas.editpara.sizeTitle')}
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
        <label
          className="page-editpara-ctl"
          title={tChrome('canvas.editpara.splitGapTitle')}
        >
          {tChrome('canvas.editpara.splitGap')}
          <span
            className="page-editpara-gapgrip"
            data-testid="edit-para-splitgap-grip"
            title={tChrome('canvas.editpara.dragToAdjust')}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const startX = e.clientX;
              const startV = gapVal;
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              // Native listeners under capture — the standing WebView rule.
              const onMove = (ev: PointerEvent): void => {
                const v = Math.max(1.3, Math.min(10, startV + (ev.clientX - startX) * 0.02));
                setGapField(v.toFixed(1));
              };
              const onUp = (): void => {
                el.removeEventListener('pointermove', onMove);
                el.removeEventListener('pointerup', onUp);
              };
              el.addEventListener('pointermove', onMove);
              el.addEventListener('pointerup', onUp);
            }}
          >
            ⇔
          </span>
          <input
            type="number"
            data-testid="edit-para-splitgap"
            min={1.3}
            max={10}
            step={0.1}
            value={gapField}
            onChange={(e) => setGapField(e.target.value)}
          />
        </label>
        <label className="page-editpara-ctl">
          {tChrome('canvas.editpara.colour')}
          <input
            type="color"
            data-testid="edit-para-color"
            value={/^#[0-9a-f]{6}$/i.test(colorField) ? colorField : '#000000'}
            title={tChrome('canvas.editpara.colourTitle')}
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
          {tChrome('canvas.editpara.font')}
          <select
            data-testid="edit-para-family"
            value={family}
            disabled={para.vertical}
            title={tChrome(
              para.vertical
                ? 'canvas.editpara.verticalKeepsFont'
                : 'canvas.editpara.familyTitle',
            )}
            onChange={(e) => {
              // A5b dual role: a real family + a PARTIAL selection → per-span
              // face on that range; otherwise the shipped whole-paragraph
              // family swap.
              const fam = e.target.value;
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
            <option value="">{tChrome('canvas.editpara.keepFont')}</option>
            <optgroup label={tChrome('canvas.editpara.bundled')}>
              <option value="sans">Liberation Sans</option>
              <option value="serif">Liberation Serif</option>
              <option value="mono">Liberation Mono</option>
            </optgroup>
            {installed && installed.families.length > 0 && (
              <optgroup
                label={
                  installed.restricted > 0
                    ? tChrome('canvas.editpara.installedRestricted', {
                        count: tNumber(installed.restricted),
                      })
                    : tChrome('canvas.editpara.installed')
                }
              >
                {installed.families.map((fam) => {
                  // The FAMILY is the choice; the face within it follows the
                  // bold/italic toggles, the same shape the bundled ladder
                  // has. Sending a face path directly would freeze the
                  // weight at whatever the picker happened to list first.
                  const face = pickFace(fam, bold, italic);
                  return face ? (
                    <option key={fam.family} value={face.path}>
                      {fam.family}
                    </option>
                  ) : null;
                })}
              </optgroup>
            )}
          </select>
        </label>
        <button
          type="button"
          data-testid="edit-para-bold"
          className={`page-editpara-style${(faceField ? faceField.bold : bold) ? ' pressed' : ''}`}
          aria-pressed={faceField ? faceField.bold : bold}
          disabled={para.vertical}
          title={tChrome(
            para.vertical ? 'canvas.editpara.verticalKeepsFont' : 'canvas.editpara.boldTitle',
          )}
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
          {tChrome('canvas.editpara.bold')}
        </button>
        <button
          type="button"
          data-testid="edit-para-italic"
          className={`page-editpara-style page-editpara-style-i${(faceField ? faceField.italic : italic) ? ' pressed' : ''}`}
          aria-pressed={faceField ? faceField.italic : italic}
          disabled={para.vertical}
          title={tChrome(
            para.vertical ? 'canvas.editpara.verticalKeepsFont' : 'canvas.editpara.italicTitle',
          )}
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
          {tChrome('canvas.editpara.italic')}
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
          title={tChrome(
            para.vertical ? 'canvas.editpara.verticalKeepsFont' : 'canvas.editpara.smallCapsTitle',
          )}
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
          {tChrome('canvas.editpara.smallCaps')}
        </button>
        <button
          type="button"
          data-testid="edit-para-alternates"
          className={`page-editpara-style${
            (faceField ? faceField.alternates : alternates) ? ' pressed' : ''
          }`}
          aria-pressed={faceField ? faceField.alternates : alternates}
          disabled={para.vertical}
          title={tChrome(
            para.vertical
              ? 'canvas.editpara.verticalKeepsFont'
              : 'canvas.editpara.alternatesTitle',
          )}
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
          {tChrome('canvas.editpara.alternates')}
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
              title={tChrome('canvas.editpara.altIndexTitle')}
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
          aria-label={tChrome('canvas.editpara.textAria')}
          spellCheck={false}
          /* 9.T3: the engine hands back LOGICAL (reading) order for a
             right-to-left paragraph, so the box has to read that way too —
             `dir` is what puts the caret, the selection, Home/End and the
             typing direction the right way round. Explicit "ltr" rather
             than absent: the editor sits inside the app shell, and letting
             an LTR paragraph inherit a direction would be a different bug. */
          dir={para.rtl ? 'rtl' : 'ltr'}
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
            e.preventDefault();
            const sel = liveSel();
            const chars = Array.from(value);
            // T20 rich paste: clipboard HTML whose styling the engine can
            // express lands as the SAME per-span overlays the toolbar
            // writes (colour/face/size ranges → span_styles on commit).
            // Plain payloads — and rich ones that sanitization would have
            // to reshape, which would shear the range offsets — take the
            // shipped plain path unchanged.
            let rich: RichPasteResult | null = null;
            const html = e.clipboardData.getData('text/html');
            if (html) {
              try {
                rich = parseRichHtml(html);
              } catch {
                rich = null;
              }
            }
            if (
              rich &&
              rich.spans.length > 0 &&
              sanitizeParagraphInput(rich.text) !== rich.text
            ) {
              rich = null;
            }
            const pasted =
              rich && rich.spans.length > 0
                ? rich.text
                : sanitizeParagraphInput(e.clipboardData.getData('text/plain'));
            const next = sanitizeParagraphInput(
              chars.slice(0, sel.start).join('') + pasted + chars.slice(sel.end).join(''),
            );
            applyText(next, sel.start + Array.from(pasted).length);
            if (rich && rich.spans.length > 0) {
              // After applyText's remap the pasted range sits at
              // [sel.start, sel.start + len) in the NEW text — the styled
              // ranges land there through the ordinary apply helpers, so
              // preview, flattening, and the commit all treat them exactly
              // like toolbar edits.
              for (const sp of rich.spans) {
                const st = sel.start + sp.start;
                const en = sel.start + sp.end;
                if (sp.style.color) {
                  const [r, g, b] = sp.style.color;
                  const hex = `#${[r, g, b]
                    .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
                    .join('')}`;
                  setSpanColors((prev) => mergeSpanColors(applySpanColor(prev, st, en, hex)));
                }
                if (sp.style.size !== undefined) {
                  setSpanSizes((prev) => mergeSpanSizes(applySpanSize(prev, st, en, sp.style.size!)));
                }
                if (sp.style.bold || sp.style.italic || sp.style.family) {
                  setSpanFaces((prev) =>
                    mergeSpanFaces(
                      applySpanFace(prev, st, en, {
                        bold: Boolean(sp.style.bold),
                        italic: Boolean(sp.style.italic),
                        ...(sp.style.family ? { family: sp.style.family } : {}),
                      }),
                    ),
                  );
                }
              }
            }
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
          {tChrome('canvas.editpara.missingGlyphs', {
            chars: missing.map((c) => `'${c}'`).join(' '),
          })}
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
              {tChrome('canvas.editpara.useCompatibleFont')}
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
  onRestyle,
  onCancel,
}: {
  run: EditTextRun;
  rect: { x: number; y: number; w: number; h: number };
  heightPx: number;
  onCommit: (value: string, opts?: { convert?: boolean }) => void;
  /** T14: commit a size/color restyle instead of a text change. */
  onRestyle?: (style: { size?: number; color?: [number, number, number] }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  useTranslation();
  const [value, setValue] = useState(run.text);
  // T14 style row state: blank size = keep; null color = keep.
  const [styleSize, setStyleSize] = useState('');
  const [styleColor, setStyleColor] = useState<string | null>(null);
  const parsedSize = parseFloat(styleSize);
  const sizeValid = styleSize === '' || (Number.isFinite(parsedSize) && parsedSize > 0);
  const styleChanged = (styleSize !== '' && sizeValid) || styleColor !== null;
  const hexToRgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
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
          {tChrome('canvas.editpara.missingGlyphs', {
            chars: missing.map((c) => `'${c}'`).join(' '),
          })}
          {/* 7.4: the coverage-refusal escape hatch — re-render the run in
              the bundled fallback font. The wrapper's pointerdown
              preventDefault keeps the input focused; click still fires. */}
          <button
            type="button"
            data-testid="edit-text-convert"
            className="page-edittext-convert"
            onClick={() => settle(() => onCommit(value, { convert: true }))}
          >
            {tChrome('canvas.editpara.useCompatibleFont')}
          </button>
        </div>
      )}
      {onRestyle && !changed && (
        // T14: the style row — size + colour for THIS run, text unchanged
        // (it hides the moment the text differs: one commit, one meaning).
        // Family deliberately stays off this surface: run restyle is the
        // fallback for text the paragraph machinery can't take, and a font
        // switch IS that machinery.
        <div className="page-edittext-stylerow" data-testid="edit-text-stylerow">
          <input
            type="number"
            data-testid="edit-text-style-size"
            min={1}
            max={999}
            step="0.5"
            placeholder={tChrome('canvas.edittext.sizePlaceholder', {
              size: tNumber(Math.round(run.fontSize ?? 12)),
            })}
            value={styleSize}
            className={sizeValid ? '' : 'invalid'}
            onChange={(e) => setStyleSize(e.target.value)}
          />
          {['#000000', '#c62828', '#1565c0', '#2e7d32'].map((hex) => (
            <button
              key={hex}
              type="button"
              className={
                'page-edittext-colorchip' + (styleColor === hex ? ' selected' : '')
              }
              style={{ background: hex }}
              title={
                styleColor === hex
                  ? tChrome('canvas.edittext.keepColour')
                  : tChrome('canvas.edittext.colour', { color: hex })
              }
              onClick={() => setStyleColor((cur) => (cur === hex ? null : hex))}
            />
          ))}
          <button
            type="button"
            data-testid="edit-text-style-apply"
            className="page-edittext-convert"
            disabled={!styleChanged}
            onClick={() =>
              settle(() =>
                onRestyle({
                  ...(styleSize !== '' && sizeValid ? { size: parsedSize } : {}),
                  ...(styleColor ? { color: hexToRgb(styleColor) } : {}),
                }),
              )
            }
          >
            {tChrome('canvas.edittext.applyStyle')}
          </button>
        </div>
      )}
    </div>
  );
}

export const PageCell = memo(PageCellImpl);
