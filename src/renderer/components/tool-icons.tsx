import React from 'react';
import type { Operation } from './Sidebar';

/**
 * Tool-rail glyphs — one per operation, in the app's established icon
 * idiom (see canvas/icons.tsx): 24-grid, stroke-only, `currentColor`,
 * round caps. Inheriting currentColor means every state the rail already
 * has (active/hover, light/dark theme, Windows accent) colors the glyph
 * with zero extra CSS. The Record type is total over Operation, so adding
 * a tool without a glyph fails to compile.
 */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// Path data per operation; single-glyph additions like dashes are carried
// per-path so the shared svg wrapper stays uniform.
const GLYPHS: Record<Operation, React.JSX.Element> = {
  // A page cut by a dashed line down the middle.
  split: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 4v16" strokeDasharray="2.5 3" />
    </>
  ),
  // Clockwise rotate arrow.
  rotate: (
    <>
      <path d="M21 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10" />
    </>
  ),
  // Trash can.
  delete: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  // Arrows pulling inward.
  compress: (
    <>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10 21 3" />
      <path d="M3 21l7-7" />
    </>
  ),
  // Circle, right half filled.
  grayscale: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  // Lightning bolt.
  optimize: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />,
  // Archive box.
  pdfa: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  // Stacked layers (versions).
  pdf_version: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  // Closed padlock.
  encrypt: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  // Open padlock.
  decrypt: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.9-.9" />
    </>
  ),
  // Page with text lines.
  extract_text: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8M16 17H8M10 9H8" />
    </>
  ),
  // Bookmark ribbon.
  outline: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  // Water droplet.
  watermark: <path d="M12 2.7s6.5 7.2 6.5 11a6.5 6.5 0 0 1-13 0c0-3.8 6.5-11 6.5-11z" />,
  // Checked box with lines beside it.
  forms: (
    <>
      <rect x="3" y="4" width="8" height="8" rx="1" />
      <path d="m5.5 8 1.5 1.5L9.5 6" />
      <path d="M14 7h7M14 12h7M3 17h18" />
    </>
  ),
  // Two facing half-frames around a dashed axis.
  compare: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M12 2v20" strokeDasharray="2.5 3" />
    </>
  ),
  // Fountain-pen nib stroke.
  signatures: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  // Info circle.
  metadata: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  // Wrench.
  repair: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  // Circular rebuild arrows.
  rebuild: (
    <>
      <path d="M21 3v5h-5" />
      <path d="M3 21v-5h5" />
      <path d="M21 8a9 9 0 0 0-15-5.3L3 5.5" />
      <path d="M3 16a9 9 0 0 0 15 5.3l3-2.8" />
    </>
  ),
  // Counter-clockwise restore arrow.
  recover: (
    <>
      <path d="M3 2v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </>
  ),
};

interface ToolIconProps {
  op: Operation;
  size?: number;
  className?: string;
}

export function ToolIcon({ op, size = 15, className }: ToolIconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} aria-hidden="true">
      {GLYPHS[op]}
    </svg>
  );
}
