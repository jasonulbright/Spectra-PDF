import { useTranslation } from 'react-i18next';
import type { CanvasTool, PageAnnotation } from '../../state/types';
import { ANNOTATION_PALETTE, defaultToolColor } from './PageCell';
import {
  isTransformable,
  isResizable,
  isRotatable,
  type AlignMode,
  type DistributeMode,
  type FlipAxis,
  type RotateDirection,
  type SizeMatchMode,
} from '../../lib/annotation-manipulation';
import { tChrome, tChromeCount, tNumber, type UiKey } from '../../i18n';

/** Kinds the style controls (stroke width / opacity / fill) apply to. */
const styleable = (a: PageAnnotation): boolean =>
  a.kind === 'shape' || a.kind === 'callout' || a.kind === 'ink';
const fillable = (a: PageAnnotation): boolean => a.kind === 'shape' || a.kind === 'callout';

// The Properties Bar is a contextual strip under the
// secondary toolbar. With ONE annotation selected (click, Select tool) it
// shows that annotation's properties with quick controls (recolor, delete,
// z-order); with SEVERAL selected (ctrl-click / ctrl-marquee, rung 1) it
// becomes the group bar — align, distribute, match size, z-order, recolor
// all, delete all; with a comment mode armed and nothing selected it shows
// the tool's new-annotation color (the same toolColor the secondary toolbar
// edits — one state, two surfaces); otherwise it says how to get a
// selection. Toggled by Ctrl+E / View ▸ Properties Bar; hidden when off.

export interface SelectedAnnotationInfo {
  docId: string;
  pageId: string;
  pageNumber: number; // 1-based within its document
  annotation: PageAnnotation;
  pageWidth: number; // page points at scale 1 (pdf.js viewport units)
  pageHeight: number;
}

interface PropertiesBarProps {
  selected: SelectedAnnotationInfo | null;
  // The full selection (equals [selected.annotation] when single). Group
  // controls appear from 2 up; z-order shows for any selection.
  selectedGroup: readonly PageAnnotation[];
  tool: CanvasTool;
  toolColor: string | null;
  onSetToolColor: (color: string | null) => void;
  onRecolor: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemove: (docId: string, pageId: string, annotationId: string) => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (mode: DistributeMode) => void;
  onSizeMatch: (mode: SizeMatchMode) => void;
  onReorder: (direction: 'front' | 'back' | 'forward' | 'backward') => void;
  onRecolorGroup: (color: string) => void;
  onRemoveGroup: () => void;
  /** Shared style edit (rung 2 + the sheets) — the reducer applies each
   * field only to kinds that carry it. */
  onRestyle: (style: {
    strokeWidth?: number;
    fillColor?: string | null;
    opacity?: number;
    lineEndings?: [string, string];
    cloudIntensity?: number;
  }) => void;
  /** Quarter-turn / mirror for the vertex kinds (residual). */
  onRotateFlip: (op: { rotate: RotateDirection } | { flip: FlipAxis }) => void;
  onClose: () => void;
}

const KIND_KEYS: Record<PageAnnotation['kind'], UiKey> = {
  highlight: 'canvas.pbar.kind.highlight',
  freetext: 'canvas.pbar.kind.freetext',
  ink: 'canvas.pbar.kind.ink',
  stamp: 'canvas.pbar.kind.stamp',
  textmarkup: 'canvas.pbar.kind.textmarkup',
  note: 'canvas.pbar.kind.note',
  measure: 'canvas.pbar.kind.measure',
  shape: 'canvas.pbar.kind.shape',
  callout: 'canvas.pbar.kind.callout',
  count: 'canvas.pbar.kind.count',
  countlegend: 'canvas.pbar.kind.countlegend',
};

// The shape names are the SAME words the secondary toolbar's shape picker
// shows, so they read the same keys — a second copy would let one strip call
// a figure an Ellipse while the other calls it an Oval in the same language.
const SHAPE_KEYS: Record<string, UiKey> = {
  rect: 'canvas.shape.rect',
  ellipse: 'canvas.shape.ellipse',
  line: 'canvas.shape.line',
  arrow: 'canvas.shape.arrow',
  polygon: 'canvas.shape.polygon',
  polyline: 'canvas.shape.polyline',
  cloud: 'canvas.shape.cloud',
};

