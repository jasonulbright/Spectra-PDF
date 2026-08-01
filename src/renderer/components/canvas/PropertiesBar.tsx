import type { CanvasTool, PageAnnotation } from '../../state/types';
import { ANNOTATION_PALETTE } from './PageCell';
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

/** Kinds the style controls (stroke width / opacity / fill) apply to. */
const styleable = (a: PageAnnotation): boolean =>
  a.kind === 'shape' || a.kind === 'callout' || a.kind === 'ink';
const fillable = (a: PageAnnotation): boolean => a.kind === 'shape' || a.kind === 'callout';

// The Properties Bar (I.6 — Acrobat's Ctrl+E): a contextual strip under the
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
  /** Shared style edit (rung 2 + the N7 sheets) — the reducer applies each
   * field only to kinds that carry it. */
  onRestyle: (style: {
    strokeWidth?: number;
    fillColor?: string | null;
    opacity?: number;
    lineEndings?: [string, string];
    cloudIntensity?: number;
  }) => void;
  /** Quarter-turn / mirror for the vertex kinds (N7 residual). */
  onRotateFlip: (op: { rotate: RotateDirection } | { flip: FlipAxis }) => void;
  onClose: () => void;
}

const KIND_LABELS: Record<PageAnnotation['kind'], string> = {
  highlight: 'Highlight box',
  freetext: 'Text box',
  ink: 'Ink stroke',
  stamp: 'Stamp',
  textmarkup: 'Text markup',
  note: 'Sticky note',
  measure: 'Measurement',
  shape: 'Shape',
  callout: 'Callout',
};

const SHAPE_LABELS: Record<string, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  polygon: 'Polygon',
  polyline: 'Polyline',
  cloud: 'Cloud',
};

const MARKUP_LABELS: Record<string, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strike out',
  squiggly: 'Squiggly',
};

// The comment modes whose tool defaults the bar can show.
const COMMENT_MODES: readonly CanvasTool[] = ['highlight', 'freetext', 'ink', 'stamp'];

const ALIGN_BUTTONS: { mode: AlignMode; label: string; glyph: string }[] = [
  { mode: 'left', label: 'Align left edges', glyph: '⭰' },
  { mode: 'centerH', label: 'Align horizontal centers', glyph: '⇹' },
  { mode: 'right', label: 'Align right edges', glyph: '⭲' },
  { mode: 'top', label: 'Align top edges', glyph: '⭱' },
  { mode: 'centerV', label: 'Align vertical centers', glyph: '⇳' },
  { mode: 'bottom', label: 'Align bottom edges', glyph: '⭳' },
];

