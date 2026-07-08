import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageAnnotation, PageRef } from '../../state/types';
import { displayWidthOf } from '../../canvas/layout';
import { PageView } from './PageView';

export type CanvasTool = 'select' | 'highlight' | 'freetext';

export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HIGHLIGHT_COLOR = '#ffd54a';
const FREETEXT_COLOR = '#16161a';
const FREETEXT_FONT_PT = 12;

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
  onSelectPage: (docId: string, pageId: string) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  onPagePointerDown: (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>) => void;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
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
  onSelectPage,
  onOpenPage,
  onPageContextMenu,
  onPagePointerDown,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: PageCellProps): React.JSX.Element {
  const displayWidth = displayWidthOf(page);
  const annotateMode = tool !== 'select';
  // Rubber band for the annotation tools, in display-normalized coords.
  // Driven by window-level native listeners for the drag's duration — the
  // same pattern as usePageDrag — rather than React synthetic move/up through
  // pointer capture, which proved unreliable in the WebView.
  const [band, setBand] = useState<AnnotationRect | null>(null);
  const bandActive = useRef(false);
  // Cancels the in-flight band (removes window listeners, commits nothing).
  const cancelBand = useRef<(() => void) | null>(null);
  // Freetext annotation currently being edited inline.
  const [editing, setEditing] = useState<string | null>(null);

  // Display px of the page's own point size — scales freetext to the cell.
  const freetextFontPx =
    (FREETEXT_FONT_PT / (page.rotation === 90 || page.rotation === 270 ? page.width : page.height)) *
      pageHeight || FREETEXT_FONT_PT;

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (!annotateMode) {
      onPagePointerDown(docId, page.id, e);
      return;
    }
    if (e.button !== 0 || bandActive.current || editing) return;
    e.preventDefault();
    e.stopPropagation();
    bandActive.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const norm = (cx: number, cy: number): { x: number; y: number } => ({
      x: Math.max(0, Math.min(1, (cx - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (cy - rect.top) / rect.height)),
    });
    const start = norm(e.clientX, e.clientY);
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
        const annotation: PageAnnotation = {
          id: crypto.randomUUID(),
          kind,
          ...latest,
          color: kind === 'freetext' ? FREETEXT_COLOR : HIGHLIGHT_COLOR,
        };
        onAddAnnotation(docId, page.id, annotation);
        if (kind === 'freetext') setEditing(annotation.id);
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
      className={'page' + (selected ? ' selected' : '') + (collapsed ? ' collapsing' : '')}
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
        onSelectPage(docId, page.id);
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
      {(page.annotations ?? []).map((a) => (
        <div
          key={a.id}
          className={'page-annot' + (a.kind === 'freetext' ? ' page-annot-text' : '')}
          title={a.kind === 'highlight' ? a.note : undefined}
          style={{
            left: `${a.x * 100}%`,
            top: `${a.y * 100}%`,
            width: `${a.w * 100}%`,
            height: `${a.h * 100}%`,
            ...(a.kind === 'highlight'
              ? { backgroundColor: `${a.color}66`, borderColor: a.color }
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
          {a.kind === 'freetext' && editing !== a.id && (
            <span className="page-annot-text-body">{a.note}</span>
          )}
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
              <button
                className="page-annot-x"
                title={a.kind === 'freetext' ? 'Remove text' : 'Remove highlight'}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveAnnotation(docId, page.id, a.id);
                }}
              >
                ×
              </button>
            )
          )}
        </div>
      ))}
      {band && (
        <div
          className="page-annot page-annot-band"
          style={{
            left: `${band.x * 100}%`,
            top: `${band.y * 100}%`,
            width: `${band.w * 100}%`,
            height: `${band.h * 100}%`,
          }}
        />
      )}
      <span className="page-number">{visibleNumber}</span>
    </div>
  );
}

export const PageCell = memo(PageCellImpl);
