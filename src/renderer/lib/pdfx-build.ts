import { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFPage, PDFString, degrees } from 'pdf-lib';

import { MANIFEST_NAME, PDFX_VERSION } from './pdfx-format';
import type { ExportAnnotation, ExportDocument, ExportPage, PdfxManifest } from './pdfx-format';
import { carryAcroForm, prepareSourceForms, sourceHasXfa } from './acroform-carry';
import type { FormContribution } from './acroform-carry';
import { carryEmbeddedFiles } from './embedded-files-carry';
import { carryDocumentCatalog } from './catalog-carry';
import type { CarriedSourcePages } from './catalog-carry';
import { carryStructTree } from './struct-carry';
import { cloudBumps } from './annotation-manipulation';
import {
  LEGEND_FONT_SIZE,
  LEGEND_PAD,
  LEGEND_ROW_H,
  LEGEND_SYMBOL_W,
  legendLayout,
  symbolById,
} from './count-marks';

function applyRotation(copied: import('pdf-lib').PDFPage, page: ExportPage): void {
  if (!page.rotation) return;
  const angle = (((copied.getRotation().angle + page.rotation) % 360) + 360) % 360;
  copied.setRotation(degrees(angle));
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0xffd54a; // fallback: highlight yellow
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

// Map a single display-normalized point (top-left origin, in the orientation
// a viewer shows after applying the page's FINAL rotation) into PDF user
// space. Shared by displayRectToPdf (bbox corners) and ink stroke points —
// validated against pdf.js viewport round-trips in tests/workspace-commit.test.ts.
export function displayPointToPdf(
  u: number,
  v: number,
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): [number, number] {
  const { x: mx, y: my, width: W, height: H } = mediaBox;
  switch (((rotation % 360) + 360) % 360) {
    case 90: // page shown rotated 90° clockwise
      return [mx + v * W, my + u * H];
    case 180:
      return [mx + (1 - u) * W, my + v * H];
    case 270:
      return [mx + (1 - v) * W, my + (1 - u) * H];
    default:
      return [mx + u * W, my + (1 - v) * H];
  }
}

// Map a display-normalized rect back into PDF user space via its two corners.
export function displayRectToPdf(
  a: { x: number; y: number; w: number; h: number },
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): [number, number, number, number] {
  const mapped = [
    displayPointToPdf(a.x, a.y, mediaBox, rotation),
    displayPointToPdf(a.x + a.w, a.y + a.h, mediaBox, rotation),
  ];
  const xs = [mapped[0][0], mapped[1][0]];
  const ys = [mapped[0][1], mapped[1][1]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Inverse of displayPointToPdf — maps a PDF-user-space point back into
// display-normalized space for the page's CURRENT (pre-edit) rotation. Used
// only at import time (workspace.ts) to seed PageAnnotation from an existing
// PDF annotation's /Rect; re-derived algebraically from displayPointToPdf's
// four cases, not independently verified against the spec — the round-trip
// test in workspace-commit.test.ts is what actually proves it's a true
// inverse (import then re-export must reproduce the original /Rect).
export function pdfPointToDisplay(
  px: number,
  py: number,
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): [number, number] {
  const { x: mx, y: my, width: W, height: H } = mediaBox;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [(py - my) / H, (px - mx) / W];
    case 180:
      return [1 - (px - mx) / W, (py - my) / H];
    case 270:
      return [1 - (py - my) / H, 1 - (px - mx) / W];
    default:
      return [(px - mx) / W, 1 - (py - my) / H];
  }
}

// Inverse of displayRectToPdf — maps a PDF-space [x0,y0,x1,y1] rect back into
// a display-normalized {x,y,w,h} bbox via its two corners (same min/max
// pattern as the forward direction, since rotation can flip which corner is
// which in display space).
export function pdfRectToDisplay(
  rect: [number, number, number, number],
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = rect;
  const mapped = [
    pdfPointToDisplay(x0, y0, mediaBox, rotation),
    pdfPointToDisplay(x1, y1, mediaBox, rotation),
  ];
  const xs = [mapped[0][0], mapped[1][0]];
  const ys = [mapped[0][1], mapped[1][1]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// N11 slice C — a count symbol's unit-square parts as PDF path operators.
//
// The parts are authored y-DOWN (display orientation, `count-marks.ts`); PDF
// user space is y-UP, so v flips here and nowhere else. A circle becomes four
// cubics with the standard kappa — the appearance must print crisply at any
// scale, which is the whole reason the symbol registry is vector.
const KAPPA = 0.5522847498;

function symbolOps(parts: readonly import('./count-marks').SymbolPart[], w: number, h: number): string {
  const X = (u: number): number => round2(u * w);
  const Y = (v: number): number => round2((1 - v) * h);
  let out = '';
  for (const part of parts) {
    if (part.kind === 'circle') {
      const { cx, cy, r } = part;
      const kx = r * KAPPA;
      const ky = r * KAPPA;
      out +=
        `${X(cx + r)} ${Y(cy)} m ` +
        `${X(cx + r)} ${Y(cy + ky)} ${X(cx + kx)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ` +
        `${X(cx - kx)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + ky)} ${X(cx - r)} ${Y(cy)} c ` +
        `${X(cx - r)} ${Y(cy - ky)} ${X(cx - kx)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ` +
        `${X(cx + kx)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - ky)} ${X(cx + r)} ${Y(cy)} c h `;
      continue;
    }
    const pts = part.points;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      out += `${X(pts[i])} ${Y(pts[i + 1])} ${i === 0 ? 'm' : 'l'} `;
    }
    if (part.closed) out += 'h ';
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const HIGHLIGHT_ALPHA = 0.4;
const FREETEXT_FONT_SIZE = 12;
const STAMP_FONT_SIZE = 14;
const STAMP_PAD = 4;

// Escape a string for a PDF content-stream literal, best-effort WinAnsi:
// characters outside Latin-1 render as '?' in the appearance (the full
// unicode text still lands in /Contents).
function escapePdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (code >= 32 && code <= 255) out += ch;
    else out += '?';
  }
  return out;
}

// Greedy wrap using a rough Helvetica average advance (~0.5em) — the box
// clips anything that still overflows, matching the overlay's behavior.
function wrapLines(text: string, boxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(1, Math.floor(boxWidth / (fontSize * 0.5)));
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = '';
    for (const word of raw.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maxChars || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

// AP /Matrix that counter-rotates the form so its content reads upright
// after the viewer applies the page's /Rotate. The viewer maps the
// transformed BBox onto /Rect, so no translation is needed.
function apMatrixFor(rotation: number): number[] {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, -1, 1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, -1, 0, 0];
    case 270:
      return [0, 1, -1, 0, 0, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

// The cloud border's scalloped path (rung 2) as PDF operators — the bump
// geometry itself is shared with the SVG renderer (cloudBumps) so the two
// looks cannot drift.
function cloudPath(verts: [number, number][], r: number): string {
  const bumps = cloudBumps(verts, r);
  if (bumps.length === 0) return '';
  let out = `${bumps[0].s[0]} ${bumps[0].s[1]} m `;
  for (const b of bumps) {
    out += `${b.c1[0]} ${b.c1[1]} ${b.c2[0]} ${b.c2[1]} ${b.e[0]} ${b.e[1]} c `;
  }
  return out;
}

// Positively match and remove ORIGINAL annotation objects on the copied page
// that correspond to imported annotations in `annotations` (which the caller
// will re-append, possibly edited, right after this runs) — never a blanket
// subtype strip. See docs/architecture/05-phase2c-annotations.md, "importing
// existing annotations safely": an original we can't positively fingerprint
// against something we're re-authoring is left alone, so a matching miss can
// only ever produce a visible duplicate, never silent data loss.
function stripImportedOriginals(
  copied: import('pdf-lib').PDFPage,
  annotations: ExportAnnotation[],
  removedImportedOriginals: NonNullable<ExportAnnotation['importedOriginal']>[],
): void {
  // Two sources of fingerprints to strip-on-match: annotations being
  // re-appended (live, possibly edited) and ones the user REMOVED (tombstones
  // — matched and stripped same as any other, just never re-appended after).
  // Without the latter, deleting an imported annotation would be a no-op:
  // its fingerprint vanishes with it, nothing left to match the real PDF
  // object against, and the "original" reappears on reindex after commit.
  const fingerprints = [
    ...annotations.map((a) => a.importedOriginal),
    ...removedImportedOriginals,
  ].filter((f): f is NonNullable<ExportAnnotation['importedOriginal']> => !!f);
  if (fingerprints.length === 0) return;
  const annots = copied.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return;
  const consumed = new Set<number>(); // indices into `fingerprints` already matched
  // Iterate back-to-front: PDFArray.remove(index) shifts later indices, which
  // would desync a forward loop's remaining indices mid-iteration.
  for (let i = annots.size() - 1; i >= 0; i--) {
    let dict: PDFDict;
    try {
      dict = annots.lookup(i, PDFDict);
    } catch {
      continue; // not a dict (shouldn't happen for a valid /Annots entry) — leave it
    }
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    const STRIPPABLE = new Set([
      'Square', 'FreeText', 'Ink', 'Stamp', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text',
      // Rung 2 — the imported drawing shapes re-append like everything else.
      'Circle', 'Line', 'Polygon', 'PolyLine',
    ]);
    if (!subtype || !STRIPPABLE.has(subtype)) continue;
    const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!rectArr || rectArr.size() !== 4) continue;
    const rect = [0, 1, 2, 3].map((j) => rectArr.lookup(j) as import('pdf-lib').PDFNumber).map((n) => n.asNumber());
    const contentsObj = dict.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
    const contents = contentsObj?.decodeText();
    const matchIndex = fingerprints.findIndex(
      (fp, idx) =>
        !consumed.has(idx) &&
        fp.subtype === subtype &&
        (fp.contents ?? '') === (contents ?? '') &&
        // /Text sticky-note rects are REWRITTEN by pdf.js to a fixed icon size
        // (import reads pdf.js's rect, not the file's /Rect), so a rect compare
        // would never match — match those on subtype+contents alone.
        (subtype === 'Text' || fp.rect.every((v, k) => Math.abs(v - rect[k]) <= 0.5)),
    );
    if (matchIndex === -1) continue; // no positive match — never guess-remove
    consumed.add(matchIndex);
    annots.remove(i);
  }
}

function addAnnotations(
  output: PDFDocument,
  copied: import('pdf-lib').PDFPage,
  annotations: ExportAnnotation[],
  removedImportedOriginals: NonNullable<ExportAnnotation['importedOriginal']>[],
  stampImages: Map<string, import('pdf-lib').PDFImage>,
): void {
  stripImportedOriginals(copied, annotations, removedImportedOriginals);
  const context = output.context;
  // CropBox (defaults to MediaBox when absent, so byte-identical for the
  // common case) — must match what annotation-import.ts reads via pdf.js's
  // page.view (the crop-intersected box), or an imported annotation's
  // position drifts by the crop offset the moment it's edited and re-baked.
  const { x, y, width, height } = copied.getCropBox();
  const rotation = ((copied.getRotation().angle % 360) + 360) % 360;
  for (const a of annotations) {
    const [rx0, ry0, rx1, ry1] = displayRectToPdf(a, { x, y, width, height }, rotation);
    // Ink strokes, measure lines, and the point-defined shapes are
    // legitimately zero-width/height (a straight horizontal or vertical
    // line) — degenerate only for the box-shaped kinds.
    const pointsKind =
      a.kind === 'ink' ||
      a.kind === 'measure' ||
      (a.kind === 'shape' && a.shapeType !== 'rect' && a.shapeType !== 'ellipse');
    if (!pointsKind && (rx1 - rx0 <= 0 || ry1 - ry0 <= 0)) continue;
    // Pad the points kinds' rect/BBox past the stroke's half-width so a flat
    // line's edge isn't sitting exactly on the BBox boundary (a Form XObject
    // clips to BBox, and that's a knife-edge float-rounding risk at pad ==
    // half-width). Ink/measure keep their original 2 (byte-stable output);
    // shapes pad enough to cover arrowheads and cloud bumps at any stroke
    // width. Box shapes draw inset instead.
    const pad =
      a.kind === 'ink' || a.kind === 'measure'
        ? 2
        : pointsKind
          ? Math.max(2, (a.strokeWidth ?? 2) * 5 + 6)
          : 0;
    const x0 = rx0 - pad;
    const y0 = ry0 - pad;
    const x1 = rx1 + pad;
    const y1 = ry1 + pad;
    const w = x1 - x0;
    const h = y1 - y0;
    const [r, g, b] = hexToRgb(a.color);
    // Display-orientation dims — appearance content is authored in display
    // space and counter-rotated by the AP matrix so it reads upright.
    const swapped = rotation === 90 || rotation === 270;
    const dispW = swapped ? h : w;
    const dispH = swapped ? w : h;

    let annot;
    if (a.kind === 'freetext') {
      const text = a.note ?? '';
      const fontRef = context.register(
        context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
        }),
      );
      const leading = FREETEXT_FONT_SIZE * 1.2;
      const pad = 3;
      const lines = wrapLines(text, dispW - pad * 2, FREETEXT_FONT_SIZE);
      const tj = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join(' ');
      const content =
        `0.98 0.98 0.96 rg 0 0 ${dispW} ${dispH} re f ` +
        `${r} ${g} ${b} RG 0.75 w 0.5 0.5 ${dispW - 1} ${dispH - 1} re S ` +
        `BT /Helv ${FREETEXT_FONT_SIZE} Tf ${leading} TL ${r} ${g} ${b} rg ` +
        `${pad} ${dispH - FREETEXT_FONT_SIZE - pad} Td ${tj} ET`;
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
          Resources: { Font: { Helv: fontRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        AP: { N: ap },
      });
      annot.set(PDFName.of('DA'), PDFHexString.fromText(`${r} ${g} ${b} rg /Helv ${FREETEXT_FONT_SIZE} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    } else if (a.kind === 'ink') {
      // Rung 2's shared style edit reaches ink too: width + opacity (default
      // 2 / opaque — byte-identical to the pre-rung-2 output when unset).
      // N2: one /InkList entry AND one AP sub-path per stroke — a signature
      // of several pen lifts round-trips as exactly its strokes.
      const strokeW = a.strokeWidth ?? 2;
      const strokesPdf: number[][] = (a.strokes ?? []).map((stroke) => {
        const flat: number[] = [];
        for (let i = 0; i < stroke.length; i += 2) {
          const [px, py] = displayPointToPdf(stroke[i], stroke[i + 1], { x, y, width, height }, rotation);
          flat.push(px, py);
        }
        return flat;
      });
      let content = `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j `;
      for (const flat of strokesPdf) {
        for (let i = 0; i < flat.length; i += 2) {
          const px = flat[i] - x0;
          const py = flat[i + 1] - y0;
          content += i === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
        }
        content += 'S ';
      }
      const ap = context.register(
        context.stream(content.trimEnd(), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        InkList: strokesPdf,
        BS: { W: strokeW },
        AP: { N: ap },
      });
      if (a.opacity !== undefined && a.opacity < 1) annot.set(PDFName.of('CA'), context.obj(a.opacity));
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    } else if (a.kind === 'measure') {
      // A REAL dimension annotation (the king's class): /Line //PolyLine
      // //Polygon with /IT + /Measure, so other tools can RE-MEASURE it —
      // the value in /Contents is a convenience, the geometry + /Measure /C
      // factors are the contract. The AP mirrors ink's stroke look.
      const strokeW = 2;
      const flatPdf: number[] = [];
      for (let i = 0; i < (a.points?.length ?? 0); i += 2) {
        const [px, py] = displayPointToPdf(a.points![i], a.points![i + 1], { x, y, width, height }, rotation);
        flatPdf.push(px, py);
      }
      let content = `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j `;
      for (let i = 0; i < flatPdf.length; i += 2) {
        const px = flatPdf[i] - x0;
        const py = flatPdf[i + 1] - y0;
        content += i === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
      }
      content += 'S';
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
        }),
      );
      const subtype =
        a.measureKind === 'distance' ? 'Line' : a.measureKind === 'area' ? 'Polygon' : 'PolyLine';
      const it =
        a.measureKind === 'distance'
          ? 'LineDimension'
          : a.measureKind === 'area'
            ? 'PolygonDimension'
            : 'PolyLineDimension';
      annot = context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        IT: it,
        BS: { W: strokeW },
        AP: { N: ap },
      });
      if (subtype === 'Line') {
        annot.set(PDFName.of('L'), context.obj(flatPdf.slice(0, 4)));
      } else {
        // The area tool stores a CLOSED ring (last point repeats the first)
        // so the on-page stroke closes; /Polygon closes itself — emit the
        // vertices without the duplicate.
        const vertices =
          subtype === 'Polygon' && flatPdf.length >= 4 ? flatPdf.slice(0, -2) : flatPdf;
        annot.set(PDFName.of('Vertices'), context.obj(vertices));
      }
      if (a.measureRatio && a.measureUnitsPerPt && a.measureUnit) {
        const fmt = (c: number) =>
          context.obj({ Type: 'NumberFormat', U: PDFHexString.fromText(a.measureUnit!), C: c, D: 100, F: 'D' });
        annot.set(
          PDFName.of('Measure'),
          context.obj({
            Type: 'Measure',
            R: PDFHexString.fromText(a.measureRatio),
            X: [fmt(a.measureUnitsPerPt)],
            D: [fmt(a.measureUnitsPerPt)],
            A: [fmt(a.measureUnitsPerPt * a.measureUnitsPerPt)],
          }),
        );
      }
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    } else if (a.kind === 'shape') {
      // Rung 2: a drawing shape commits as its REAL subtype with a faithful
      // appearance. /BS is ALWAYS written — its presence is what tells the
      // importer a /Square is a rectangle and not a highlight box.
      const strokeW = a.strokeWidth ?? 2;
      const fill = a.fillColor ? hexToRgb(a.fillColor) : null;
      const paint = fill ? 'B' : 'S';
      const setColors =
        `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j ` + (fill ? `${fill[0]} ${fill[1]} ${fill[2]} rg ` : '');
      const flatPdf: number[] = [];
      for (let i = 0; i < (a.points?.length ?? 0); i += 2) {
        const [px, py] = displayPointToPdf(a.points![i], a.points![i + 1], { x, y, width, height }, rotation);
        flatPdf.push(px, py);
      }
      const local = (i: number): [number, number] => [flatPdf[i] - x0, flatPdf[i + 1] - y0];
      let content = setColors;
      let subtype: string;
      const extra: [string, unknown][] = [];
      const endings = a.lineEndings ?? (a.shapeType === 'arrow' ? ['None', 'OpenArrow'] : null);
      // An arrowhead at `at`, pointing away from `from`. Open = two strokes;
      // Closed = a filled triangle (interior takes the fill colour, else the
      // stroke colour — Acrobat's look).
      const arrowhead = (at: [number, number], from: [number, number], style: string): string => {
        if (style === 'None') return '';
        const dx = at[0] - from[0];
        const dy = at[1] - from[1];
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const hl = 4 * strokeW + 6; // head length
        const spread = 0.45;
        const bx = at[0] - ux * hl;
        const by = at[1] - uy * hl;
        const p1: [number, number] = [bx - uy * hl * spread, by + ux * hl * spread];
        const p2: [number, number] = [bx + uy * hl * spread, by - ux * hl * spread];
        if (style === 'ClosedArrow') {
          const headFill = fill ?? [r, g, b];
          return (
            `${headFill[0]} ${headFill[1]} ${headFill[2]} rg ` +
            `${p1[0]} ${p1[1]} m ${at[0]} ${at[1]} l ${p2[0]} ${p2[1]} l h B `
          );
        }
        return `${p1[0]} ${p1[1]} m ${at[0]} ${at[1]} l ${p2[0]} ${p2[1]} l S `;
      };
      if (a.shapeType === 'rect') {
        subtype = 'Square';
        const inset = strokeW / 2;
        content += `${inset} ${inset} ${Math.max(0, w - strokeW)} ${Math.max(0, h - strokeW)} re ${paint}`;
      } else if (a.shapeType === 'ellipse') {
        subtype = 'Circle';
        const k = 0.5523;
        const cx = w / 2;
        const cy = h / 2;
        const rx = Math.max(0, (w - strokeW) / 2);
        const ry = Math.max(0, (h - strokeW) / 2);
        content +=
          `${cx + rx} ${cy} m ` +
          `${cx + rx} ${cy + ry * k} ${cx + rx * k} ${cy + ry} ${cx} ${cy + ry} c ` +
          `${cx - rx * k} ${cy + ry} ${cx - rx} ${cy + ry * k} ${cx - rx} ${cy} c ` +
          `${cx - rx} ${cy - ry * k} ${cx - rx * k} ${cy - ry} ${cx} ${cy - ry} c ` +
          `${cx + rx * k} ${cy - ry} ${cx + rx} ${cy - ry * k} ${cx + rx} ${cy} c ` +
          `h ${paint}`;
      } else if (a.shapeType === 'line' || a.shapeType === 'arrow') {
        subtype = 'Line';
        const p0 = local(0);
        const p1 = local(2);
        content += `${p0[0]} ${p0[1]} m ${p1[0]} ${p1[1]} l S `;
        if (endings) {
          content += arrowhead(p0, p1, endings[0]);
          content += arrowhead(p1, p0, endings[1]);
          extra.push(['LE', context.obj(endings.map((e) => PDFName.of(e)))]);
        }
        extra.push(['L', context.obj(flatPdf.slice(0, 4))]);
      } else if (a.shapeType === 'polyline') {
        subtype = 'PolyLine';
        for (let i = 0; i < flatPdf.length; i += 2) {
          const [px, py] = local(i);
          content += i === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
        }
        content += 'S ';
        if (endings) {
          const n = flatPdf.length;
          content += arrowhead(local(0), local(2), endings[0]);
          content += arrowhead(local(n - 2), local(n - 4), endings[1]);
          extra.push(['LE', context.obj(endings.map((e) => PDFName.of(e)))]);
        }
        extra.push(['Vertices', context.obj(flatPdf)]);
      } else {
        // polygon / cloud
        subtype = 'Polygon';
        if (a.shapeType === 'cloud') {
          const intensity = a.cloudIntensity ?? 2;
          content += cloudPath(
            Array.from({ length: flatPdf.length / 2 }, (_, i) => local(i * 2)),
            4 * intensity + 2,
          );
          content += paint === 'B' ? 'B' : 'S';
          extra.push(['BE', context.obj({ S: 'C', I: intensity })]);
          extra.push(['IT', PDFName.of('PolygonCloud')]);
        } else {
          for (let i = 0; i < flatPdf.length; i += 2) {
            const [px, py] = local(i);
            content += i === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
          }
          content += `h ${paint}`;
        }
        extra.push(['Vertices', context.obj(flatPdf)]);
      }
      // Pad the BBox past the stroke (and any arrowheads/cloud bumps) — a
      // Form XObject clips to BBox, the ink lesson at larger widths.
      const pad = strokeW * 6 + 8;
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [-pad, -pad, w + pad, h + pad],
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        BS: { W: strokeW },
        AP: { N: ap },
      });
      for (const [k2, v2] of extra) annot.set(PDFName.of(k2), v2 as Parameters<typeof annot.set>[1]);
      if (fill) annot.set(PDFName.of('IC'), context.obj(fill));
      if (a.opacity !== undefined && a.opacity < 1) annot.set(PDFName.of('CA'), context.obj(a.opacity));
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    } else if (a.kind === 'callout') {
      // Rung 2: /FreeText + /IT /FreeTextCallout + /CL. The whole appearance
      // (text box + leader) is authored in DISPLAY space and counter-rotated
      // by the AP matrix like freetext; /CL itself is page-space semantic
      // data for other editors.
      const strokeW = a.strokeWidth ?? 1;
      const text = a.note ?? '';
      const cb = a.calloutBox ?? [a.x, a.y, a.w, a.h];
      // Display-normalized → AP-local (origin bottom-left, dispW×dispH).
      const lx = (nx: number): number => (a.w > 0 ? ((nx - a.x) / a.w) * dispW : 0);
      const ly = (ny: number): number => (a.h > 0 ? (1 - (ny - a.y) / a.h) * dispH : 0);
      const bx0 = lx(cb[0]);
      const by1 = ly(cb[1]); // top edge in AP space
      const bw = a.w > 0 ? (cb[2] / a.w) * dispW : dispW;
      const bh = a.h > 0 ? (cb[3] / a.h) * dispH : dispH;
      const by0 = by1 - bh;
      const fontRef = context.register(
        context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
      );
      const leading = FREETEXT_FONT_SIZE * 1.2;
      const pad = 3;
      const lines = wrapLines(text, bw - pad * 2, FREETEXT_FONT_SIZE);
      const tj = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join(' ');
      // Leader in AP-local space, arrowhead at the tip (points[0]).
      const pts = a.points ?? [];
      let leader = '';
      if (pts.length >= 4) {
        leader += `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j `;
        for (let i = 0; i < pts.length; i += 2) {
          const px = lx(pts[i]);
          const py = ly(pts[i + 1]);
          leader += i === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
        }
        leader += 'S ';
        const tip: [number, number] = [lx(pts[0]), ly(pts[1])];
        const from: [number, number] = [lx(pts[2]), ly(pts[3])];
        const dxv = tip[0] - from[0];
        const dyv = tip[1] - from[1];
        const len = Math.hypot(dxv, dyv) || 1;
        const hl = 4 * strokeW + 6;
        const ux = dxv / len;
        const uy = dyv / len;
        const bxp = tip[0] - ux * hl;
        const byp = tip[1] - uy * hl;
        leader += `${bxp - uy * hl * 0.45} ${byp + ux * hl * 0.45} m ${tip[0]} ${tip[1]} l ${bxp + uy * hl * 0.45} ${byp - ux * hl * 0.45} l S `;
      }
      const content =
        leader +
        `0.98 0.98 0.96 rg ${bx0} ${by0} ${bw} ${bh} re f ` +
        `${r} ${g} ${b} RG ${Math.max(0.75, strokeW)} w ${bx0 + 0.5} ${by0 + 0.5} ${bw - 1} ${bh - 1} re S ` +
        `BT /Helv ${FREETEXT_FONT_SIZE} Tf ${leading} TL ${r} ${g} ${b} rg ` +
        `${bx0 + pad} ${by1 - FREETEXT_FONT_SIZE - pad} Td ${tj} ET`;
      const apPad = strokeW * 6 + 8;
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [-apPad, -apPad, dispW + apPad, dispH + apPad],
          Matrix: apMatrixFor(rotation),
          Resources: { Font: { Helv: fontRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        IT: 'FreeTextCallout',
        BS: { W: strokeW },
        AP: { N: ap },
      });
      // /CL in page space; /RD carves the text box out of /Rect. Both are in
      // the PDF frame, so project the display geometry the standard way.
      const clPdf: number[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const [px, py] = displayPointToPdf(pts[i], pts[i + 1], { x, y, width, height }, rotation);
        clPdf.push(px, py);
      }
      if (clPdf.length >= 4) annot.set(PDFName.of('CL'), context.obj(clPdf));
      const [tbx0, tby0, tbx1, tby1] = displayRectToPdf(
        { x: cb[0], y: cb[1], w: cb[2], h: cb[3] },
        { x, y, width, height },
        rotation,
      );
      annot.set(
        PDFName.of('RD'),
        context.obj([
          Math.max(0, tbx0 - x0),
          Math.max(0, y1 - tby1),
          Math.max(0, x1 - tbx1),
          Math.max(0, tby0 - y0),
        ]),
      );
      annot.set(PDFName.of('LE'), PDFName.of(a.lineEndings?.[0] ?? 'OpenArrow'));
      if (a.opacity !== undefined && a.opacity < 1) annot.set(PDFName.of('CA'), context.obj(a.opacity));
      annot.set(PDFName.of('DA'), PDFHexString.fromText(`${r} ${g} ${b} rg /Helv ${FREETEXT_FONT_SIZE} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    } else if (a.kind === 'count') {
      // A TAKEOFF COUNT MARK — a real /Stamp, so it survives save/reload as an
      // annotation and degrades honestly (any viewer shows a printable symbol
      // with a subject and a "<group> <seq>" contents). The private keys ride
      // beside it on the /SpectraMask precedent already shipped in P7 slice E:
      //
      //   /IT /Count           the intent. §12.5.6.10 requires a conforming
      //                        reader to IGNORE an intent it doesn't know, so
      //                        an unrecognized /IT on a /Stamp is safe by the
      //                        spec's own rule rather than by convention.
      //   /Subj                the group NAME — user data, verbatim.
      //   /Contents            "<group> <seq>".
      //   /NM                  the stable mark id.
      //   /SpectraSymbol       which vector symbol the marker draws.
      const symbol = symbolById(a.countSymbol);
      const strokeW = 1.5;
      const gsRef = context.register(context.obj({ Type: 'ExtGState', ca: 0.18 }));
      // The path is emitted ONCE and painted twice (translucent fill, then the
      // opaque outline) — `B` would apply the alpha to both.
      const ops = symbolOps(symbol.parts, dispW, dispH);
      const content =
        `q /GS0 gs ${r} ${g} ${b} rg ${ops}f Q ` +
        `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j ${ops}S`;
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
          Resources: { ExtGState: { GS0: gsRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        IT: 'Count',
        AP: { N: ap },
      });
      annot.set(PDFName.of('Subj'), PDFHexString.fromText(a.countGroup ?? ''));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ?? ''));
      // /NM is derived from (group, sequence), not from the in-memory
      // annotation id: the pair is unique by construction and ROUND-TRIPS,
      // where a fresh uuid would be minted on every import and the mark's
      // stable name would churn on every save.
      annot.set(
        PDFName.of('NM'),
        PDFString.of(`count-${a.countGroup ?? ''}-${a.countSeq ?? 0}`),
      );
      annot.set(PDFName.of('SpectraSymbol'), PDFName.of(symbol.id));
    } else if (a.kind === 'countlegend') {
      // A PLACED LEGEND — /FreeText + /IT /CountLegend, with the table drawn
      // in the appearance (symbol swatches included, so the legend reads as
      // the marks do) and the same table as plain text in /Contents.
      //
      // The rows are a SNAPSHOT and ride in the private /SpectraLegend so a
      // re-commit reproduces exactly what was placed. Re-deriving them at
      // commit time would silently rewrite a legend the user placed
      // deliberately, which is the same class of lie as a stored tally.
      const rows = a.legendRows ?? [];
      const title = a.legendTitle ?? '';
      const totalWord = a.legendTotalWord ?? '';
      const layout = legendLayout(rows, title);
      const fontRef = context.register(
        context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
      );
      const boldRef = context.register(
        context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' }),
      );
      // Scale the laid-out table onto whatever box the annotation now has, so
      // a resized legend scales instead of clipping.
      const sx = layout.widthPt > 0 ? dispW / layout.widthPt : 1;
      const sy = layout.heightPt > 0 ? dispH / layout.heightPt : 1;
      const fs = LEGEND_FONT_SIZE;
      const textAt = (
        tx: number,
        yDown: number,
        font: string,
        color: [number, number, number],
        text: string,
      ): string =>
        `BT /${font} ${fs} Tf ${color[0]} ${color[1]} ${color[2]} rg ` +
        `${round2(tx)} ${round2(layout.heightPt - yDown)} Td (${escapePdfText(text)}) Tj ET `;
      const rightAt = (yDown: number, font: string, text: string): string => {
        const w = text.length * fs * 0.55;
        return textAt(layout.widthPt - LEGEND_PAD - w, yDown, font, [0.1, 0.1, 0.1], text);
      };
      let content =
        `q ${round2(sx)} 0 0 ${round2(sy)} 0 0 cm ` +
        `1 1 1 rg 0 0 ${round2(layout.widthPt)} ${round2(layout.heightPt)} re f ` +
        `${r} ${g} ${b} RG 1 w 0.5 0.5 ${round2(layout.widthPt - 1)} ${round2(layout.heightPt - 1)} re S ` +
        textAt(LEGEND_PAD, LEGEND_PAD + LEGEND_ROW_H * 0.8, 'HelvB', [0.1, 0.1, 0.1], title);
      for (const row of layout.rows) {
        const [sr, sg, sb] = hexToRgb(row.color);
        const sym = symbolById(row.symbol);
        // The swatch is the symbol itself, drawn at row height in a nested
        // q/Q so its own translation never leaks into the text that follows.
        content +=
          `q 1 0 0 1 ${round2(LEGEND_PAD)} ${round2(layout.heightPt - row.y - fs * 0.2 - LEGEND_SYMBOL_W + 2)} cm ` +
          `${sr} ${sg} ${sb} RG 1 w 1 J 1 j ${symbolOps(sym.parts, LEGEND_SYMBOL_W, LEGEND_SYMBOL_W)}S Q ` +
          textAt(LEGEND_PAD + LEGEND_SYMBOL_W + 4, row.y, 'Helv', [0.1, 0.1, 0.1], row.group) +
          rightAt(row.y, 'Helv', String(row.count));
      }
      content +=
        `0.5 0.5 0.5 RG 0.5 w ${round2(LEGEND_PAD)} ${round2(layout.heightPt - layout.totalY - fs * 0.4)} m ` +
        `${round2(layout.widthPt - LEGEND_PAD)} ${round2(layout.heightPt - layout.totalY - fs * 0.4)} l S ` +
        textAt(LEGEND_PAD, layout.totalY, 'HelvB', [0.1, 0.1, 0.1], totalWord) +
        rightAt(layout.totalY, 'HelvB', String(layout.total)) +
        'Q';
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
          Resources: { Font: { Helv: fontRef, HelvB: boldRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        IT: 'CountLegend',
        AP: { N: ap },
      });
      annot.set(PDFName.of('DA'), PDFHexString.fromText(`0.1 0.1 0.1 rg /Helv ${fs} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ?? ''));
      annot.set(
        PDFName.of('SpectraLegend'),
        PDFHexString.fromText(
          JSON.stringify({ title, totalWord, rows }),
        ),
      );
    } else if (a.kind === 'stamp' && a.imageData && stampImages.get(a.imageData)) {
      // A custom IMAGE stamp: the appearance draws the pre-embedded raster —
      // no border, no fill, the king's look. /Contents keeps the display name.
      const img = stampImages.get(a.imageData)!;
      const ap = context.register(
        context.stream(`q ${dispW} 0 0 ${dispH} 0 0 cm /Im0 Do Q`, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
          Resources: { XObject: { Im0: img.ref } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        AP: { N: ap },
      });
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ?? ''));
    } else if (a.kind === 'stamp') {
      const label = (a.note ?? '').toUpperCase();
      const fontRef = context.register(
        context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica-Bold',
          Encoding: 'WinAnsiEncoding',
        }),
      );
      // Single centered line, clipped (not wrapped) to the box — stamps are
      // short fixed labels, not free-form text.
      const maxChars = Math.max(1, Math.floor((dispW - STAMP_PAD * 2) / (STAMP_FONT_SIZE * 0.6)));
      const clipped = label.length > maxChars ? label.slice(0, maxChars) : label;
      const textWidth = clipped.length * STAMP_FONT_SIZE * 0.6;
      const tx = Math.max(STAMP_PAD, (dispW - textWidth) / 2);
      const ty = (dispH - STAMP_FONT_SIZE) / 2 + STAMP_FONT_SIZE * 0.2;
      // Translucent fill wrapped in q/Q so only the background rect picks up
      // the ExtGState alpha — the border and text stay fully opaque.
      const content =
        `q /GS0 gs ${r} ${g} ${b} rg 0 0 ${dispW} ${dispH} re f Q ` +
        `${r} ${g} ${b} RG 1.5 w 0.75 0.75 ${dispW - 1.5} ${dispH - 1.5} re S ` +
        `BT /HelvB ${STAMP_FONT_SIZE} Tf ${r} ${g} ${b} rg ${tx} ${ty} Td (${escapePdfText(clipped)}) Tj ET`;
      const gsRef = context.register(context.obj({ Type: 'ExtGState', ca: 0.12 }));
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
          Resources: { Font: { HelvB: fontRef }, ExtGState: { GS0: gsRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        AP: { N: ap },
      });
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(label));
    } else if (a.kind === 'note') {
      // Native /Text sticky note: a comment icon at the rect with its text in
      // /Contents. Viewers draw the /Name icon; /C tints it. No /AP needed.
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [x0, y0, x1, y1],
        Name: 'Note',
        C: [r, g, b],
        Open: false,
        F: 4, // print
      });
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ?? ''));
    } else if (a.kind === 'textmarkup') {
      // N1 native text markup — round-trips as the real /Highlight, /Underline,
      // /StrikeOut, or /Squiggly with /QuadPoints (one quad per marked run) and
      // an /AP authored in PDF space relative to the annot origin (like ink,
      // no counter-rotation matrix).
      const mt = a.markupType ?? 'highlight';
      const SUBTYPE = ({ highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' } as const)[mt];
      const pdfQuads: [number, number, number, number][] = [];
      const quadPoints: number[] = [];
      const qs = a.quads ?? [];
      for (let i = 0; i + 3 < qs.length; i += 4) {
        const [qx0, qy0, qx1, qy1] = displayRectToPdf(
          { x: qs[i], y: qs[i + 1], w: qs[i + 2] - qs[i], h: qs[i + 3] - qs[i + 1] },
          { x, y, width, height },
          rotation,
        );
        pdfQuads.push([qx0, qy0, qx1, qy1]);
        // /QuadPoints in the widely-used Acrobat order: UL, UR, LL, LR.
        quadPoints.push(qx0, qy1, qx1, qy1, qx0, qy0, qx1, qy0);
      }
      let content: string;
      let apResources: { ExtGState: { GS0: import('pdf-lib').PDFRef } } | undefined;
      if (mt === 'highlight') {
        const gsRef = context.register(context.obj({ Type: 'ExtGState', ca: HIGHLIGHT_ALPHA, CA: HIGHLIGHT_ALPHA }));
        apResources = { ExtGState: { GS0: gsRef } };
        content = `q /GS0 gs ${r} ${g} ${b} rg `;
        for (const [qx0, qy0, qx1, qy1] of pdfQuads) {
          content += `${qx0 - x0} ${qy0 - y0} ${qx1 - qx0} ${qy1 - qy0} re f `;
        }
        content += 'Q';
      } else {
        content = `${r} ${g} ${b} RG 1 w `;
        for (const [qx0, qy0, qx1, qy1] of pdfQuads) {
          if (mt === 'squiggly') {
            const steps = Math.max(2, Math.round((qx1 - qx0) / 6));
            const amp = Math.min(2, (qy1 - qy0) * 0.25);
            for (let s = 0; s <= steps; s++) {
              const px = qx0 - x0 + ((qx1 - qx0) * s) / steps;
              const py = qy0 - y0 + (s % 2 === 0 ? 0 : amp);
              content += s === 0 ? `${px} ${py} m ` : `${px} ${py} l `;
            }
            content += 'S ';
          } else {
            const yl = (mt === 'strikeout' ? (qy0 + qy1) / 2 : qy0) - y0;
            content += `${qx0 - x0} ${yl} m ${qx1 - x0} ${yl} l S `;
          }
        }
      }
      const ap = context.register(
        context.stream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
          ...(apResources ? { Resources: apResources } : {}),
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: SUBTYPE,
        Rect: [x0, y0, x1, y1],
        QuadPoints: quadPoints,
        C: [r, g, b],
        F: 4, // print
        AP: { N: ap },
      });
      if (mt === 'highlight') annot.set(PDFName.of('CA'), context.obj(HIGHLIGHT_ALPHA));
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    } else {
      // Appearance stream — pdf.js and friends render /AP, not bare dicts.
      const gsRef = context.register(
        context.obj({ Type: 'ExtGState', CA: HIGHLIGHT_ALPHA, ca: HIGHLIGHT_ALPHA }),
      );
      const ap = context.register(
        context.stream(`/GS0 gs ${r} ${g} ${b} rg 0 0 ${w} ${h} re f`, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
          Resources: { ExtGState: { GS0: gsRef } },
        }),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        IC: [r, g, b],
        CA: HIGHLIGHT_ALPHA,
        F: 4, // print
        AP: { N: ap },
      });
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    }
    const ref = context.register(annot);
    let annots = copied.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      annots = context.obj([]) as PDFArray;
      copied.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
  }
}

function applyPageExtras(
  copied: import('pdf-lib').PDFPage,
  page: ExportPage,
  output: PDFDocument,
  stampImages: Map<string, import('pdf-lib').PDFImage>,
): void {
  applyRotation(copied, page);
  // Must still run when `annotations` is empty but removedImportedOriginals
  // isn't — e.g. the user deleted the only imported annotation on this page,
  // leaving nothing to re-append but still needing the original stripped.
  if (page.annotations?.length || page.removedImportedOriginals?.length) {
    addAnnotations(output, copied, page.annotations ?? [], page.removedImportedOriginals ?? [], stampImages);
  }
}

/** Pre-embed every distinct custom-stamp image (data URL → PDFImage): the
 * per-page annotation emit is synchronous, and pdf-lib's embed APIs are not.
 * An unreadable image embeds nothing — the emit falls back to the bordered
 * label rather than failing the commit. */
async function embedStampImages(
  output: PDFDocument,
  pages: ExportPage[],
): Promise<Map<string, import('pdf-lib').PDFImage>> {
  const map = new Map<string, import('pdf-lib').PDFImage>();
  for (const page of pages) {
    for (const a of page.annotations ?? []) {
      if (a.kind !== 'stamp' || !a.imageData || map.has(a.imageData)) continue;
      try {
        const b64 = a.imageData.slice(a.imageData.indexOf(',') + 1);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const img = a.imageData.startsWith('data:image/png')
          ? await output.embedPng(bytes)
          : await output.embedJpg(bytes);
        map.set(a.imageData, img);
      } catch {
        // fall through — emit uses the text look for this one
      }
    }
  }
  return map;
}

// Load each distinct source once, prepare its form-field trees for the kept
// subset of pages, and copy every kept page in ONE copyPages call per source
// — pdf-lib's object copier caches per call, so a field tree shared by
// widgets on several kept pages copies ONCE (the old per-page calls would
// have duplicated the root and forked same-name fields). Pages are then
// added in output order, and carryAcroForm rebuilds the output /AcroForm
// from the copied widgets — without it a rebuild destroys every form field
// (see lib/acroform-carry.ts).
async function assemblePages(
  output: PDFDocument,
  pages: ExportPage[],
  ownSourceKey?: string,
): Promise<void> {
  const groups = new Map<string, { bytes: Uint8Array; indices: number[] }>();
  for (const page of pages) {
    let g = groups.get(page.sourceKey);
    if (!g) {
      g = { bytes: page.bytes, indices: [] };
      groups.set(page.sourceKey, g);
    }
    if (!g.indices.includes(page.pageIndex)) g.indices.push(page.pageIndex);
  }
  const sources = new Map<
    string,
    { doc: PDFDocument; copiedByIndex: Map<number, PDFPage>; contribution: FormContribution }
  >();
  const contributions: FormContribution[] = [];
  for (const [key, g] of groups) {
    const doc = await PDFDocument.load(g.bytes, { ignoreEncryption: true });
    if (sourceHasXfa(doc)) {
      // F11: page surgery on an XFA form detaches the form from its pages
      // (the XFA template lays out its own) — refuse with the reason rather
      // than silently dropping the packet (the old behavior) or carrying a
      // lie. Same refusal the engine ops make (acroform.py refuse_if_xfa).
      const file = key.split('#')[0].split(/[\\/]/).pop() || key;
      throw new Error(
        `${file} contains an XML form (XFA). Page edits would detach the ` +
          'form from its pages, so they are not available for this document.',
      );
    }
    prepareSourceForms(doc, g.indices);
    const copied = await output.copyPages(doc, g.indices);
    const copiedByIndex = new Map<number, PDFPage>();
    g.indices.forEach((idx, i) => copiedByIndex.set(idx, copied[i]));
    const contribution: FormContribution = { source: doc, copiedPages: [] };
    contributions.push(contribution);
    sources.set(key, { doc, copiedByIndex, contribution });
  }
  const stampImages = await embedStampImages(output, pages);
  const used = new Set<PDFPage>();
  // Which source page landed at which output page — the reference-identity
  // channel every catalog/struct remap depends on (catalog-carry.ts).
  const pairsByKey = new Map<string, { srcIndex: number; outPage: PDFPage }[]>();
  for (const page of pages) {
    const src = sources.get(page.sourceKey)!;
    let copied = src.copiedByIndex.get(page.pageIndex);
    if (!copied || used.has(copied)) {
      // Defensive only: no workspace op can put the same source page into the
      // output twice today. If one ever does, the duplicate gets its own copy
      // rather than one page object being mutated through two ExportPages.
      [copied] = await output.copyPages(src.doc, [page.pageIndex]);
    }
    used.add(copied);
    applyPageExtras(copied, page, output, stampImages);
    output.addPage(copied);
    src.contribution.copiedPages.push(copied);
    let pairs = pairsByKey.get(page.sourceKey);
    if (!pairs) {
      pairs = [];
      pairsByKey.set(page.sourceKey, pairs);
    }
    pairs.push({ srcIndex: page.pageIndex, outPage: copied });
  }
  carryAcroForm(output, contributions);
  // The structure tree (P19): EVERY source contributes its surviving tags —
  // a donor page's MCIDs arrive in its copied stream, so its subtree must
  // come along (the AcroForm precedent). Also sweeps the stale
  // /StructParents keys page copies drag in, tagged or not.
  const carriedSources: CarriedSourcePages[] = [...sources.entries()].map(([key, s]) => ({
    doc: s.doc,
    pairs: pairsByKey.get(key) ?? [],
  }));
  carryStructTree(output, carriedSources);
  // Document-level catalog state (/Lang, /ViewerPreferences, /Outlines,
  // /PageLabels, /OCProperties) carries from the OWN source only — a page
  // inserted from a donor must not import the donor document's bookmarks or
  // layer config (the embedded-files rule).
  if (ownSourceKey) {
    const own = sources.get(ownSourceKey);
    const ownPairs = pairsByKey.get(ownSourceKey);
    if (own && ownPairs && ownPairs.length > 0) {
      carryDocumentCatalog(output, { doc: own.doc, pairs: ownPairs });
    }
  }
}

export async function buildPdf(
  pages: ExportPage[],
  ownBytes?: Uint8Array,
  ownSourceKey?: string,
): Promise<Uint8Array> {
  // A zero-page PDF is invalid; pdf-lib would happily save one. buildPdfx
  // skips empty documents for the same reason.
  if (pages.length === 0) throw new Error('buildPdf: cannot build a PDF with no pages');
  const output = await PDFDocument.create();
  await assemblePages(output, pages, ownSourceKey);
  // Document-level catalog trees (/Names /EmbeddedFiles, /Collection) are not
  // page subtrees — without this carry a committed page edit deleted every
  // attachment (embedded-files-carry.ts).
  if (ownBytes) await carryEmbeddedFiles(output, ownBytes);
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  return output.save();
}

export async function buildPdfx(
  documents: ExportDocument[],
  title: string,
  ownBytes?: Uint8Array,
  ownSourceKey?: string,
): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] };

  const nonEmpty = documents.filter((doc) => doc.pages.length > 0);
  await assemblePages(output, nonEmpty.flatMap((doc) => doc.pages), ownSourceKey);
  // Carry BEFORE the manifest attach: pdf-lib's save-time embed appends to an
  // existing tree, so the manifest and carried members coexist (pinned by
  // embedded-files-carry.test.ts's pdfx leg).
  if (ownBytes) await carryEmbeddedFiles(output, ownBytes);
  for (const doc of nonEmpty) {
    manifest.documents.push({ name: doc.name, pages: doc.pages.length });
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    description: 'PDFX manifest describing the documents in this collection',
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  output.setTitle(title);
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  output.setKeywords(['PDFX']);

  return output.save();
}
