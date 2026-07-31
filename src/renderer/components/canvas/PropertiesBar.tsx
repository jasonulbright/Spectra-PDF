import type { CanvasTool, PageAnnotation } from '../../state/types';
import { ANNOTATION_PALETTE } from './PageCell';

// The Properties Bar (I.6 — Acrobat's Ctrl+E): a contextual strip under the
// secondary toolbar. With an annotation selected (click, Select tool) it shows
// that annotation's properties with quick controls (recolor, delete); with a
// comment mode armed and nothing selected it shows the tool's new-annotation
// color (the same toolColor the secondary toolbar edits — one state, two
// surfaces); otherwise it says how to get a selection. Toggled by Ctrl+E /
// View ▸ Properties Bar; hidden entirely when off.

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
  tool: CanvasTool;
  toolColor: string | null;
  onSetToolColor: (color: string | null) => void;
  onRecolor: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemove: (docId: string, pageId: string, annotationId: string) => void;
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

export function PropertiesBar({
  selected,
  tool,
  toolColor,
  onSetToolColor,
  onRecolor,
  onRemove,
  onClose,
}: PropertiesBarProps): React.JSX.Element {
  const a = selected?.annotation ?? null;
  const label = a
    ? a.kind === 'textmarkup'
      ? (MARKUP_LABELS[a.markupType ?? 'highlight'] ?? 'Text markup')
      : KIND_LABELS[a.kind]
    : null;
  const showToolDefaults = !a && COMMENT_MODES.includes(tool);
  return (
    <div className="properties-bar" data-testid="properties-bar" role="toolbar" aria-label="Properties bar">
      {a && selected ? (
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
          Click a comment with the Select tool to see its properties.
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
