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
import type { ImportedAnnotationFingerprint, PageAnnotation, TextMarkupType } from '../state/types';
import { pdfPointToDisplay, pdfRectToDisplay } from './pdfx-build';

type ImportedSubtype = ImportedAnnotationFingerprint['subtype'];

const RECOGNIZED_SUBTYPES = new Set([
  'Square', 'FreeText', 'Ink', 'Stamp',
  // N1 — native quad-based text markup, imported as `kind: 'textmarkup'`.
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly',
]);

// The four text-markup subtypes and the style each renders/round-trips as.
const MARKUP_TYPE: Record<string, TextMarkupType> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
};

const DEFAULT_COLOR: Record<string, string> = {
  Square: '#ffd54a',
  FreeText: '#16161a',
  Ink: '#2f6fed',
  Stamp: '#2fbf71',
  Highlight: '#ffe14a',
  Underline: '#2f6fed',
  StrikeOut: '#e0393e',
  Squiggly: '#2fbf71',
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
  quadPoints?: unknown; // markup only — pdf.js's parsed /QuadPoints
  hasAppearance?: boolean;
}

// pdf.js exposes /QuadPoints in one of a couple of shapes across versions: an
// array of quads where each quad is an array of {x,y} points, or a flat number
// array (8 per quad: 4 points). Normalize either into a list of PDF-space
// axis-aligned rects [x0,y0,x1,y1] (one per marked run) — a horizontal-text
// approximation, which is what the overlay draws.
function quadRects(quadPoints: unknown): [number, number, number, number][] {
  // pdf.js hands /QuadPoints back as a flat Float32Array (8 per quad); older/
  // other shapes are an array of quads or of {x,y} points. Normalize to a
  // plain array first (Array.isArray is false for a typed array).
  if (!quadPoints || (!Array.isArray(quadPoints) && !ArrayBuffer.isView(quadPoints))) return [];
  const flat = Array.from(quadPoints as ArrayLike<unknown>);
  if (flat.length === 0) return [];
  const out: [number, number, number, number][] = [];
  const first = flat[0] as unknown;
  if (Array.isArray(first)) {
    // Array of quads, each an array of {x,y} (or [x,y]) points.
    for (const quad of flat as unknown[]) {
      if (!Array.isArray(quad)) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const pt of quad as unknown[]) {
        if (pt && typeof pt === 'object' && 'x' in pt && 'y' in pt) {
          xs.push(Number((pt as { x: number }).x));
          ys.push(Number((pt as { y: number }).y));
        }
      }
      if (xs.length >= 2) out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    return out;
  }
  if (first !== null && typeof first === 'object' && 'x' in first) {
    // Flat array of {x,y} points, 4 per quad.
    const pts = flat as { x: number; y: number }[];
    for (let i = 0; i + 3 < pts.length; i += 4) {
      const xs = [pts[i].x, pts[i + 1].x, pts[i + 2].x, pts[i + 3].x].map(Number);
      const ys = [pts[i].y, pts[i + 1].y, pts[i + 2].y, pts[i + 3].y].map(Number);
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    return out;
  }
  // Flat number array (incl. a Float32Array converted above), 8 per quad.
  const nums = flat.map((v) => Number(v));
  for (let i = 0; i + 7 < nums.length; i += 8) {
    const xs = [nums[i], nums[i + 2], nums[i + 4], nums[i + 6]];
    const ys = [nums[i + 1], nums[i + 3], nums[i + 5], nums[i + 7]];
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
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
      subtype: a.subtype as ImportedSubtype,
      rect: a.rect,
      contents,
      color,
      // Default to false (not true) when uncertain — PageCell only suppresses
      // its own visible body when this is true, and an invisible annotation
      // is a worse failure than a redundant duplicate rendering.
      hasAppearance: a.hasAppearance === true,
    };

    const markupType = MARKUP_TYPE[a.subtype];
    if (markupType) {
      // N1 native text markup: each /QuadPoints quad becomes a normalized rect
      // (same 0..1 space as ink's `points`); x/y/w/h is their bounding box.
      const rects = quadRects(a.quadPoints);
      const quads: number[] = [];
      for (const r of rects) {
        const d = pdfRectToDisplay(r, box, rotation);
        quads.push(d.x, d.y, d.x + d.w, d.y + d.h);
      }
      // No parseable quads → fall back to the annotation's /Rect as one quad,
      // so a markup with a missing/odd QuadPoints still imports (dropped only
      // if even that /Rect is degenerate — the same guard every kind applies).
      if (quads.length === 0) {
        const d = pdfRectToDisplay(a.rect, box, rotation);
        quads.push(d.x, d.y, d.x + d.w, d.y + d.h);
      }
      const xs = quads.filter((_, i) => i % 2 === 0);
      const ys = quads.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      if (Math.max(...xs) - x <= 0 || Math.max(...ys) - y <= 0) continue;
      imported.push({
        id: crypto.randomUUID(),
        kind: 'textmarkup',
        markupType,
        quads,
        x,
        y,
        w: Math.max(...xs) - x,
        h: Math.max(...ys) - y,
        color,
        note: contents,
        importedOriginal,
      });
      continue;
    }

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
