import { useCallback, useEffect, useState } from 'react';
import {
  buildTextMarkupAnnotations,
  type PageBox,
  type RectLike,
} from '../../lib/text-selection-markup';
import type { PageAnnotation, TextMarkupType } from '../../state/types';

// Authoring markup by gesture (the N-cluster's CREATE half): select text on
// the page with the Select tool and a small bar offers Highlight / Underline /
// Strikeout / Squiggly. The selection comes from pdf.js's TextLayer, so this
// is the real browser selection — drag, double-click-word, triple-click-line,
// and Shift+arrow all produce it, and none of them are ours to implement.
//
// Mounted by the reading view only, because that is the only view with a text
// layer (the board is a thumbnail arrangement surface — see PageTextLayer).

const STYLES: { type: TextMarkupType; label: string; glyph: string }[] = [
  { type: 'highlight', label: 'Highlight', glyph: '▬' },
  { type: 'underline', label: 'Underline', glyph: 'U' },
  { type: 'strikeout', label: 'Strikeout', glyph: 'S' },
  { type: 'squiggly', label: 'Squiggly', glyph: '∿' },
];

/** Default markup colour when no annotation colour is chosen (yellow, the
 *  universal highlighter). */
export const MARKUP_DEFAULT_COLOR = '#ffe14d';

export interface TextSelectionMenuProps {
  /** The scroller the pages live in — page cells are found beneath it, and the
   *  menu is positioned against its box. */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  docId: string;
  /** Only 'select' selects text (PageTextLayer is inert otherwise). */
  active: boolean;
  viewRotation?: 0 | 90 | 180 | 270;
  annotationColor?: string;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
}

interface Anchor {
  /** Viewport coordinates of the selection's end, where the bar is placed. */
  left: number;
  top: number;
}

export function TextSelectionMenu({
  scrollerRef,
  docId,
  active,
  viewRotation,
  annotationColor,
  onAddAnnotation,
}: TextSelectionMenuProps): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Read the live selection rather than caching it: the browser owns it, and a
  // cached Range goes stale on any scroll, zoom or text-layer rebuild.
  const currentRects = useCallback((): RectLike[] => {
    const sel = window.getSelection();
    const scroller = scrollerRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !scroller) return [];
    const out: RectLike[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      // Ignore selections that aren't in this document's pages (the sidebar,
      // a panel, another pane) — they must not author annotations.
      if (!scroller.contains(range.commonAncestorContainer)) continue;
      for (const r of range.getClientRects()) {
        out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
    }
    return out;
  }, [scrollerRef]);

  useEffect(() => {
    if (!active) {
      setAnchor(null);
      return;
    }
    const update = (): void => {
      const rects = currentRects();
      if (rects.length === 0) {
        setAnchor(null);
        return;
      }
      const last = rects[rects.length - 1];
      setAnchor({ left: (last.left + last.right) / 2, top: last.bottom });
    };
    // `selectionchange` fires continuously during a drag; the bar appearing
    // mid-drag under the cursor would fight the gesture, so it is placed on
    // release (pointerup) and on keyboard selection (keyup), and cleared
    // immediately whenever the selection empties.
    const onSelectionChange = (): void => {
      if (currentRects().length === 0) setAnchor(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', update);
    document.addEventListener('keyup', update);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', update);
      document.removeEventListener('keyup', update);
    };
  }, [active, currentRects]);

  // Scrolling or zooming moves the pages out from under a viewport-anchored
  // bar; drop it rather than leave it pointing at nothing.
  useEffect(() => {
    if (!anchor) return;
    const scroller = scrollerRef.current;
    const drop = (): void => setAnchor(null);
    scroller?.addEventListener('scroll', drop, { passive: true });
    window.addEventListener('resize', drop);
    return () => {
      scroller?.removeEventListener('scroll', drop);
      window.removeEventListener('resize', drop);
    };
  }, [anchor, scrollerRef]);

  const apply = (markupType: TextMarkupType): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rects = currentRects();
    const pages: PageBox[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-page-id]')) {
      const pageId = el.dataset.pageId;
      if (!pageId) continue;
      const r = el.getBoundingClientRect();
      pages.push({
        docId,
        pageId,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      });
    }
    const built = buildTextMarkupAnnotations({
      rects,
      pages,
      markupType,
      color: annotationColor ?? MARKUP_DEFAULT_COLOR,
      viewRotation,
    });
    for (const b of built) onAddAnnotation(b.docId, b.pageId, b.annotation);
    // The markup now stands in for the selection; leaving it up would let a
    // second click double-apply to text that already looks marked.
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  if (!anchor) return null;
  return (
    <div
      className="text-selection-menu"
      data-testid="text-selection-menu"
      role="toolbar"
      aria-label="Mark selected text"
      style={{ left: anchor.left, top: anchor.top }}
      // A press inside the bar must not clear the selection it acts on.
      onPointerDown={(e) => e.preventDefault()}
    >
      {STYLES.map((s) => (
        <button
          key={s.type}
          type="button"
          data-testid={`markup-${s.type}`}
          title={s.label}
          aria-label={s.label}
          onClick={() => apply(s.type)}
        >
          <span aria-hidden="true">{s.glyph}</span>
        </button>
      ))}
    </div>
  );
}
