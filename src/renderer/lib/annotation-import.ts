// Imports pre-existing PDF annotations into Spectra PDF's editable PageAnnotation
// model at index time. Only the subtypes we can also author ourselves are
// recognized — everything else (Link, Popup, Widget, …) is left alone
// entirely: not imported, not editable, and — critically — never touched by
// the commit-time strip in pdfx-build.ts's stripImportedOriginals, which only
// ever removes an original it can positively fingerprint-match against
// something in this list.
//
// Rung 2 widens the list to the drawing shapes (/Circle /Line /Polygon
// /PolyLine) and callouts (/FreeText + /IT /FreeTextCallout) — but ONLY when
// the raw-style sidecar (annotation-raw-style.ts) supplies the entries
// pdf.js hides (/IC /CA /BE /CL /RD /LE), because importing one blind and
// re-committing it would silently strip those. Faithful-or-untouched: no
// sidecar entry, or a line-ending outside the set we author, and the
// annotation stays raster-only exactly like before rung 2. Dimension lines
// (/Measure or /IT LineDimension) always stay untouched — the measure
// class's own no-degradation rule.
import type { PDFPageProxy } from 'pdfjs-dist';
import type { ImportedAnnotationFingerprint, PageAnnotation, TextMarkupType } from '../state/types';
import { pdfPointToDisplay, pdfRectToDisplay } from './pdfx-build';
import { takeRawStyle, type RawAnnotStyle } from './annotation-raw-style';
import {
  DEFAULT_COUNT_SYMBOL,
  UNGROUPED,
  partsFromJson,
  symbolById,
  type CountLegendRow,
} from './count-marks';

type ImportedSubtype = ImportedAnnotationFingerprint['subtype'];

const RECOGNIZED_SUBTYPES = new Set([
  'Square', 'FreeText', 'Ink', 'Stamp',
  // Native quad-based text markup, imported as `kind: 'textmarkup'`.
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly',
  // Native /Text sticky note, imported as `kind: 'note'`.
  'Text',
  // Rung 2 — drawing shapes (sidecar-gated; see the header).
  'Circle', 'Line', 'Polygon', 'PolyLine',
]);

// The line endings our arrow/line emit can reproduce byte-faithfully. An
// import carrying any other ending is left untouched rather than degraded.
const AUTHORABLE_ENDINGS = new Set(['None', 'OpenArrow', 'ClosedArrow']);

/**
 * Floor for an imported ink's nib. `/BS /W 0` means NO BORDER for the shapes
 * that have one to omit; an /Ink is nothing but its border, so re-emitting a
 * carried 0 as `0 w` would draw a device hairline whose thickness is the
 * output device's, not the document's. An imported ink therefore never
 * re-commits thinner than this.
 */
const INK_MIN_STROKE_WIDTH = 0.5;

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
  Text: '#ffd54a',
  Circle: '#e0393e',
  Line: '#e0393e',
  Polygon: '#e0393e',
  PolyLine: '#e0393e',
};