const MARKUP_KEYS: Record<string, UiKey> = {
  highlight: 'canvas.pbar.markup.highlight',
  underline: 'canvas.pbar.markup.underline',
  strikeout: 'canvas.pbar.markup.strikeout',
  squiggly: 'canvas.pbar.markup.squiggly',
};

/** The "New <mode> color" heading, one whole sentence per comment mode. */
const NEW_COLOR_KEYS: Record<string, UiKey> = {
  highlight: 'canvas.pbar.newColor.highlight',
  freetext: 'canvas.pbar.newColor.freetext',
  ink: 'canvas.pbar.newColor.ink',
  inkhighlight: 'canvas.pbar.newColor.inkhighlight',
  stamp: 'canvas.pbar.newColor.stamp',
};

// The comment modes whose tool defaults the bar can show.
const COMMENT_MODES: readonly CanvasTool[] = [
  'highlight', 'inkhighlight', 'freetext', 'ink', 'stamp',
];

// The align wording is shared with the image align/distribute row on the
// secondary toolbar — same glyphs, same sentence, one key each.
const ALIGN_BUTTONS: { mode: AlignMode; key: UiKey; glyph: string }[] = [
  { mode: 'left', key: 'canvas.edit.alignLeft', glyph: '⭰' },
  { mode: 'centerH', key: 'canvas.edit.alignCenterh', glyph: '⇹' },
  { mode: 'right', key: 'canvas.edit.alignRight', glyph: '⭲' },
  { mode: 'top', key: 'canvas.edit.alignTop', glyph: '⭱' },
  { mode: 'centerV', key: 'canvas.edit.alignCenterv', glyph: '⇳' },
  { mode: 'bottom', key: 'canvas.edit.alignBottom', glyph: '⭳' },
];

const ZORDER_BUTTONS: { dir: 'front' | 'forward' | 'backward' | 'back'; key: UiKey; glyph: string }[] = [
  { dir: 'front', key: 'canvas.pbar.z.front', glyph: '⤒' },
  { dir: 'forward', key: 'canvas.pbar.z.forward', glyph: '↑' },
  { dir: 'backward', key: 'canvas.pbar.z.backward', glyph: '↓' },
  { dir: 'back', key: 'canvas.pbar.z.back', glyph: '⤓' },
];