const ZORDER_BUTTONS: { dir: 'front' | 'forward' | 'backward' | 'back'; label: string; glyph: string }[] = [
  { dir: 'front', label: 'Bring to front', glyph: '⤒' },
  { dir: 'forward', label: 'Bring forward', glyph: '↑' },
  { dir: 'backward', label: 'Send backward', glyph: '↓' },
  { dir: 'back', label: 'Send to back', glyph: '⤓' },
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
  const a = selected?.annotation ?? null;
  const label = a
    ? a.kind === 'textmarkup'
      ? (MARKUP_LABELS[a.markupType ?? 'highlight'] ?? 'Text markup')
      : a.kind === 'shape'
        ? (SHAPE_LABELS[a.shapeType ?? 'rect'] ?? 'Shape')
        : KIND_LABELS[a.kind]
    : null;
  const multi = selectedGroup.length > 1;
  const movableCount = selectedGroup.filter(isTransformable).length;
  const resizableCount = selectedGroup.filter(isResizable).length;
  const showToolDefaults = !a && !multi && COMMENT_MODES.includes(tool);
  const zOrder = (
    <span className="properties-bar-swatches" role="group" aria-label="Z-order">
      {ZORDER_BUTTONS.map((b) => (
        <button
          key={b.dir}
          type="button"
          data-testid={`pbar-z-${b.dir}`}
          className="properties-bar-action"
          title={b.label}
          aria-label={b.label}
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
    <span className="properties-bar-swatches" role="group" aria-label="Style">
      <select
        data-testid="pbar-stroke-width"
        className="properties-bar-select"
        title="Stroke width"
        aria-label="Stroke width"
        value={String(styleRef.strokeWidth ?? (styleRef.kind === 'callout' ? 1 : 2))}
        onChange={(e) => onRestyle({ strokeWidth: parseFloat(e.target.value) })}
      >
        {['1', '2', '3', '4', '6', '8', '12'].map((v) => (
          <option key={v} value={v}>
            {v} pt
          </option>
        ))}
      </select>
      <select
        data-testid="pbar-opacity"
        className="properties-bar-select"
        title="Opacity"
        aria-label="Opacity"
        value={String(Math.round((styleRef.opacity ?? 1) * 100))}
        onChange={(e) => onRestyle({ opacity: parseInt(e.target.value, 10) / 100 })}
      >
        {['25', '50', '75', '100'].map((v) => (
          <option key={v} value={v}>
            {v}%
          </option>
        ))}
      </select>
      {anyFillable && (
        <>
          <button
            type="button"
            data-testid="pbar-fill-none"
            className={'properties-bar-action' + (styleRef.fillColor ? '' : ' active')}
            title="No fill"
            aria-label="No fill"
            onClick={() => onRestyle({ fillColor: null })}
          >
            ∅
          </button>
          {ANNOTATION_PALETTE.map((c) => (
            <button
              key={`fill-${c}`}
              type="button"
              data-testid={`pbar-fill-${c.slice(1)}`}
              className={'properties-bar-swatch pbar-fill-swatch' + (styleRef.fillColor === c ? ' active' : '')}
              style={{ backgroundColor: c }}
              title={`Fill with ${c}`}
              aria-pressed={styleRef.fillColor === c}
              onClick={() => onRestyle({ fillColor: c })}
            />
          ))}
        </>
      )}
    </span>
  ) : null;
  // Rotate/flip (N7 residual): only the vertex kinds — their geometry is
  // the point list, so a quarter-turn is exactly representable in the file.
  const anyRotatable = selectedGroup.some(isRotatable);
  const rotateFlip = anyRotatable ? (
    <span className="properties-bar-swatches" role="group" aria-label="Rotate and flip">
      <button
        type="button"
        data-testid="pbar-rotate-ccw"
        className="properties-bar-action"
        title="Rotate 90° counter-clockwise"
        aria-label="Rotate 90° counter-clockwise"
        onClick={() => onRotateFlip({ rotate: 'ccw' })}
      >
        ⟲
      </button>
      <button
        type="button"
        data-testid="pbar-rotate-cw"
        className="properties-bar-action"
        title="Rotate 90° clockwise"
        aria-label="Rotate 90° clockwise"
        onClick={() => onRotateFlip({ rotate: 'cw' })}
      >
        ⟳
      </button>
      <button
        type="button"
        data-testid="pbar-flip-h"
        className="properties-bar-action"
        title="Flip horizontal"
        aria-label="Flip horizontal"
        onClick={() => onRotateFlip({ flip: 'h' })}
      >
        ⇋
      </button>
      <button
        type="button"
        data-testid="pbar-flip-v"
        className="properties-bar-action"
        title="Flip vertical"
        aria-label="Flip vertical"
        onClick={() => onRotateFlip({ flip: 'v' })}
      >
        ⇵
      </button>
    </span>
  ) : null;
  // Kind-specific sheets (N7 residual): endings for the open figures,
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
  const ENDING_LABELS: Record<string, string> = {
    None: 'Plain',
    OpenArrow: 'Open arrow',
    ClosedArrow: 'Closed arrow',
  };
  const kindSheet = (endingsRef || cloudRef) ? (
    <span className="properties-bar-swatches" role="group" aria-label="Shape options">
      {endingsRef && (
        <>
          <select
            data-testid="pbar-ending-start"
            className="properties-bar-select"
            title="Line start"
            aria-label="Line start"
            value={endingsRef.lineEndings?.[0] ?? 'None'}
            onChange={(e) =>
              onRestyle({
                lineEndings: [e.target.value, endingsRef.lineEndings?.[1] ?? 'None'],
              })}
          >
            {ENDING_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {ENDING_LABELS[v]} start
              </option>
            ))}
          </select>
          <select
            data-testid="pbar-ending-end"
            className="properties-bar-select"
            title="Line end"
            aria-label="Line end"
            value={endingsRef.lineEndings?.[1] ?? (endingsRef.shapeType === 'arrow' ? 'OpenArrow' : 'None')}
            onChange={(e) =>
              onRestyle({
                lineEndings: [endingsRef.lineEndings?.[0] ?? 'None', e.target.value],
              })}
          >
            {ENDING_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {ENDING_LABELS[v]} end
              </option>
            ))}
          </select>
        </>
      )}
      {cloudRef && (
        <select
          data-testid="pbar-cloud-intensity"
          className="properties-bar-select"
          title="Cloud intensity"
          aria-label="Cloud intensity"
          value={String(cloudRef.cloudIntensity ?? 2)}
          onChange={(e) => onRestyle({ cloudIntensity: parseInt(e.target.value, 10) })}
        >
          {['1', '2', '3'].map((v) => (
            <option key={v} value={v}>
              Cloud {v}
            </option>
          ))}
        </select>
      )}
    </span>
  ) : null;
  return (
    <div className="properties-bar" data-testid="properties-bar" role="toolbar" aria-label="Properties bar">
      {multi ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">
            {selectedGroup.length} selected
          </span>
          {movableCount >= 2 && (
            <span className="properties-bar-swatches" role="group" aria-label="Align">
              {ALIGN_BUTTONS.map((b) => (
                <button
                  key={b.mode}
                  type="button"
                  data-testid={`pbar-align-${b.mode}`}
                  className="properties-bar-action"
                  title={b.label}
                  aria-label={b.label}
                  onClick={() => onAlign(b.mode)}
                >
                  {b.glyph}
                </button>
              ))}
            </span>
          )}
          {movableCount >= 3 && (
            <span className="properties-bar-swatches" role="group" aria-label="Distribute">
              <button
                type="button"
                data-testid="pbar-distribute-horizontal"
                className="properties-bar-action"
                title="Distribute horizontally (even gaps)"
                aria-label="Distribute horizontally"
                onClick={() => onDistribute('horizontal')}
              >
                ⇢⇠
              </button>
              <button
                type="button"
                data-testid="pbar-distribute-vertical"
                className="properties-bar-action"
                title="Distribute vertically (even gaps)"
                aria-label="Distribute vertically"
                onClick={() => onDistribute('vertical')}
              >
                ⇣⇡
              </button>
            </span>
          )}
          {resizableCount >= 2 && (
            <span className="properties-bar-swatches" role="group" aria-label="Match size">
              <button
                type="button"
                data-testid="pbar-size-width"
                className="properties-bar-action"
                title="Match widths (to the first selected)"
                aria-label="Match widths"
                onClick={() => onSizeMatch('width')}
              >
                ⭤
              </button>
              <button
                type="button"
                data-testid="pbar-size-height"
                className="properties-bar-action"
                title="Match heights (to the first selected)"
                aria-label="Match heights"
                onClick={() => onSizeMatch('height')}
              >
                ⭥
              </button>
              <button
                type="button"
                data-testid="pbar-size-both"
                className="properties-bar-action"
                title="Match size (to the first selected)"
                aria-label="Match size"
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
          <span className="properties-bar-swatches" role="group" aria-label="Recolor all">
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-color-${c.slice(1)}`}
                className="properties-bar-swatch"
                style={{ backgroundColor: c }}
                title={`Recolor all to ${c}`}
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
            Delete
          </button>
        </>
      ) : a && selected ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">{label}</span>
          <span className="properties-bar-meta" data-testid="pbar-place">
            p.{selected.pageNumber} ·{' '}
            {Math.round(a.w * selected.pageWidth)}×{Math.round(a.h * selected.pageHeight)} pt
          </span>
          {a.note !== undefined && a.note !== '' && (
            <span className="properties-bar-note" title={a.note} data-testid="pbar-note">
              “{a.note.length > 40 ? `${a.note.slice(0, 39)}…` : a.note}”
            </span>
          )}
          <span className="properties-bar-swatches" role="group" aria-label="Color">
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-color-${c.slice(1)}`}
                className={'properties-bar-swatch' + (a.color === c ? ' active' : '')}
                style={{ backgroundColor: c }}
                title={`Recolor to ${c}`}
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
            Delete
          </button>
        </>
      ) : showToolDefaults ? (
        <>
          <span className="properties-bar-kind" data-testid="pbar-kind">
            New {tool === 'freetext' ? 'text box' : tool} color
          </span>
          <span className="properties-bar-swatches" role="group" aria-label="New annotation color">
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`pbar-tool-color-${c.slice(1)}`}
                className={'properties-bar-swatch' + (toolColor === c ? ' active' : '')}
                style={{ backgroundColor: c }}
                title={`Use ${c} for new annotations`}
                aria-pressed={toolColor === c}
                onClick={() => onSetToolColor(toolColor === c ? null : c)}
              />
            ))}
          </span>
        </>
      ) : (
        <span className="properties-bar-empty" data-testid="pbar-empty">
          Click a comment with the Select tool to see its properties — Ctrl-click or Ctrl-drag for several.
        </span>
      )}
      <button
        type="button"
        className="properties-bar-close"
        data-testid="pbar-close"
        title="Hide the properties bar (Ctrl+E)"
        aria-label="Hide the properties bar"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
