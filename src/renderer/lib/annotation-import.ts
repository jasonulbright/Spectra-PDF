// Imports pre-existing PDF annotations into Open PDF Studio's editable PageAnnotation
// model at index time. Only the subtypes we can also author ourselves are
// recognized — Square (our highlight tool), FreeText, Ink, Stamp. Everything
// else (Link, Popup, Widget, native Highlight/Underline/StrikeOut quad-point
// markup, Text sticky notes, …) is left alone entirely: not imported, not
// editable, and — critically — never touched by the commit-time strip in
// pdfx-build.ts's stripImportedOriginals, which only ever removes an original
// it can positively fingerprint-match against something in this list. See
// docs/architecture/05-phase2c-annotations.md, "importing existing
// annotations safely".
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PageAnnotation } from '../state/types';
import { pdfPointToDisplay, pdfRectToDisplay } from './pdfx-build';

const RECOGNIZED_SUBTYPES = new Set(['Square', 'FreeText', 'Ink', 'Stamp']);

const DEFAULT_COLOR: Record<string, string> = {
  Square: '#ffd54a',
  FreeText: '#16161a',
  Ink: '#2f6fed',
  Stamp: '#2fbf71',
};

function colorToHex(color: unknown): string | null {
  if (!Array.isArray(color) || color.length !== 3) return null;
  const [r, g, b] = color as number[];
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function kindFor(subtype: string): PageAnnotation['kind'] {
  if (subtype === 'FreeText') return 'freetext';
  if (subtype === 'Ink') return 'ink';
  if (subtype === 'Stamp') return 'stamp';
  return 'highlight';
}

interface RawAnnotation {
  subtype: string;
  rect: [number, number, number, number];
  color?: unknown;
  contentsObj?: { str: string };
  inkLists?: ArrayLike<number>[];
  hasAppearance?: boolean;
}

// `page.view` is [x0,y0,x1,y1] — pdf.js's crop-intersected effective box.
// The commit builder (pdfx-build.ts) maps display coordinates against
// `copied.getCropBox()`, NOT getMediaBox() — CropBox defaults to MediaBox
// when absent (byte-identical for the common case), but for a page WITH a
// distinct CropBox the two disagree, and using different boxes on the import
// vs. commit side made an edited-then-recommitted imported annotation drift
// by the crop offset. Both sides must agree on the same box. `page.rotate`
// is the page's own inherent /Rotate — the "final rotation" at fresh-import
// time, since a freshly indexed PageRef.rotation is always 0 (no pending
// edit yet).
export async function importPageAnnotations(page: PDFPageProxy): Promise<PageAnnotation[]> {
  const raw = (await page.getAnnotations()) as unknown as RawAnnotation[];
  const [vx0, vy0, vx1, vy1] = page.view;
  const box = { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 };
  const rotation = page.rotate;

  const imported: PageAnnotation[] = [];
  for (const a of raw) {
    if (!RECOGNIZED_SUBTYPES.has(a.subtype)) continue;
    const kind = kindFor(a.subtype);
    const contents = a.contentsObj?.str || undefined;
    const color = colorToHex(a.color) ?? DEFAULT_COLOR[a.subtype];
    const importedOriginal = {
      subtype: a.subtype as 'Square' | 'FreeText' | 'Ink' | 'Stamp',
      rect: a.rect,
      contents,
      color,
      // Default to false (not true) when uncertain — PageCell only suppresses
      // its own visible body when this is true, and an invisible annotation
      // is a worse failure than a redundant duplicate rendering.
      hasAppearance: a.hasAppearance === true,
    };

    if (kind === 'ink') {
      // PageAnnotation.points holds exactly one stroke — a multi-stroke Ink
      // (InkList with more than one sub-path, e.g. a signature made of
      // several pen lifts) can't be represented without lossily dropping
      // strokes after the first. Rather than import-then-silently-destroy
      // extra strokes the moment the annotation is edited, don't import it
      // at all: it's left exactly as-is, same as any other unrecognized
      // annotation (never touched, never stripped, never editable here).
      if ((a.inkLists?.length ?? 0) > 1) continue;
      const path = a.inkLists?.[0];
      if (!path || path.length < 2) continue; // no usable stroke — skip rather than import a degenerate one
      const points: number[] = [];
      for (let i = 0; i < path.length; i += 2) {
        const [u, v] = pdfPointToDisplay(path[i], path[i + 1], box, rotation);
        points.push(u, v);
      }
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      imported.push({
        id: crypto.randomUUID(),
        kind,
        x,
        y,
        w: Math.max(...xs) - x,
        h: Math.max(...ys) - y,
        color,
        note: contents,
        points,
        importedOriginal,
      });
      continue;
    }

    const { x, y, w, h } = pdfRectToDisplay(a.rect, box, rotation);
    if (w <= 0 || h <= 0) continue; // degenerate box — nothing sensible to render/edit
    imported.push({ id: crypto.randomUUID(), kind, x, y, w, h, color, note: contents, importedOriginal });
  }
  return imported;
}