export function PropertiesBar({
  selected,
  selectedGroup,
  tool,
  toolColor,
  onSetToolColor,
  onRecolor,
  onRemove,
  onAlign,
  onDistribute,
  onSizeMatch,
  onReorder,
  onRecolorGroup,
  onRemoveGroup,
  onRestyle,
  onRotateFlip,
  onClose,
}: PropertiesBarProps): React.JSX.Element {
  useTranslation();
  const a = selected?.annotation ?? null;
  const label = a
    ? a.kind === 'textmarkup'
      ? tChrome(MARKUP_KEYS[a.markupType ?? 'highlight'] ?? 'canvas.pbar.kind.textmarkup')
      : a.kind === 'shape'
        ? tChrome(SHAPE_KEYS[a.shapeType ?? 'rect'] ?? 'canvas.pbar.kind.shape')
        : tChrome(KIND_KEYS[a.kind])
    : null;
  const multi = selectedGroup.length > 1;
  const movableCount = selectedGroup.filter(isTransformable).length;
  const resizableCount = selectedGroup.filter(isResizable).length;
  const showToolDefaults = !a && !multi && COMMENT_MODES.includes(tool);
  const zOrder = (
    <span
      className="properties-bar-swatches"
      role="group"
      aria-label={tChrome('canvas.pbar.zorderGroup')}
    >
      {ZORDER_BUTTONS.map((b) => (
        <button
          key={b.dir}
          type="button"
          data-testid={`pbar-z-${b.dir}`}
          className="properties-bar-action"
          title={tChrome(b.key)}
          aria-label={tChrome(b.key)}
          onClick={() => onReorder(b.dir)}
        >
          {b.glyph}
        </button>
      ))}
    </span>
  );
  // Style controls (rung 2): shown when the selection carries any styleable
  // kind. Values seed from the FIRST styleable member; edits apply to all.
  const styleRef = selectedGroup.find(styleable) ?? null;
  const anyFillable = selectedGroup.some(fillable);
  const styleControls = styleRef ? (
    <span
      className="properties-bar-swatches"
      role="group"
      aria-label={tChrome('canvas.pbar.styleGroup')}
    >
      <select
        data-testid="pbar-stroke-width"
        className="properties-bar-select"
        title={tChrome('canvas.pbar.strokeWidth')}
        aria-label={tChrome('canvas.pbar.strokeWidth')}
        value={String(styleRef.strokeWidth ?? (styleRef.kind === 'callout' ? 1 : 2))}
        onChange={(e) => onRestyle({ strokeWidth: parseFloat(e.target.value) })}
      >
        {['1', '2', '3', '4', '6', '8', '12'].map((v) => (
          <option key={v} value={v}>
            {tChrome('canvas.pbar.strokeWidthOption', { width: tNumber(Number(v)) })}
          </option>
        ))}
      </select>
      <select
        data-testid="pbar-opacity"
        className="properties-bar-select"
        title={tChrome('canvas.pbar.opacity')}
        aria-label={tChrome('canvas.pbar.opacity')}
        value={String(Math.round((styleRef.opacity ?? 1) * 100))}
        onChange={(e) => onRestyle({ opacity: parseInt(e.target.value, 10) / 100 })}
      >
        {['25', '50', '75', '100'].map((v) => (
          <option key={v} value={v}>
            {tChrome('canvas.pbar.opacityOption', { percent: tNumber(Number(v)) })}
          </option>
        ))}
      </select>
      {anyFillable && (
        <>
          <button
            type="button"
            data-testid="pbar-fill-none"
            className={'properties-bar-action' + (styleRef.fillColor ? '' : ' active')}
            title={tChrome('canvas.pbar.noFill')}
            aria-label={tChrome('canvas.pbar.noFill')}
            onClick={() => onRestyle({ fillColor: null })}
          >
            ∅
          </button>
          {ANNOTATION_PALETTE.map((c) => (
            <button
              key={`fill-${c}`}
              type="button"
              data-testid={`pbar-fill-${c.slice(1)}`}
              className={'properties-bar-swatch color-swatch pbar-fill-swatch' + (styleRef.fillColor === c ? ' is-selected' : '')}
              style={{ backgroundColor: c }}
              title={tChrome('canvas.pbar.fillWith', { color: c })}
              aria-pressed={styleRef.fillColor === c}
              onClick={() => onRestyle({ fillColor: c })}
            />
          ))}
        </>
      )}
    </span>
  ) : null;
  // Rotate/flip (residual): only the vertex kinds — their geometry is
  // the point list, so a quarter-turn is exactly representable in the file.
  const anyRotatable = selectedGroup.some(isRotatable);
  const rotateFlip = anyRotatable ? (
    <span
      className="properties-bar-swatches"
      role="group"
      aria-label={tChrome('canvas.pbar.rotateFlipGroup')}
    >
      <button
        type="button"
        data-testid="pbar-rotate-ccw"
        className="properties-bar-action"
        title={tChrome('canvas.edit.rotateCcw')}
        aria-label={tChrome('canvas.edit.rotateCcw')}
        onClick={() => onRotateFlip({ rotate: 'ccw' })}
      >
        ⟲
      </button>
      <button
        type="button"
        data-testid="pbar-rotate-cw"
        className="properties-bar-action"
        title={tChrome('canvas.edit.rotateCw')}
        aria-label={tChrome('canvas.edit.rotateCw')}
        onClick={() => onRotateFlip({ rotate: 'cw' })}
      >
        ⟳
      </button>
      <button
        type="button"
        data-testid="pbar-flip-h"
        className="properties-bar-action"
        title={tChrome('canvas.pbar.flipH')}
        aria-label={tChrome('canvas.pbar.flipH')}
        onClick={() => onRotateFlip({ flip: 'h' })}
      >
        ⇋
      </button>
      <button
        type="button"
        data-testid="pbar-flip-v"
        className="properties-bar-action"
        title={tChrome('canvas.pbar.flipV')}
        aria-label={tChrome('canvas.pbar.flipV')}
        onClick={() => onRotateFlip({ flip: 'v' })}
      >
        ⇵
      </button>
    </span>
  ) : null;
  // Kind-specific sheets (residual): endings for the open figures,
  // intensity for clouds — over the same shared-restyle seam.
  const endingsRef =
    selectedGroup.find(
      (m) =>
        m.kind === 'shape' &&
        (m.shapeType === 'line' || m.shapeType === 'arrow' || m.shapeType === 'polyline'),
    ) ?? null;
  const cloudRef =
    selectedGroup.find((m) => m.kind === 'shape' && m.shapeType === 'cloud') ?? null;
  const ENDING_OPTIONS = ['None', 'OpenArrow', 'ClosedArrow'] as const;
  // One key per (ending, which-end) pair — "Open arrow" + " start" would be
  // two glued fragments, and their order is not universal.
  const endingKey = (v: string, end: 'Start' | 'End'): UiKey =>
    `canvas.pbar.ending${end}.${v}` as UiKey;
  const kindSheet = (endingsRef || cloudRef) ? (
    <span
      className="properties-bar-swatches"
      role="group"
      aria-label={tChrome('canvas.pbar.shapeOptionsGroup')}
    >
      {endingsRef && (
        <>
          <select
            data-testid="pbar-ending-start"
            className="properties-bar-select"
            title={tChrome('canvas.pbar.lineStart')}
            aria-label={tChrome('canvas.pbar.lineStart')}
            value={endingsRef.lineEndings?.[0] ?? 'None'}
            onChange={(e) =>
              onRestyle({
                lineEndings: [e.target.value, endingsRef.lineEndings?.[1] ?? 'None'],
              })}
          >
            {ENDING_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {tChrome(endingKey(v, 'Start'))}
              </option>
            ))}
          </select>
          <select
            data-testid="pbar-ending-end"
            className="properties-bar-select"
            title={tChrome('canvas.pbar.lineEnd')}
            aria-label={tChrome('canvas.pbar.lineEnd')}
            value={endingsRef.lineEndings?.[1] ?? (endingsRef.shapeType === 'arrow' ? 'OpenArrow' : 'None')}
            onChange={(e) =>
              onRestyle({
                lineEndings: [endingsRef.lineEndings?.[0] ?? 'None', e.target.value],
              })}
          >
            {ENDING_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {tChrome(endingKey(v, 'End'))}
              </option>
            ))}
          </select>
        </>
      )}
      {cloudRef && (
        <select
          data-testid="pbar-cloud-intensity"
          className="properties-bar-select"
          title={tChrome('canvas.pbar.cloudIntensity')}
          aria-label={tChrome('canvas.pbar.cloudIntensity')}
          value={String(cloudRef.cloudIntensity ?? 2)}
          onChange={(e) => onRestyle({ cloudIntensity: parseInt(e.target.value, 10) })}
        >
          {['1', '2', '3'].map((v) => (
            <option key={v} value={v}>
              {tChrome('canvas.pbar.cloudOption', { level: tNumber(Number(v)) })}
            </option>
          ))}
        </select>
      )}
    </span>
  ) : null;
  return (
    <div
      className="properties-bar"
      data-testid="properties-bar"
      role="toolbar"
      aria-label={tChrome('canvas.pbar.barLabel')}
    >
      {multi ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">
            {tChromeCount('canvas.pbar.selectedCount', selectedGroup.length)}
          </span>
          {movableCount >= 2 && (
            <span
              className="properties-bar-swatches"
              role="group"
              aria-label={tChrome('canvas.pbar.alignGroup')}
            >
              {ALIGN_BUTTONS.map((b) => (
                <button
                  key={b.mode}
                  type="button"
                  data-testid={`pbar-align-${b.mode}`}
                  className="properties-bar-action"
                  title={tChrome(b.key)}
                  aria-label={tChrome(b.key)}
                  onClick={() => onAlign(b.mode)}
                >
                  {b.glyph}
                </button>
              ))}
            </span>
          )}
          {movableCount >= 3 && (
            <span
              className="properties-bar-swatches"
              role="group"
              aria-label={tChrome('canvas.pbar.distributeGroup')}
            >
              <button
                type="button"
                data-testid="pbar-distribute-horizontal"
                className="properties-bar-action"
                title={tChrome('canvas.edit.alignDisth')}
                aria-label={tChrome('canvas.pbar.distHAria')}
                onClick={() => onDistribute('horizontal')}
              >
                ⇢⇠
              </button>
              <button
                type="button"
                data-testid="pbar-distribute-vertical"
                className="properties-bar-action"
                title={tChrome('canvas.edit.alignDistv')}
                aria-label={tChrome('canvas.pbar.distVAria')}
                onClick={() => onDistribute('vertical')}
              >
                ⇣⇡
              </button>
            </span>
          )}
          {resizableCount >= 2 && (
            <span
              className="properties-bar-swatches"
              role="group"
              aria-label={tChrome('canvas.pbar.matchSizeGroup')}
            >
              <button
                type="button"
                data-testid="pbar-size-width"
                className="properties-bar-action"
                title={tChrome('canvas.pbar.matchWidths')}
                aria-label={tChrome('canvas.pbar.matchWidthsAria')}
                onClick={() => onSizeMatch('width')}
              >
                ⭤
              </button>
              <button
                type="button"
                data-testid="pbar-size-height"
                className="properties-bar-action"
                title={tChrome('canvas.pbar.matchHeights')}
                aria-label={tChrome('canvas.pbar.matchHeightsAria')}
                onClick={() => onSizeMatch('height')}
              >
                ⭥
              </button>
              <button
                type="button"
                data-testid="pbar-size-both"
                className="properties-bar-action"
                title={tChrome('canvas.pbar.matchBoth')}
                aria-label={tChrome('canvas.pbar.matchBothAria')}
                onClick={() => onSizeMatch('both')}
              >
                ⛶
              </button>
            </span>
          )}
          {styleControls}
          {kindSheet}
          {rotateFlip}
          {zOrder}
          <span
            className="properties-bar-swatches"
            role="group"
            aria-label={tChrome('canvas.pbar.recolorAllGroup')}
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-color-${c.slice(1)}`}
                className="properties-bar-swatch color-swatch"
                style={{ backgroundColor: c }}
                title={tChrome('canvas.pbar.recolorAll', { color: c })}
                onClick={() => onRecolorGroup(c)}
              />
            ))}
          </span>
          <button
            type="button"
            data-testid="pbar-delete"
            className="properties-bar-action"
            onClick={() => onRemoveGroup()}
          >
            {tChrome('canvas.common.delete')}
          </button>
        </>
      ) : a && selected ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">{label}</span>
          <span className="properties-bar-meta" data-testid="pbar-place">
            {tChrome('canvas.pbar.place', {
              page: tNumber(selected.pageNumber),
              width: tNumber(Math.round(a.w * selected.pageWidth)),
              height: tNumber(Math.round(a.h * selected.pageHeight)),
            })}
          </span>
          {a.note !== undefined && a.note !== '' && (
            <span className="properties-bar-note" title={a.note} data-testid="pbar-note">
              {tChrome('canvas.pbar.note', {
                note: a.note.length > 40 ? `${a.note.slice(0, 39)}…` : a.note,
              })}
            </span>
          )}
          <span
            className="properties-bar-swatches"
            role="group"
            aria-label={tChrome('canvas.pbar.colorGroup')}
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-color-${c.slice(1)}`}
                className={'properties-bar-swatch color-swatch' + (a.color === c ? ' is-selected' : '')}
                style={{ backgroundColor: c }}
                title={tChrome('canvas.pbar.recolorTo', { color: c })}
                aria-pressed={a.color === c}
                onClick={() => onRecolor(selected.docId, selected.pageId, a.id, c)}
              />
            ))}
          </span>
          {styleControls}
          {kindSheet}
          {rotateFlip}
          {zOrder}
          <button
            type="button"
            data-testid="pbar-delete"
            className="properties-bar-action"
            onClick={() => onRemove(selected.docId, selected.pageId, a.id)}
          >
            {tChrome('canvas.common.delete')}
          </button>
        </>
      ) : showToolDefaults ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">
            {tChrome(NEW_COLOR_KEYS[tool] ?? 'canvas.pbar.newColorGroup')}
          </span>
          <span
            className="properties-bar-swatches"
            role="group"
            aria-label={tChrome('canvas.pbar.newColorGroup')}
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-tool-color-${c.slice(1)}`}
                className={'properties-bar-swatch color-swatch' + ((toolColor ?? defaultToolColor(tool)) === c ? ' is-selected' : '')}
                style={{ backgroundColor: c }}
                title={tChrome('canvas.pbar.useForNew', { color: c })}
                aria-pressed={toolColor === c}
                onClick={() => onSetToolColor(toolColor === c ? null : c)}
              />
            ))}
          </span>
        </>
      ) : (
        <span className="properties-bar-empty" data-testid="pbar-empty">
          {tChrome('canvas.pbar.empty')}
        </span>
      )}
      <button
        type="button"
        className="properties-bar-close"
        data-testid="pbar-close"
        title={tChrome('canvas.pbar.close')}
        aria-label={tChrome('canvas.pbar.closeAria')}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
