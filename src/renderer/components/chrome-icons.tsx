import React from 'react';

/**
 * Workbench-chrome glyphs (Phase 4 M2) — toolbar, tab strip, Home tab — in
 * the app's established icon idiom (see tool-icons.tsx / canvas/icons.tsx):
 * 24-grid, stroke-only, `currentColor`, round caps. No Adobe artwork (§ 1);
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
  | 'document';

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
  // Magnifier with plus.
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M11 8v6M8 11h6" />
    </>
  ),
  // Magnifier with minus.
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
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