// pdf.js hands `/C` back as a **Uint8ClampedArray**, not an Array, and
// `Array.isArray` is false for one — so this returned null for EVERY annotation
// and every imported colour was silently replaced by its subtype's default.
// Measured on a shipped screenshot: a highlight authored `#f7c948` and an ink
// stroke authored `#e8503a` came back as `#ffe14a` and `#2f6fed`, the defaults,
// while the page kept drawing the authored colours from their appearance
// streams — so the comment list and the page disagreed about every mark.
// The test is length + numeric members, which is what the function actually
// needs; `Array.isArray` was asking a question about the container.
function colorToHex(color: unknown): string | null {
  if (color === null || typeof color !== 'object') return null;
  const arr = color as ArrayLike<unknown>;
  if (arr.length !== 3) return null;
  const [r, g, b] = [arr[0], arr[1], arr[2]];
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function kindFor(subtype: string): PageAnnotation['kind'] {
  if (subtype === 'FreeText') return 'freetext';
  if (subtype === 'Ink') return 'ink';
  if (subtype === 'Stamp') return 'stamp';
  if (subtype === 'Text') return 'note';
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
  // Rung 2 — pdf.js's parses where they exist; the sidecar supplies the rest.
  it?: string;
  vertices?: ArrayLike<number>;
  lineCoordinates?: ArrayLike<number>;
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
export async function importPageAnnotations(
  page: PDFPageProxy,
  rawStyles?: RawAnnotStyle[],
): Promise<PageAnnotation[]> {
  const raw = (await page.getAnnotations()) as unknown as RawAnnotation[];
  const [vx0, vy0, vx1, vy1] = page.view;
  const box = { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 };
  const rotation = page.rotate;
  const consumedStyles = new Set<number>();

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
    const sidecar = takeRawStyle(rawStyles, consumedStyles, a.subtype, a.rect);

    // ── Rung 2: drawing shapes + callouts (sidecar-gated) ────────────
    if (a.subtype === 'Circle' || a.subtype === 'Line' || a.subtype === 'Polygon' || a.subtype === 'PolyLine') {
      const shape = importShape(a, sidecar, box, rotation, color, contents, importedOriginal);
      if (shape) imported.push(shape);
      continue;
    }
    if (a.subtype === 'FreeText' && (sidecar?.it === 'FreeTextCallout' || (a as { it?: string }).it === 'FreeTextCallout')) {
      const callout = importCallout(a, sidecar, box, rotation, color, contents, importedOriginal);
      if (callout) imported.push(callout);
      continue;
    }

    // ── takeoff count marks + placed legends ─────────────────────────
    // Both are sidecar-gated exactly like the callout above: /IT, /Subj and
    // the private keys only exist raw. Groups therefore reconstitute from the
    // FILE rather than from app state — a drawing counted on another machine
    // opens with its tallies intact.
    if (a.subtype === 'Stamp' && sidecar?.it === 'Count') {
      const mark = importCountMark(a, sidecar, box, rotation, color, contents, importedOriginal);
      if (mark) imported.push(mark);
      continue;
    }
    // A placed vector SYMBOL — a /Stamp with no /IT that carries
    // its own geometry. Without this branch a moved symbol would re-commit as
    // a TEXT stamp (the generic stamp import's shape), turning the drawing
    // into its own label.
    if (a.subtype === 'Stamp' && sidecar?.it === undefined && sidecar?.spectraSymbolParts) {
      const symbol = importSymbolStamp(a, sidecar, box, rotation, color, contents, importedOriginal);
      if (symbol) {
        imported.push(symbol);
        continue;
      }
      // Unreadable geometry falls through to the ordinary stamp import: the
      // annotation is still a stamp, and its original appearance is what shows
      // until it is edited.
    }
    if (a.subtype === 'FreeText' && (sidecar?.it === 'CountLegend' || (a as { it?: string }).it === 'CountLegend')) {
      const legend = importCountLegend(a, sidecar, box, rotation, color, contents, importedOriginal);
      if (legend) imported.push(legend);
      // Faithful-or-untouched: a legend whose snapshot rows can't be read
      // stays a raster-only original rather than importing as a plain text
      // box, which would re-commit WITHOUT its table.
      continue;
    }

    const markupType = MARKUP_TYPE[a.subtype];
    if (markupType) {
      // Native text markup: each /QuadPoints quad becomes a normalized rect
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
      // Every /InkList sub-path imports as one stroke — a signature
      // made of several pen lifts arrives WHOLE. (This gate used to refuse
      // multi-stroke inks outright because the model held a single stroke;
      // `strokes` is the model now, so the no-degradation rule is
      // satisfied by fidelity instead of refusal.)
      const strokes: number[][] = [];
      for (const path of a.inkLists ?? []) {
        if (!path || path.length < 2) continue;
        const stroke: number[] = [];
        for (let i = 0; i < path.length; i += 2) {
          const [u, v] = pdfPointToDisplay(path[i], path[i + 1], box, rotation);
          stroke.push(u, v);
        }
        strokes.push(stroke);
      }
      if (strokes.length === 0) continue; // nothing usable — skip rather than import a degenerate one
      const xs = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 0));
      const ys = strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1));
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
        strokes,
        // The pen, its nib and its alpha. `/SpectraInkStyle` is what says the
        // drawing was made with the freehand HIGHLIGHTER: a re-commit must
        // rebuild the translucent /Multiply appearance rather than silently
        // re-emitting it as an opaque pen stroke. Width and alpha come from
        // the file's own /BS /W and /CA — the mark keeps the weight it was
        // saved with, whatever this build's default nib happens to be.
        ...(sidecar?.spectraInkStyle === 'highlighter'
          ? { inkStyle: 'highlighter' as const }
          : {}),
        ...(sidecar?.strokeWidth !== undefined
          ? { strokeWidth: Math.max(INK_MIN_STROKE_WIDTH, sidecar.strokeWidth) }
          : {}),
        ...(sidecar?.opacity !== undefined ? { opacity: sidecar.opacity } : {}),
        importedOriginal,
      });
      continue;
    }

    // A /Square WITH an explicit border style is a drawn RECTANGLE, not a
    // highlight box: our own rect emit always writes /BS while our highlight
    // emit never does — that asymmetry IS the discriminator, and it routes
    // BS-carrying foreign Squares to the higher-fidelity import too (their
    // stroke width/fill survive instead of degrading to the highlight look).
    // Cloudy Squares stay untouched (a /BE rectangle isn't authorable here).
    if (a.subtype === 'Square' && sidecar?.cloudy) continue;
    if (a.subtype === 'Square' && sidecar?.strokeWidth !== undefined) {
      const d = pdfRectToDisplay(a.rect, box, rotation);
      if (d.w <= 0 || d.h <= 0) continue;
      imported.push({
        id: crypto.randomUUID(),
        kind: 'shape',
        shapeType: 'rect',
        ...d,
        color,
        note: contents,
        strokeWidth: sidecar.strokeWidth,
        ...(sidecar.fillColor ? { fillColor: sidecar.fillColor } : {}),
        ...(sidecar.opacity !== undefined && sidecar.opacity < 1 ? { opacity: sidecar.opacity } : {}),
        importedOriginal,
      });
      continue;
    }

    const { x, y, w, h } = pdfRectToDisplay(a.rect, box, rotation);
    if (kind === 'note') {
      // A /Text sticky note is a fixed-size icon at a point; some tools give it
      // a zero-size /Rect. Synthesize a small icon box (~18pt) so it's always
      // visible/editable, anchored at the rect's top-left in display space.
      const iw = w > 0 ? w : 18 / box.width;
      const ih = h > 0 ? h : 18 / box.height;
      imported.push({ id: crypto.randomUUID(), kind, x, y, w: iw, h: ih, color, note: contents, importedOriginal });
      continue;
    }
    if (w <= 0 || h <= 0) continue; // degenerate box — nothing sensible to render/edit
    imported.push({ id: crypto.randomUUID(), kind, x, y, w, h, color, note: contents, importedOriginal });
  }
  return imported;
}

