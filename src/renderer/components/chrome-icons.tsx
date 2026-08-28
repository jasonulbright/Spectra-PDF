import React from 'react';

/**
 * Workbench-chrome glyphs — toolbar, tab strip, Home tab — in
 * the app's established icon idiom (see tool-icons.tsx / canvas/icons.tsx):
 * 24-grid, stroke-only, `currentColor`, round caps. No third-party artwork;
 * hand-authored. The Record is total over ChromeIconId, so a missing glyph
 * fails to compile (the GLYPHS precedent).
 */

export type ChromeIconId =
  | 'open'
  | 'save'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'find'
  | 'home'
  | 'tools'
  | 'close'
  | 'overflow'
  | 'document'
  | 'pages'
  | 'bookmarks'
  | 'articles'
  | 'signatures'
  | 'attachments'
  | 'layers'
  | 'tags'
  | 'hand'
  | 'cursor'
  // Read Out Loud's transport. They are icons rather than the transport
  // CHARACTERS (⏮ ⏭ ⏸ ⏹) because those characters have an emoji presentation:
  // the platform resolved two of the four to its colour-emoji face, which
  // rendered them as white glyphs on a blue rounded plate — a permanently
  // selected-looking state on two of four peer controls, in a bar whose other
  // two were monochrome.
  | 'play'
  | 'pause'
  | 'previous'
  | 'next'
  | 'stop';

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const GLYPHS: Record<ChromeIconId, React.JSX.Element> = {
  // Open folder.
  open: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 10h18l-2 8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
    </>
  ),
  // Floppy disk.
  save: (
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 4v5h7V4" />
      <rect x="8" y="14" width="8" height="5" />
    </>
  ),
  // Curved arrow, tail left (undo).
  undo: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h10a6 6 0 0 1 6 6v1" />
    </>
  ),
  // Curved arrow, tail right (redo).
  redo: (
    <>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12H10a6 6 0 0 0-6 6v1" />
    </>
  ),
  // Plus in a frame — NOT a magnifier. The main toolbar carried three
  // magnifier-shaped things within 40px of each other: zoom in, zoom out, and
  // Find. A magnifier means "search here" everywhere else in the product, so
  // the two that do not search give it up; `find` keeps it. The frame is the
  // viewport being scaled, which is what zoom actually does to it.
  zoomIn: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  // Open palm — the hold-the-paper grip.
  hand: (
    <>
      <path d="M8 12V6.5a1.5 1.5 0 013 0V11" />
      <path d="M11 11V5a1.5 1.5 0 013 0v6" />
      <path d="M14 11V6.5a1.5 1.5 0 013 0V13" />
      <path d="M8 12l-1.8-1.8a1.4 1.4 0 00-2 2L9 17.5A6 6 0 0014 20h1a5 5 0 005-5v-2" />
    </>
  ),
  // Pointer arrow — Select.
  cursor: (
    <>
      <path d="M5 3l7 16 2.2-6.2L20 10.5 5 3z" />
    </>
  ),
  // Minus in the same frame, for `zoomIn`'s reason.
  zoomOut: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8 12h8" />
    </>
  ),
  // Expand-to-frame corners.
  fit: (
    <>
      <path d="M4 9V5a1 1 0 0 1 1-1h4" />
      <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h4" />
      <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    </>
  ),
  // Plain magnifier (find).
  find: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  // House.
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
    </>
  ),
  // Wrench.
  tools: (
    <path d="M14.5 4a4.5 4.5 0 0 0-5.9 5.7L4 14.3a2 2 0 1 0 2.8 2.8l4.6-4.6A4.5 4.5 0 0 0 18 7l-2.6 2.6-2-2L16 5a4.5 4.5 0 0 0-1.5-1z" />
  ),
  // X.
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // Chevron down (overflow).
  overflow: <path d="M6 9l6 6 6-6" />,
  // Document page.
  document: (
    <>
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v4h4" />
    </>
  ),
  // Two stacked page thumbnails (nav-pane Pages panel).
  pages: (
    <>
      <rect x="4" y="3" width="10" height="13" rx="1" />
      <path d="M8 20h11a1 1 0 0 0 1-1V7" />
    </>
  ),
  // Ribbon bookmark.
  bookmarks: <path d="M6 3h12v18l-6-4-6 4z" />,
  // A pen writing a signature onto a baseline (nav-pane Signatures panel).
  // The bare squiggle-over-a-rule read as a line chart on a plot axis — the
  // pen is what makes the same stroke a signature. It also matches the tools
  // list's Signatures glyph, which was already a pen.
  signatures: (
    <>
      <path d="M3 16c2-0.5 3-3.5 4.5-3.5S9 15 10.5 15s2-3 3.5-4" />
      <path d="M3 20h18" />
      <path d="M16.5 4.8a1.8 1.8 0 0 1 2.6 2.6L14.8 11.8l-3.3 0.7 0.7-3.3z" />
    </>
  ),
  // Paperclip (nav-pane Attachments panel).
  attachments: (
    <path d="M20 12.5l-7.8 7.8a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.4a1.8 1.8 0 0 1-2.5-2.5l7.8-7.7" />
  ),
  // Stacked planes (nav-pane Layers panel).
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </>
  ),
  // Price-tag with its hole (nav-pane Tags panel).
  tags: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  // Two columns of text with a flow arrow between them (nav-pane Articles
  // panel): an article is boxes read in an order the page layout does not give.
  articles: (
    <>
      <path d="M3 4h7v6H3z" />
      <path d="M14 14h7v6h-7z" />
      <path d="M3 13h7M3 16h5" />
      <path d="M14 4h7M14 7h5" />
      <path d="M10.5 10.5l3 3" />
    </>
  ),
  // Transport, all five on one baseline so the row reads as one control group:
  // the triangles share an apex inset and the bars share x-height.
  play: <path d="M8.5 5.5L18 12l-9.5 6.5z" />,
  pause: <path d="M9.5 5.5v13M14.5 5.5v13" />,
  previous: (
    <>
      <path d="M7 5.5v13" />
      <path d="M19 5.5L10 12l9 6.5z" />
    </>
  ),
  next: (
    <>
      <path d="M5 5.5L14 12l-9 6.5z" />
      <path d="M17 5.5v13" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
};

interface ChromeIconProps {
  icon: ChromeIconId;
  size?: number;
  className?: string;
}

export function ChromeIcon({ icon, size = 16, className }: ChromeIconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} aria-hidden="true">
      {GLYPHS[icon]}
    </svg>
  );
}
