import type { CanvasTool, PageAnnotation } from '../../state/types';
import { ANNOTATION_PALETTE } from './PageCell';
import {
  isTransformable,
  isResizable,
  type AlignMode,
  type DistributeMode,
  type SizeMatchMode,
} from '../../lib/annotation-manipulation';

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
  onClose,
}: PropertiesBarProps): React.JSX.Element {
  const a = selected?.annotation ?? null;
  const label = a
    ? a.kind === 'textmarkup'
      ? (MARKUP_LABELS[a.markupType ?? 'highlight'] ?? 'Text markup')
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