type ViewBox = { x: number; y: number; width: number; height: number };

/** Shared style block for a sidecar-backed shape import. The PDF default
 * border width is 1 when /BS is absent — stored explicitly so the re-emit
 * writes what the donor rendered as. */
function sidecarStyle(s: RawAnnotStyle): Pick<PageAnnotation, 'strokeWidth' | 'fillColor' | 'opacity'> {
  return {
    strokeWidth: s.strokeWidth ?? 1,
    ...(s.fillColor ? { fillColor: s.fillColor } : {}),
    ...(s.opacity !== undefined && s.opacity < 1 ? { opacity: s.opacity } : {}),
  };
}

function bboxOf(points: number[]): { x: number; y: number; w: number; h: number } | null {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  if (xs.length === 0) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** /Circle /Line /Polygon /PolyLine → kind 'shape', sidecar-gated (the
 * header's faithful-or-untouched rules). Returns null to leave the original
 * exactly as it is. */
function importShape(
  a: RawAnnotation,
  sidecar: RawAnnotStyle | undefined,
  box: ViewBox,
  rotation: number,
  color: string,
  contents: string | undefined,
  importedOriginal: ImportedAnnotationFingerprint,
): PageAnnotation | null {
  if (!sidecar) return null;
  // Dimensions belong to the measure class — never imported (their /Measure
  // dict would be stripped by an edit-commit cycle).
  if (sidecar.measure || sidecar.it === 'LineDimension' || sidecar.it === 'PolyLineDimension' || sidecar.it === 'PolygonDimension')
    return null;
  const base = {
    id: crypto.randomUUID(),
    kind: 'shape' as const,
    color,
    note: contents,
    ...sidecarStyle(sidecar),
    importedOriginal,
  };
  if (a.subtype === 'Circle') {
    if (sidecar.cloudy) return null; // cloudy ellipse — not authorable
    const d = pdfRectToDisplay(a.rect, box, rotation);
    if (d.w <= 0 || d.h <= 0) return null;
    return { ...base, shapeType: 'ellipse', ...d };
  }
  if (a.subtype === 'Line') {
    const l = sidecar.l ?? (a.lineCoordinates ? Array.from(a.lineCoordinates) : undefined);
    if (!l || l.length < 4) return null;
    const endings = (sidecar.le ?? ['None', 'None']).slice(0, 2);
    while (endings.length < 2) endings.push('None');
    if (!endings.every((e) => AUTHORABLE_ENDINGS.has(e))) return null;
    const p0 = pdfPointToDisplay(l[0], l[1], box, rotation);
    const p1 = pdfPointToDisplay(l[2], l[3], box, rotation);
    const points = [p0[0], p0[1], p1[0], p1[1]];
    const bb = bboxOf(points)!;
    const hasArrow = endings.some((e) => e !== 'None');
    return {
      ...base,
      shapeType: hasArrow ? 'arrow' : 'line',
      ...bb,
      points,
      ...(hasArrow ? { lineEndings: endings as [string, string] } : {}),
    };
  }
  // Polygon / PolyLine — vertices from the sidecar (pdf.js's parse where
  // present agrees; the sidecar is the one that always exists here).
  const rawVerts = sidecar.vertices ?? (a.vertices ? Array.from(a.vertices) : undefined);
  if (!rawVerts || rawVerts.length < 4) return null;
  const points: number[] = [];
  for (let i = 0; i + 1 < rawVerts.length; i += 2) {
    const [u, v] = pdfPointToDisplay(rawVerts[i], rawVerts[i + 1], box, rotation);
    points.push(u, v);
  }
  const bb = bboxOf(points);
  if (!bb) return null;
  if (a.subtype === 'Polygon') {
    if (sidecar.cloudy)
      return {
        ...base,
        shapeType: 'cloud',
        ...bb,
        points,
        ...(sidecar.cloudIntensity !== undefined ? { cloudIntensity: sidecar.cloudIntensity } : {}),
      };
    return { ...base, shapeType: 'polygon', ...bb, points };
  }
  // PolyLine: endings must be authorable (arrowheaded polylines round-trip).
  const endings = (sidecar.le ?? ['None', 'None']).slice(0, 2);
  while (endings.length < 2) endings.push('None');
  if (!endings.every((e) => AUTHORABLE_ENDINGS.has(e))) return null;
  const hasEnd = endings.some((e) => e !== 'None');
  return {
    ...base,
    shapeType: 'polyline',
    ...bb,
    points,
    ...(hasEnd ? { lineEndings: endings as [string, string] } : {}),
  };
}

/**
 * /Stamp + /IT /Count → kind 'count'.
 *
 * The group is `/Subj` and the marker is `/SpectraSymbol`; the sequence is
 * read off the end of `/Contents` ("<group> <seq>"), because the numbering is
 * a LABEL the user reads and a re-import that renumbered would rewrite the
 * sheet. An unknown symbol id falls back to the default marker rather than
 * refusing — a file counted by a later build must still open.
 */
function importCountMark(
  a: RawAnnotation,
  sidecar: RawAnnotStyle | undefined,
  box: ViewBox,
  rotation: number,
  color: string,
  contents: string | undefined,
  importedOriginal: ImportedAnnotationFingerprint,
): PageAnnotation | null {
  const d = pdfRectToDisplay(a.rect, box, rotation);
  if (d.w <= 0 || d.h <= 0) return null;
  const group = (sidecar?.subj ?? '').trim() || UNGROUPED;
  const symbolId = sidecar?.spectraSymbol ?? DEFAULT_COUNT_SYMBOL;
  // A marker from an imported SET carries its geometry beside the
  // id. Sanitized (bytes from a file are untrusted exactly like an imported
  // set file's), and an unreadable snapshot falls back to the id's built-in
  // rather than dropping the mark.
  const parts = partsFromJson(sidecar?.spectraSymbolParts);
  const seqMatch = /(\d+)\s*$/.exec(contents ?? '');
  return {
    id: crypto.randomUUID(),
    kind: 'count',
    ...d,
    color,
    note: contents,
    countGroup: group,
    // The ID passes through as the file spells it: a symbol this build does
    // not know is still that symbol, and `symbolById` only decides what to
    // DRAW when no geometry came with it.
    countSymbol: parts ? symbolId : symbolById(symbolId).id,
    ...(parts ? { symbolParts: parts } : {}),
    countSeq: seqMatch ? Number(seqMatch[1]) : 1,
    importedOriginal,
  };
}

/**
 * /Stamp + /SpectraSymbolParts (and no /IT) → a vector symbol stamp.
 *
 * The GEOMETRY is the annotation: the id only re-identifies it against the
 * registry, and a set the reader never imported makes the id meaningless
 * while the artwork stays exact. Sanitized before it is artwork — these bytes
 * become PDF path operators again on the next commit.
 */
function importSymbolStamp(
  a: RawAnnotation,
  sidecar: RawAnnotStyle | undefined,
  box: ViewBox,
  rotation: number,
  color: string,
  contents: string | undefined,
  importedOriginal: ImportedAnnotationFingerprint,
): PageAnnotation | null {
  const parts = partsFromJson(sidecar?.spectraSymbolParts);
  if (!parts) return null;
  const d = pdfRectToDisplay(a.rect, box, rotation);
  if (d.w <= 0 || d.h <= 0) return null;
  return {
    id: crypto.randomUUID(),
    kind: 'stamp',
    ...d,
    color,
    note: contents,
    ...(sidecar?.spectraSymbol ? { symbolId: sidecar.spectraSymbol } : {}),
    symbolParts: parts,
    importedOriginal,
  };
}

/**
 * /FreeText + /IT /CountLegend → kind 'countlegend'.
 *
 * The rows are a SNAPSHOT and live in the private /SpectraLegend; without a
 * readable one there is nothing to re-emit faithfully, so the original is left
 * untouched (returns null) instead of importing as a plain text box that would
 * lose the table on the next commit.
 */
function importCountLegend(
  a: RawAnnotation,
  sidecar: RawAnnotStyle | undefined,
  box: ViewBox,
  rotation: number,
  color: string,
  contents: string | undefined,
  importedOriginal: ImportedAnnotationFingerprint,
): PageAnnotation | null {
  if (!sidecar?.spectraLegend) return null;
  let parsed: { title?: unknown; totalWord?: unknown; rows?: unknown };
  try {
    parsed = JSON.parse(sidecar.spectraLegend) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.rows)) return null;
  const rows: CountLegendRow[] = [];
  for (const raw of parsed.rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.group !== 'string' || typeof r.count !== 'number') continue;
    rows.push({
      group: r.group,
      count: r.count,
      color: typeof r.color === 'string' ? r.color : color,
      symbol: symbolById(typeof r.symbol === 'string' ? r.symbol : undefined).id,
    });
  }
  const d = pdfRectToDisplay(a.rect, box, rotation);
  if (d.w <= 0 || d.h <= 0) return null;
  return {
    id: crypto.randomUUID(),
    kind: 'countlegend',
    ...d,
    color,
    note: contents,
    legendRows: rows,
    legendTitle: typeof parsed.title === 'string' ? parsed.title : '',
    legendTotalWord: typeof parsed.totalWord === 'string' ? parsed.totalWord : '',
    importedOriginal,
  };
}

