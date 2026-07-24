import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildTextMarkupAnnotations,
  selectionQuadsByPage,
  type PageBox,
  type PageQuads,
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
  /** Author link regions over the selection. Engine-tier (links are not
   *  annotations here), so the canvas owns the geometry + call. */
  onCreateLinks?: (selection: PageQuads[], url: string) => Promise<void>;
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
  onCreateLinks,
}: TextSelectionMenuProps): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // The link editor replaces the buttons in place; `pending` holds the quads
  // captured when it opened, because typing a URL destroys the selection they
  // came from (focus moves to the input).
  const [pending, setPending] = useState<PageQuads[] | null>(null);
  const [url, setUrl] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Read inside window-level listeners, which close over the first render.
  const pendingRef = useRef<PageQuads[] | null>(null);
  pendingRef.current = pending;

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

  const pageBoxes = useCallback((): PageBox[] => {
    const scroller = scrollerRef.current;
    if (!scroller) return [];
    const out: PageBox[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-page-id]')) {
      const pageId = el.dataset.pageId;
      if (!pageId) continue;
      const r = el.getBoundingClientRect();
      out.push({
        docId,
        pageId,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      });
    }
    return out;
  }, [docId, scrollerRef]);

  const closeAll = useCallback((): void => {
    setPending(null);
    setUrl('');
    setLinkError(null);
    setAnchor(null);
  }, []);

  useEffect(() => {
    if (!active) {
      closeAll();
      return;
    }
    const update = (): void => {
      // While the link editor is open the selection is gone (focus is in the
      // input) — its quads are already captured, so leave the bar alone.
      if (pendingRef.current) return;
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
      if (!pendingRef.current && currentRects().length === 0) setAnchor(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', update);
    document.addEventListener('keyup', update);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', update);
      document.removeEventListener('keyup', update);
    };
  }, [active, currentRects, closeAll]);

  // Scrolling or zooming moves the pages out from under a viewport-anchored
  // bar; drop it rather than leave it pointing at nothing.
  useEffect(() => {
    if (!anchor) return;
    const scroller = scrollerRef.current;
    const drop = (): void => closeAll();
    scroller?.addEventListener('scroll', drop, { passive: true });
    window.addEventListener('resize', drop);
    return () => {
      scroller?.removeEventListener('scroll', drop);
      window.removeEventListener('resize', drop);
    };
  }, [anchor, scrollerRef, closeAll]);

  const apply = (markupType: TextMarkupType): void => {
    const built = buildTextMarkupAnnotations({
      rects: currentRects(),
      pages: pageBoxes(),
      markupType,
      color: annotationColor ?? MARKUP_DEFAULT_COLOR,
      viewRotation,
    });
    for (const b of built) onAddAnnotation(b.docId, b.pageId, b.annotation);
    // The markup now stands in for the selection; leaving it up would let a
    // second click double-apply to text that already looks marked.
    window.getSelection()?.removeAllRanges();
    closeAll();
  };

  // Capture the selection's quads NOW: focusing the URL input destroys it.
  const startLink = (): void => {
    const quads = selectionQuadsByPage(currentRects(), pageBoxes(), viewRotation);
    if (quads.length === 0) return;
    setPending(quads);
    setLinkError(null);
    window.getSelection()?.removeAllRanges();
  };

  const submitLink = async (): Promise<void> => {
    const target = url.trim();
    if (!pending || !onCreateLinks || busyRef.current) return;
    if (!target) {
      setLinkError('Enter a URL.');
      return;
    }
    // Reentrancy taken before the first await — the double-click class the
    // punchlist's tripwire note records.
    busyRef.current = true;
    try {
      await onCreateLinks(pending, target);
      closeAll();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
    }
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
      {pending ? (
        <>
          <input
            autoFocus
            data-testid="markup-link-url"
            className="text-selection-url"
            type="text"
            placeholder="https://…"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitLink();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation(); // Escape here cancels the editor, not the view
                closeAll();
              }
            }}
          />
          <button type="button" data-testid="markup-link-apply" onClick={() => void submitLink()}>
            Link
          </button>
          {linkError && (
            <span className="text-selection-error" data-testid="markup-link-error" role="alert">
              {linkError}
            </span>
          )}
        </>
      ) : (
        <>
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
          {onCreateLinks && (
            <button
              type="button"
              data-testid="markup-link"
              title="Link to a URL"
              aria-label="Link to a URL"
              onClick={startLink}
            >
              <span aria-hidden="true">🔗</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
