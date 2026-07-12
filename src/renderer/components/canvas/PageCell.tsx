import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageAnnotation, PageRef } from '../../state/types';
import { displayWidthOf } from '../../canvas/layout';
import { projectMarkRect, rotateNormalizedRect } from '../../lib/redaction';
import type { RedactionMark } from '../../lib/redaction';
import type { OcrWord } from '../../ocr/types';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import { PageView } from './PageView';

export type CanvasTool = 'select' | 'highlight' | 'freetext' | 'ink' | 'stamp' | 'redact' | 'signature' | 'forms';

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
  pdf: PDFDocumentProxy | null;
  pageHeight: number;
  renderVersion: number;
  selected: boolean;
  collapsed: boolean;
  visibleNumber: number;
  tool: CanvasTool;
  // Overrides the kind-default color for newly created annotations (color
  // picker in the floating toolbar); undefined keeps the per-kind default.
  annotationColor?: string;
  // Selected stamp preset — required for the Stamp tool to place anything;
  // clicks are ignored while none is picked.
  stampPreset?: StampPreset | null;
  // Pending redaction marks on this page (transient view state — see
  // lib/redaction.ts); undefined when none.
  redactionMarks?: RedactionMark[];
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
  // Add-field sub-mode (2n.4c): while armed, forms mode draws a placement
  // band instead of being inert on empty page area.
  formsAddMode?: boolean;
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
  pdf,
  pageHeight,
  renderVersion,
  selected,
  collapsed,
  visibleNumber,
  tool,
  annotationColor,
  stampPreset,
  redactionMarks,
  signaturePlacement,
  findMatch,
  findWords,
  formWidgets,
  formValues,
  onSetFormValue,
  onSignFieldRequest,
  formsAddMode,
  newFieldPlacement,
  onSetNewFieldRect,
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
  const displayWidth = displayWidthOf(page);
  const annotateMode = tool !== 'select';
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
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
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
          points,
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
    // Forms mode has no rubber band UNLESS the add-field sub-mode is armed
    // (2n.4c) — widgets handle their own pointer events (with
    // stopPropagation), and a press on empty page area must not start a drag
    // or a highlight band under an input.
    if (tool === 'forms' && !formsAddMode) return;
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
      onAddAnnotation(docId, page.id, {
        id: crypto.randomUUID(),
        kind: 'stamp',
        x: Math.max(0, Math.min(1 - STAMP_W, cx - STAMP_W / 2)),
        y: Math.max(0, Math.min(1 - STAMP_H, cy - STAMP_H / 2)),
        w: STAMP_W,
        h: STAMP_H,
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
        } else if (tool === 'forms') {
          // Add-field placement (2n.4c) — single, drawing again replaces it.
          onSetNewFieldRect(docId, page.id, latest, page.rotation);
        } else {
          const annotation: PageAnnotation = {
            id: crypto.randomUUID(),
            kind,
            ...latest,
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
            left: `${a.x * 100}%`,
            top: `${a.y * 100}%`,
            width: `${a.w * 100}%`,
            height: `${a.h * 100}%`,
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
                points={(a.points ?? [])
                  .map((v, i) =>
                    i % 2 === 0 ? (a.w > 0 ? (v - a.x) / a.w : 0.5) : (a.h > 0 ? (v - a.y) / a.h : 0.5),
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
          {a.kind === 'freetext' && editing !== a.id && !pristineImport && (
            <span className="page-annot-text-body">{a.note}</span>
          )}
          {a.kind === 'stamp' && !pristineImport && <span className="page-annot-stamp-label">{a.note}</span>}
          {editing === a.id ? (
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
          formsMode={tool === 'forms'}
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
              {(tool === 'select' || tool === 'forms') && (
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
      {band && (
        <div
          className={
            'page-annot page-annot-band' +
            (tool === 'redact'
              ? ' band-redact'
              : tool === 'signature'
                ? ' band-signature'
                : tool === 'forms'
                  ? ' band-formfield'
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

export const PageCell = memo(PageCellImpl);