/** /FreeText + /IT /FreeTextCallout → kind 'callout', sidecar-gated: the
 * leader (/CL) and text-box insets (/RD) only exist raw. */
function importCallout(
  a: RawAnnotation,
  sidecar: RawAnnotStyle | undefined,
  box: ViewBox,
  rotation: number,
  color: string,
  contents: string | undefined,
  importedOriginal: ImportedAnnotationFingerprint,
): PageAnnotation | null {
  if (!sidecar?.cl || sidecar.cl.length < 4) return null;
  if (sidecar.le && sidecar.le.length > 0 && !AUTHORABLE_ENDINGS.has(sidecar.le[0])) return null;
  const full = pdfRectToDisplay(a.rect, box, rotation);
  if (full.w <= 0 || full.h <= 0) return null;
  // /RD insets carve the text box out of /Rect (in PDF space, before the
  // display projection — project the inset rect like any other).
  const [rl, rt, rr, rb] = sidecar.rd ?? [0, 0, 0, 0];
  const textRectPdf: [number, number, number, number] = [
    a.rect[0] + rl,
    a.rect[1] + rb,
    a.rect[2] - rr,
    a.rect[3] - rt,
  ];
  const tb = pdfRectToDisplay(textRectPdf, box, rotation);
  const points: number[] = [];
  for (let i = 0; i + 1 < sidecar.cl.length; i += 2) {
    const [u, v] = pdfPointToDisplay(sidecar.cl[i], sidecar.cl[i + 1], box, rotation);
    points.push(u, v);
  }
  return {
    id: crypto.randomUUID(),
    kind: 'callout',
    ...full,
    calloutBox: [tb.x, tb.y, tb.w, tb.h],
    points,
    color,
    note: contents,
    strokeWidth: sidecar.strokeWidth ?? 1,
    ...(sidecar.opacity !== undefined && sidecar.opacity < 1 ? { opacity: sidecar.opacity } : {}),
    importedOriginal,
  };
}
