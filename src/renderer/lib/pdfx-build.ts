import { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFObject, PDFObjectCopier, PDFPage, PDFRef, PDFStream, PDFString, degrees } from 'pdf-lib';

import { tChrome } from '../i18n';
import { MANIFEST_NAME, PDFX_VERSION } from './pdfx-format';
import type { ExportAnnotation, ExportDocument, ExportPage, PdfxManifest } from './pdfx-format';
import { carryAcroForm, prepareSourceForms, sourceHasXfa } from './acroform-carry';
import type { FormContribution } from './acroform-carry';
import { stampAppearanceIsCarried } from './carried-stamp';
import { completeAnnotationDefaultResources, defaultAppearanceString } from './annotation-default-resources';
import { carryEmbeddedFiles } from './embedded-files-carry';
import type { CarrySource } from './embedded-files-carry';
import { actionSettler, annotationTargetLoss, anyLoss, bindEmbeddedTargets, carryDocumentCatalog, carryThreads, embeddedTargetLoss, goToLoss, namedDestinationResolver, newActionSettlement, settleActionEntry, unbindEmbeddedTargets } from './catalog-carry';
import { carryOptionalContent } from './optional-content-carry';
import { carryDocumentMetadata } from './metadata-carry';
import { copyOutputIntents } from './output-intents-carry';
import { carryFormatDeclarations, saveWithFormatDeclarations } from './format-declarations';
import { flushAndDropUnreachable, reachableDictionaries, reachableTags } from './pdf-reachability';
import type { MetadataOverrides } from './metadata-process';
import type { ActionSettlement, CarriedSourcePages } from './catalog-carry';
import { carryStructTree } from './struct-carry';
import { cloudBumps } from './annotation-manipulation';
import { inheritNameReadings, nameReading, normalizeEscapedNames } from './pdf-name-normalize';
import { decodePdfTextString, pdfNameText, pdfStringCodes } from './pdf-text-string';
import { annotationDictionaryIsAmbiguous, contentsHolder, entryOf, importedRect, rawEntry } from './annotation-fingerprint';
import {
  LEGEND_FONT_SIZE,
  LEGEND_PAD,
  LEGEND_ROW_H,
  LEGEND_SYMBOL_W,
  legendLayout,
  partsToJson,
  symbolById,
} from './count-marks';
import type { SymbolPart } from './count-marks';

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

const displaySize = (
  box: { width: number; height: number },
  rotation: number,
): { width: number; height: number } =>
  ((rotation % 180) + 180) % 180 === 90 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };

// The display box of an annotation with the NoRotate flag (ISO 32000-2
// 12.5.3, Table 167 and the text after it): the upper-left corner of /Rect in
// default user space stays where the page rotation puts it, and the
// annotation stands upright from that point with the width and height of
// /Rect. /Rect itself is not changed by a page rotation.
export function pdfRectToUprightDisplay(
  rect: [number, number, number, number],
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = rect;
  const [x, y] = pdfPointToDisplay(x0, y1, box, rotation);
  const shown = displaySize(box, rotation);
  return { x, y, w: (x1 - x0) / shown.width, h: (y1 - y0) / shown.height };
}

// Inverse of pdfRectToUprightDisplay.
export function uprightDisplayToPdfRect(
  a: { x: number; y: number; w: number; h: number },
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
): [number, number, number, number] {
  const [left, top] = displayPointToPdf(a.x, a.y, box, rotation);
  const shown = displaySize(box, rotation);
  return [left, top - a.h * shown.height, left + a.w * shown.width, top];
}

// A count symbol's unit-square parts as PDF path operators.
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

/** A stamp's vector geometry, or null when it is a text/image stamp. The
 * carried snapshot is the authority; a bare id falls back to the
 * registry's built-ins, which is all this pure module can see. */
function symbolPartsOf(a: ExportAnnotation): readonly SymbolPart[] | null {
  if (a.symbolParts && a.symbolParts.length > 0) return a.symbolParts;
  if (!a.symbolId) return null;
  const built = symbolById(a.symbolId);
  return built.id === a.symbolId ? built.parts : null;
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

// The cloud border's scalloped path as PDF operators — the bump
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
// subtype strip: an original we can't positively fingerprint
// against something we're re-authoring is left alone, so a matching miss can
// only ever produce a visible duplicate, never silent data loss.
function stripImportedOriginals(
  copied: import('pdf-lib').PDFPage,
  annotations: ExportAnnotation[],
  removedImportedOriginals: NonNullable<ExportAnnotation['importedOriginal']>[],
  untouched: ReadonlySet<PDFDict>,
  removals: RemovedAnnotations,
): StrippedOriginals {
  const layerGates = new Map<ExportAnnotation, PDFObject>();
  const nameContents = new Map<ExportAnnotation, string>();
  const references = new Map<ExportAnnotation, PDFRef>();
  const dictionaries = new Map<ExportAnnotation, PDFDict>();
  const stripped = { layerGates, nameContents, references, dictionaries };
  // Two sources of fingerprints to strip-on-match: annotations being
  // re-appended (live, possibly edited) and ones the user REMOVED (tombstones
  // — matched and stripped same as any other, just never re-appended after).
  // Without the latter, deleting an imported annotation would be a no-op:
  // its fingerprint vanishes with it, nothing left to match the real PDF
  // object against, and the "original" reappears on reindex after commit.
  const originals = annotations.flatMap(annotation => annotation.importedOriginal
    ? [{ fingerprint: annotation.importedOriginal, annotation: annotation as ExportAnnotation | undefined }] : []);
  originals.push(...removedImportedOriginals.map(fingerprint => ({ fingerprint, annotation: undefined })));
  const fingerprints = originals.map(original => original.fingerprint);
  if (fingerprints.length === 0) return stripped;
  const annots = copied.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return stripped;
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
    // Never imported, so never a strip candidate, even when a fingerprint of
    // another annotation happens to fit it.
    if (untouched.has(dict) || annotationDictionaryIsAmbiguous(dict)) continue;
    // Typed lookups throw on a value of the wrong type. A key whose value
    // breaks Table 166's typing (ISO 32000-2 12.5.2) reads as absent here,
    // which is how the importer's pdf.js reading sees it too, so both sides
    // fingerprint alike. A strict read fails the whole commit over one
    // malformed annotation.
    const subtypeObj = entryOf(dict, 'Subtype');
    const subtype = subtypeObj instanceof PDFName ? nameReading(subtypeObj, dict.context) : undefined;
    const STRIPPABLE = new Set([
      'Square', 'FreeText', 'Ink', 'Stamp', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text',
      // The imported drawing shapes re-append like everything else.
      'Circle', 'Line', 'Polygon', 'PolyLine',
    ]);
    if (!subtype || !STRIPPABLE.has(subtype)) continue;
    // The rectangle the importer was given for this annotation, which is not
    // always the file's /Rect: an unreadable /Rect and an annotation with no
    // appearance both read differently.
    // A box kind seen only at the [0 0 0 0] fallback is never imported, so no
    // fingerprint names it; markups and ink import from their own geometry
    // and do match at that rectangle.
    const rect = importedRect(dict, subtype);
    const holder = contentsHolder(dict);
    const contentsObj = entryOf(holder, 'Contents');
    const contents = contentsObj instanceof PDFString || contentsObj instanceof PDFHexString
      ? decodePdfTextString(pdfStringCodes(contentsObj)) : undefined;
    const matchIndex = fingerprints.findIndex(
      (fp, idx) =>
        !consumed.has(idx) &&
        fp.subtype === subtype &&
        (fp.contents ?? '') === (contents ?? '') &&
        // A /Text note without an appearance is reported at a fixed icon
        // size; /Text matches on subtype and contents alone.
        (subtype === 'Text' || fp.rect.every((v, k) => Math.abs(v - rect[k]) <= 0.5)),
    );
    if (matchIndex === -1) continue; // no positive match — never guess-remove
    consumed.add(matchIndex);
    const annotation = originals[matchIndex].annotation;
    const layer = rawEntry(dict, 'OC');
    // Geometry and appearance are reauthored; layer membership is not.
    // Its reference is already in the output context and configured by the
    // optional-content carry, so the replacement uses that exact identity.
    // `/OC null` is no layer: the replacement carries no /OC at all.
    if (annotation && layer !== undefined && layer !== PDFNull) layerGates.set(annotation, layer);
    // Only the annotation's own name-typed /Contents is carried: a group
    // reply's parent keeps its own value.
    if (annotation && holder === dict && contentsObj instanceof PDFName) nameContents.set(annotation, pdfNameText(contentsObj));
    if (annotation) dictionaries.set(annotation, dict);
    const reference = annots.get(i);
    if (reference instanceof PDFRef) {
      removals.replaced.set(reference.tag, null);
      removals.references.push(reference);
      if (annotation) references.set(annotation, reference);
      const popup = dict.get(PDFName.of('Popup'));
      if (popup instanceof PDFRef) removals.popups.set(popup.tag, reference.tag);
    }
    removals.count++;
    annots.remove(i);
  }
  return stripped;
}

interface StrippedOriginals {
  /** The matched original's /OC, which its replacement carries. */
  layerGates: Map<ExportAnnotation, PDFObject>;
  /** The matched original's /Contents when the file wrote it as a name. The
   *  importer reads that value as no text, so it is carried only into a
   *  replacement whose note is empty. */
  nameContents: Map<ExportAnnotation, string>;
  /** The matched original's reference, which its replacement stands in for. */
  references: Map<ExportAnnotation, PDFRef>;
  /** The matched original's dictionary. */
  dictionaries: Map<ExportAnnotation, PDFDict>;
}

/** The originals one build took out of the pages' /Annots. */
interface RemovedAnnotations {
  /** Removed original's tag → the annotation authored in its place, or null
   *  when the user deleted it. */
  replaced: Map<string, PDFRef | null>;
  references: PDFRef[];
  /** How many entries left an /Annots array, direct dictionaries included. */
  count: number;
  /** The tag of the /Popup a removed original names → that original's tag. */
  popups: Map<string, string>;
}

/** The stroke width every dimension annotation is drawn at. */
const MEASURE_STROKE_WIDTH = 2;

/**
 * How far a stroked path's rect/BBox must sit outside the path's own point
 * bounds. A round cap and a round join (`1 J 1 j`) both reach exactly half the
 * stroke width past the geometry, so the half-width is the true extent and the
 * extra point is float-rounding slack. The 2pt default nib yields exactly 2 —
 * the value ink and measure output were pinned at.
 */
function strokeBboxPad(strokeWidth: number): number {
  return Math.max(2, strokeWidth / 2 + 1);
}

function addAnnotations(
  output: PDFDocument,
  copied: import('pdf-lib').PDFPage,
  annotations: ExportAnnotation[],
  removedImportedOriginals: NonNullable<ExportAnnotation['importedOriginal']>[],
  stampImages: Map<string, import('pdf-lib').PDFImage>,
  signatureFonts: Map<string, import('pdf-lib').PDFFont>,
  untouched: ReadonlySet<PDFDict>,
  removals: RemovedAnnotations,
  writtenDefaults: Set<PDFDict>,
): void {
  const { layerGates, nameContents, references, dictionaries } = stripImportedOriginals(copied, annotations, removedImportedOriginals, untouched, removals);
  const context = output.context;
  // CropBox (defaults to MediaBox when absent, so byte-identical for the
  // common case) — must match what annotation-import.ts reads via pdf.js's
  // page.view (the crop-intersected box), or an imported annotation's
  // position drifts by the crop offset the moment it's edited and re-baked.
  const { x, y, width, height } = copied.getCropBox();
  const rotation = ((copied.getRotation().angle % 360) + 360) % 360;
  for (const authored of annotations) {
    // A name-typed /Contents carried from the original is the note: the
    // appearance of a text-bearing kind is drawn from it as well as /Contents.
    const carried = nameContents.get(authored);
    const a = carried !== undefined && !authored.note ? { ...authored, note: carried } : authored;
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
    // CLIPS to BBox, and that's a knife-edge float-rounding risk at pad ==
    // half-width). The pad therefore has to scale with the NIB: a 14pt
    // highlighter reaches 7pt past its centreline in every direction, round
    // caps included, so a fixed 2 shaved 5pt off every outer edge and left 4pt
    // of a 14pt marker in the file. Shapes pad enough to cover arrowheads and
    // cloud bumps at any stroke width. Box shapes draw inset instead.
    const pad =
      a.kind === 'ink' || a.kind === 'measure'
        ? strokeBboxPad(a.kind === 'measure' ? MEASURE_STROKE_WIDTH : (a.strokeWidth ?? 2))
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
      // A /DA is a text string whose CONTENT is content-stream syntax, so it is
      // written as a LITERAL string. A UTF-16BE hex string encodes it
      // with a BOM, and a parser then reads NUL bytes between every digit —
      // pdf.js reports `parseDefaultAppearance ... Invalid number: (charCode
      // 0)` and falls back to its own default appearance, so a viewer that
      // regenerates the appearance draws the note in a colour and size this
      // file never asked for.
      annot.set(PDFName.of('DA'), PDFString.of(`${r} ${g} ${b} rg /Helv ${FREETEXT_FONT_SIZE} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    } else if (a.kind === 'ink') {
      // The shared style edit reaches ink too: width + opacity (unset: width
      // 2, opaque).
      // One /InkList entry AND one AP sub-path per stroke — a signature
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
      // The FREEHAND HIGHLIGHTER is ink drawn with a marker: the same
      // /InkList, stroked through an ExtGState that both multiplies and sets
      // the alpha. /Multiply is what makes it read as marker over a scanned
      // page IMAGE — a plain alpha wash lightens the ink underneath it, while
      // a multiply darkens toward the page and leaves the scan legible. The
      // blend mode belongs to a graphics state, so it is set in the
      // appearance's own resources rather than asserted on the annotation.
      const highlighter = a.inkStyle === 'highlighter';
      const alpha = a.opacity ?? 1;
      let apResources: { ExtGState: { GS0: import('pdf-lib').PDFRef } } | undefined;
      let content = '';
      if (highlighter) {
        const gsRef = context.register(
          context.obj({ Type: 'ExtGState', BM: 'Multiply', CA: alpha, ca: alpha }),
        );
        apResources = { ExtGState: { GS0: gsRef } };
        content += '/GS0 gs ';
      }
      content += `${r} ${g} ${b} RG ${strokeW} w 1 J 1 j `;
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
          ...(apResources ? { Resources: apResources } : {}),
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
      // Which PEN drew it, for the round trip. The appearance already carries
      // the LOOK; a reader that has never heard of this key still sees the
      // marker. Re-opening in this app reads the key back so the drawing
      // re-edits as the highlighter it was drawn with (the /SpectraSymbol
      // precedent — a private key naming intent, never the rendering).
      if (highlighter) {
        annot.set(PDFName.of('SpectraInkStyle'), PDFHexString.fromText('highlighter'));
      }
      if (a.opacity !== undefined && a.opacity < 1) annot.set(PDFName.of('CA'), context.obj(a.opacity));
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    } else if (a.kind === 'measure') {
      // A dimension annotation uses /Line, /PolyLine, or /Polygon
      // //Polygon with /IT + /Measure, so other tools can RE-MEASURE it —
      // the value in /Contents is a convenience, the geometry + /Measure /C
      // factors are the contract. The AP mirrors ink's stroke look.
      const strokeW = MEASURE_STROKE_WIDTH;
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
      // A drawing shape commits as its REAL subtype with a faithful
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
      // Closed uses a filled triangle; its interior uses the fill color or,
      // when absent, the stroke color.
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
      // A callout is /FreeText + /IT /FreeTextCallout + /CL. The whole appearance
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
      // A /DA is a text string whose CONTENT is content-stream syntax, so it is
      // written as a LITERAL string. A UTF-16BE hex string encodes it
      // with a BOM, and a parser then reads NUL bytes between every digit —
      // pdf.js reports `parseDefaultAppearance ... Invalid number: (charCode
      // 0)` and falls back to its own default appearance, so a viewer that
      // regenerates the appearance draws the note in a colour and size this
      // file never asked for.
      annot.set(PDFName.of('DA'), PDFString.of(`${r} ${g} ${b} rg /Helv ${FREETEXT_FONT_SIZE} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    } else if (a.kind === 'count') {
      // A TAKEOFF COUNT MARK — a real /Stamp, so it survives save/reload as an
      // annotation and degrades honestly (any viewer shows a printable symbol
      // with a subject and a "<group> <seq>" contents). The private keys ride
      // beside it on the /SpectraMask precedent:
      //
      //   /IT /Count           the intent. §12.5.6.10 requires a conforming
      //                        reader to IGNORE an intent it doesn't know, so
      //                        an unrecognized /IT on a /Stamp is safe by the
      //                        spec's own rule rather than by convention.
      //   /Subj                the group NAME — user data, verbatim.
      //   /Contents            "<group> <seq>".
      //   /NM                  the stable mark id.
      //   /SpectraSymbol       which vector symbol the marker draws.
      // The mark's OWN carried geometry wins over the registry lookup: a group
      // whose marker came from an imported set must draw the same on a machine
      // that never imported that set.
      const symbol = symbolById(a.countSymbol);
      const parts = a.symbolParts ?? symbol.parts;
      const strokeW = 1.5;
      const gsRef = context.register(context.obj({ Type: 'ExtGState', ca: 0.18 }));
      // The path is emitted ONCE and painted twice (translucent fill, then the
      // opaque outline) — `B` would apply the alpha to both.
      const ops = symbolOps(parts, dispW, dispH);
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
      annot.set(PDFName.of('SpectraSymbol'), PDFName.of(a.countSymbol || symbol.id));
      // Only a NON-built-in marker needs its geometry written: every build has
      // the built-in ones, and a snapshot per mark on a 400-mark sheet would be
      // 400 copies of a shape the id already names.
      if (a.symbolParts) {
        annot.set(
          PDFName.of('SpectraSymbolParts'),
          PDFHexString.fromText(partsToJson(a.symbolParts)),
        );
      }
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
      annot.set(PDFName.of('DA'), defaultAppearanceString(`0.1 0.1 0.1 rg /Helv ${fs} Tf`));
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note ?? ''));
      annot.set(
        PDFName.of('SpectraLegend'),
        PDFHexString.fromText(
          JSON.stringify({ title, totalWord, rows }),
        ),
      );
    } else if (a.kind === 'stamp' && symbolPartsOf(a)) {
      // A SYMBOL STAMP — the stamp library's third species. It
      // commits as an ordinary /Stamp whose appearance is the symbol's own
      // path operators, so it prints crisply at any scale and degrades in any
      // other viewer to exactly the drawing that was placed.
      //
      //   /SpectraSymbol       which registry symbol it is.
      //   /SpectraSymbolParts  its geometry, carried with it — the id alone
      //                        would resolve to the DEFAULT marker on a
      //                        machine that never imported the set, which
      //                        would silently redraw someone's drawing.
      const parts = symbolPartsOf(a)!;
      const strokeW = 1.5;
      const ops = symbolOps(parts, dispW, dispH);
      const ap = context.register(
        context.stream(`${r} ${g} ${b} RG ${strokeW} w 1 J 1 j ${ops}S`, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, dispW, dispH],
          Matrix: apMatrixFor(rotation),
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
      if (a.symbolId) annot.set(PDFName.of('SpectraSymbol'), PDFName.of(a.symbolId));
      annot.set(PDFName.of('SpectraSymbolParts'), PDFHexString.fromText(partsToJson(parts)));
    } else if (a.kind === 'stamp' && a.signatureFont) {
      // A TYPED personal signature: the name set in an app-bundled script
      // face, with NO border and NO fill — a signature is a mark on the page,
      // not a labelled box. The face's SUBSET is embedded (see
      // embedSignatureFonts), so the mark renders on a machine that has never
      // had the face; a signature that silently reset to Helvetica somewhere
      // else would be the wrong mark, not a degraded one.
      const embedded = signatureFonts.get(a.signatureFont);
      if (!embedded) throw new Error(`signature face not embedded: ${a.signatureFont}`);
      const text = a.note ?? '';
      // Fit the name to the box on the face's OWN metrics, uniformly: a
      // signature stretched to fill a rect is a different hand.
      const wAt100 = embedded.widthOfTextAtSize(text, 100);
      const hAt100 = embedded.heightAtSize(100);
      const size = Math.max(
        1,
        Math.min(wAt100 > 0 ? (dispW * 100) / wAt100 : dispH, (dispH * 100) / hAt100),
      );
      const textW = embedded.widthOfTextAtSize(text, size);
      const boxH = embedded.heightAtSize(size);
      // The baseline sits one descender above the glyph box's bottom edge,
      // taken from the face rather than guessed as a fraction.
      const descent = boxH - embedded.heightAtSize(size, { descender: false });
      const tx = (dispW - textW) / 2;
      const ty = (dispH - boxH) / 2 + descent;
      const ap = context.register(
        context.stream(
          `BT /F0 ${size} Tf ${r} ${g} ${b} rg ${tx} ${ty} Td ` +
            `${embedded.encodeText(text).toString()} Tj ET`,
          {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: [0, 0, dispW, dispH],
            Matrix: apMatrixFor(rotation),
            Resources: { Font: { F0: embedded.ref } },
          },
        ),
      );
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        AP: { N: ap },
      });
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(text));
      // The face travels by name: the import reads it back, so the next commit
      // draws the signature in its face again.
      annot.set(PDFName.of('SpectraSignatureFont'), PDFName.of(a.signatureFont));
    } else if (a.kind === 'stamp' && a.imageData && stampImages.get(a.imageData)) {
      // A custom image stamp draws the pre-embedded raster without a border or
      // fill. /Contents keeps the display name.
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
    } else if (a.kind === 'stamp' && a.importedOriginal && stampAppearanceIsCarried(dictionaries.get(authored))) {
      // The import holds no drawing for this stamp, so its appearance is the
      // original's: every entry of the original travels, and only what the
      // user changed is written. A viewer maps the appearance box onto /Rect
      // (ISO 32000-2 12.5.5), so a move or a resize needs /Rect alone. An
      // unmoved stamp keeps /Rect as written.
      // The box of a NoRotate original is its upright box, so a page rotation
      // alone gives back the rectangle as written.
      const original = a.importedOriginal;
      annot = dictionaries.get(authored)!.clone(context);
      const placed = a.noRotate ? uprightDisplayToPdfRect(a, { x, y, width, height }, rotation) : [rx0, ry0, rx1, ry1];
      if (placed.some((v, k) => Math.abs(v - original.rect[k]) > 0.01)) {
        annot.set(PDFName.of('Rect'), context.obj(placed));
      }
      if ((authored.note ?? '') !== (original.contents ?? '')) {
        annot.set(PDFName.of('Contents'), PDFHexString.fromText(authored.note ?? ''));
      }
      if (original.color !== undefined && a.color !== original.color) annot.set(PDFName.of('C'), context.obj([r, g, b]));
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
      // Native text markup — round-trips as the real /Highlight, /Underline,
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
        // /QuadPoints in the widely supported order: UL, UR, LL, LR.
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
      // An app-authored box highlight is a /Highlight carrying its box as one
      // /QuadPoints quad — the subtype the reader, the by-type summary and
      // every other tool then report. Writing it as a /Square typed it as a
      // rectangle the moment it round-tripped through the file. A /Square
      // that ARRIVED as a /Square keeps its subtype: an imported foreign
      // annotation is re-authored, never converted.
      const carriedSquare = a.importedOriginal?.subtype === 'Square';
      annot = context.obj({
        Type: 'Annot',
        Subtype: carriedSquare ? 'Square' : 'Highlight',
        Rect: [x0, y0, x1, y1],
        // UL, UR, LL, LR — the order text-markup readers expect.
        ...(carriedSquare ? {} : { QuadPoints: [x0, y1, x1, y1, x0, y0, x1, y0] }),
        C: [r, g, b],
        // /IC is interior colour for a /Square; a /Highlight has no interior.
        ...(carriedSquare ? { IC: [r, g, b] } : {}),
        CA: HIGHLIGHT_ALPHA,
        F: 4, // print
        AP: { N: ap },
      });
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
    }
    const layer = layerGates.get(authored);
    if (layer !== undefined) annot.set(PDFName.of('OC'), layer);
    // A /DA written here names this builder's own font.
    if (annot.has(PDFName.of('DA'))) writtenDefaults.add(annot);
    const ref = context.register(annot);
    const original = references.get(authored);
    if (original) removals.replaced.set(original.tag, ref);
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
  signatureFonts: Map<string, import('pdf-lib').PDFFont>,
  untouched: ReadonlySet<PDFDict>,
  removals: RemovedAnnotations,
  writtenDefaults: Set<PDFDict>,
): void {
  applyRotation(copied, page);
  // Must still run when `annotations` is empty but removedImportedOriginals
  // isn't — e.g. the user deleted the only imported annotation on this page,
  // leaving nothing to re-append but still needing the original stripped.
  if (page.annotations?.length || page.removedImportedOriginals?.length) {
    addAnnotations(
      output,
      copied,
      page.annotations ?? [],
      page.removedImportedOriginals ?? [],
      stampImages,
      signatureFonts,
      untouched,
      removals,
      writtenDefaults,
    );
  }
}

/**
 * Pre-embed every distinct script face a TYPED signature on these pages is set
 * in (the per-page annotation emit is synchronous; pdf-lib's embed is not).
 *
 * Unlike the stamp-image prefetch this REFUSES on failure rather than falling
 * back: an image stamp that cannot embed still has a bordered label to draw,
 * whereas a signature drawn in a face the user did not choose is somebody
 * else's mark. The faces ship in the app's own resource tree, so a failure
 * here is a broken installation and is named as one.
 *
 * The fontkit registration and the module read are BOTH lazy — a document
 * with no typed signature must embed nothing, load nothing, and produce the
 * same bytes it did before this existed.
 */
async function embedSignatureFonts(
  output: PDFDocument,
  pages: ExportPage[],
): Promise<Map<string, import('pdf-lib').PDFFont>> {
  const map = new Map<string, import('pdf-lib').PDFFont>();
  const wanted = new Set<string>();
  for (const page of pages) {
    for (const a of page.annotations ?? []) {
      if (a.kind === 'stamp' && a.signatureFont) wanted.add(a.signatureFont);
    }
  }
  if (wanted.size === 0) return map;
  const [{ default: fontkit }, fonts] = await Promise.all([
    import('@pdf-lib/fontkit'),
    import('./signature-fonts'),
  ]);
  output.registerFontkit(fontkit);
  for (const id of wanted) {
    const face = fonts.signatureFaceById(id);
    if (!face) throw new Error(`unknown signature face: ${id}`);
    const bytes = await fonts.loadSignatureFontBytes(face.id);
    map.set(id, await output.embedFont(bytes, { subset: true, customName: face.baseFontName }));
  }
  return map;
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

// ISO 32000-2 12.5.6.2: these entries of a group's primary annotation apply
// to the whole group, and a subordinate's own are ignored. /Popup is not
// among them here: a popup belongs to the page that lists it.
const GROUP_ATTRIBUTES = ['Contents', 'RC', 'DS', 'M', 'C', 'T', 'CreationDate', 'Subj', 'Open'];

// A group reply about to lose its link to the primary takes the primary's
// group attributes as its own entries, so every reader finds on the reply
// what the group showed. The import fingerprint holds the primary's
// /Contents; the strip reads the reply after the link is gone and must find
// the same value there. A primary /Contents that is not a string reads as no
// text in the group and is not taken. A reply that is ambiguous by its own
// keys or its primary's is left as written: the value a viewer showed for it
// cannot be read from the parsed dictionaries.
function adoptGroupAttributes(reply: PDFDict): void {
  const primary = contentsHolder(reply);
  if (primary === reply || annotationDictionaryIsAmbiguous(reply)) return;
  for (const name of GROUP_ATTRIBUTES) {
    for (const key of reply.keys()) if (nameReading(key, reply.context) === name) reply.delete(key);
    const value = entryOf(primary, name);
    if (value === undefined) continue;
    if (name === 'Contents' && !(value instanceof PDFString || value instanceof PDFHexString)) continue;
    reply.set(PDFName.of(name), rawEntry(primary, name)!);
  }
}

// copyPages follows an explicit /Dest or GoTo chain into its target page and
// writes that page into the output even when the build dropped it, as a page
// object outside the page tree. An action that names an annotation of a
// removed page pulls that annotation and, through its /P, the page. On the
// loaded source copy, before copying, a link's /Dest, an annotation's /A, and
// each page, annotation or field /AA trigger that jumps to a removed page or
// names an annotation of one leaves its chain (actionSettler). A named
// destination pulls no page object and stays as written.
function dropJumpsToRemovedPages(doc: PDFDocument, keptIndices: number[], settlement: ActionSettlement): void {
  const pages = doc.getPages();
  const all = new Set(pages.map(page => page.ref.tag));
  const kept = new Set(keptIndices.flatMap(index => pages[index] ? [pages[index].ref.tag] : []));
  const removed = (destination: PDFObject): boolean => {
    const value = doc.context.lookup(destination);
    const target = value instanceof PDFArray && value.size() > 0 ? value.get(0) : undefined;
    return target instanceof PDFRef && all.has(target.tag) && !kept.has(target.tag);
  };
  const removedAnnots = new Set<string>();
  pages.forEach(page => {
    if (kept.has(page.ref.tag)) return;
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) for (const raw of annots.asArray()) if (raw instanceof PDFRef) removedAnnots.add(raw.tag);
  });
  const onRemovedPage = (raw: PDFObject | undefined): boolean => {
    if (!(raw instanceof PDFRef)) return false;
    if (removedAnnots.has(raw.tag)) return true;
    const target = doc.context.lookup(raw), page = target instanceof PDFDict ? target.get(PDFName.of('P')) : undefined;
    return page instanceof PDFRef && all.has(page.tag) && !kept.has(page.tag);
  };
  // A copied page annotation names its destination in the SOURCE name tree,
  // which the output does not share (a donor's names can collide with the
  // owner's). Resolve names to explicit arrays before the copy so the page
  // reference is rebound, or dropped when its page is removed, like any other.
  const resolveName = namedDestinationResolver(doc);
  const explicitCopy = (raw: PDFObject | undefined) => {
    const dest = resolveName(raw);
    return dest ? doc.context.obj(dest.asArray()) : undefined;
  };
  const resolveActions = (raw: PDFObject | undefined) => {
    const seen = new Set<PDFDict>();
    const walk = (value: PDFObject | undefined, depth: number): void => {
      const action = doc.context.lookup(value);
      if (!(action instanceof PDFDict) || seen.has(action) || depth > 128) return;
      seen.add(action);
      if (action.lookup(PDFName.of('S')) === PDFName.of('GoTo')) {
        const dest = explicitCopy(action.get(PDFName.of('D')));
        if (dest) action.set(PDFName.of('D'), dest);
      }
      const next = doc.context.lookup(action.get(PDFName.of('Next')));
      if (next instanceof PDFArray) for (const child of next.asArray()) walk(child, depth + 1);
      else walk(action.get(PDFName.of('Next')), depth + 1);
    };
    walk(raw, 0);
  };
  const standing = (target: PDFRef) => onRemovedPage(target) ? undefined : target;
  const settle = actionSettler(doc.context, anyLoss(goToLoss(removed),
    annotationTargetLoss(doc.context, standing, settlement),
    embeddedTargetLoss(doc.context, page => !all.has(page.tag) || kept.has(page.tag), standing)), settlement);
  const dropTriggers = (owner: PDFDict) => {
    const triggers = doc.context.lookup(owner.get(PDFName.of('AA')));
    if (!(triggers instanceof PDFDict)) return;
    for (const [key] of triggers.entries()) settleActionEntry(triggers, key, settle);
  };
  // A widget's field ancestors hold triggers of their own.
  const fieldAncestors = new Set<PDFDict>();
  const dropFieldTriggers = (widget: PDFDict) => {
    let node = doc.context.lookup(widget.get(PDFName.of('Parent')));
    while (node instanceof PDFDict && !fieldAncestors.has(node)) {
      fieldAncestors.add(node);
      dropTriggers(node);
      node = doc.context.lookup(node.get(PDFName.of('Parent')));
    }
  };
  for (const index of new Set(keptIndices)) {
    if (!pages[index]) continue;
    const pageTriggers = doc.context.lookup(pages[index].node.get(PDFName.of('AA')));
    if (pageTriggers instanceof PDFDict) for (const [, action] of pageTriggers.entries()) resolveActions(action);
    dropTriggers(pages[index].node);
    const annots = doc.context.lookup(pages[index].node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const raw of annots.asArray()) {
      const annot = doc.context.lookup(raw);
      if (!(annot instanceof PDFDict)) continue;
      const named = annot.lookup(PDFName.of('Subtype')) === PDFName.of('Link') ? explicitCopy(annot.get(PDFName.of('Dest'))) : undefined;
      if (named) annot.set(PDFName.of('Dest'), named);
      resolveActions(annot.get(PDFName.of('A')));
      const triggers = doc.context.lookup(annot.get(PDFName.of('AA')));
      if (triggers instanceof PDFDict) for (const [, action] of triggers.entries()) resolveActions(action);
      const dest = annot.get(PDFName.of('Dest'));
      if (annot.lookup(PDFName.of('Subtype')) === PDFName.of('Link') && dest !== undefined && removed(dest)) annot.delete(PDFName.of('Dest'));
      settleActionEntry(annot, PDFName.of('A'), settle);
      dropTriggers(annot);
      if (annot.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) dropFieldTriggers(annot);
      if (onRemovedPage(annot.get(PDFName.of('Popup')))) annot.delete(PDFName.of('Popup'));
      if (onRemovedPage(annot.get(PDFName.of('IRT')))) {
        adoptGroupAttributes(annot);
        annot.delete(PDFName.of('IRT'));
        annot.delete(PDFName.of('RT'));
      }
      if (annot.lookup(PDFName.of('Subtype')) === PDFName.of('Popup') && onRemovedPage(annot.get(PDFName.of('Parent')))) annot.delete(PDFName.of('Parent'));
    }
  }
  // ISO 32000-2 12.4.3/Tables 159-160: beads form a circular /N-/V ring and
  // the thread's /F bead carries /T. Beads on removed pages leave the ring;
  // a thread left without beads is reachable from nothing and is not carried.
  const threads = new Map<string, PDFRef>();
  const catalogThreads = doc.context.lookup(doc.catalog.get(PDFName.of('Threads')));
  if (catalogThreads instanceof PDFArray) for (const raw of catalogThreads.asArray()) if (raw instanceof PDFRef) threads.set(raw.tag, raw);
  for (const index of new Set(keptIndices)) {
    const beads = pages[index] ? doc.context.lookup(pages[index].node.get(PDFName.of('B'))) : undefined;
    if (!(beads instanceof PDFArray)) continue;
    for (const raw of beads.asArray()) {
      const bead = doc.context.lookup(raw), thread = bead instanceof PDFDict ? bead.get(PDFName.of('T')) : undefined;
      if (thread instanceof PDFRef) threads.set(thread.tag, thread);
    }
  }
  for (const threadRef of threads.values()) {
    const thread = doc.context.lookup(threadRef);
    if (!(thread instanceof PDFDict)) continue;
    const ring: PDFRef[] = [], seen = new Set<string>();
    let cursor = thread.get(PDFName.of('F')), closed = false;
    while (cursor instanceof PDFRef && !seen.has(cursor.tag) && seen.size < 100000) {
      seen.add(cursor.tag);
      const bead = doc.context.lookup(cursor);
      if (!(bead instanceof PDFDict)) break;
      ring.push(cursor);
      cursor = bead.get(PDFName.of('N'));
      closed = cursor instanceof PDFRef && cursor.tag === ring[0].tag;
    }
    if (!closed) continue;
    const onKept = ring.filter(ref => {
      const page = doc.context.lookup(ref, PDFDict).get(PDFName.of('P'));
      return page instanceof PDFRef && kept.has(page.tag);
    });
    if (onKept.length === ring.length || onKept.length === 0) continue;
    onKept.forEach((ref, i) => {
      const bead = doc.context.lookup(ref, PDFDict);
      bead.set(PDFName.of('N'), onKept[(i + 1) % onKept.length]);
      bead.set(PDFName.of('V'), onKept[(i - 1 + onKept.length) % onKept.length]);
    });
    thread.set(PDFName.of('F'), onKept[0]);
    doc.context.lookup(onKept[0], PDFDict).set(PDFName.of('T'), threadRef);
  }
}

// After the pages' originals are removed and re-authored, no annotation of
// the output links to an annotation that no page lists. A reply's /IRT and a
// popup's /Parent that name a replaced original name its replacement, which
// takes the popup as its /Popup. A reply to an annotation no page lists (the
// user deleted it, or the link reached a copy outside every /Annots) stands
// alone: a group member first takes the primary's group attributes, then
// /IRT and /RT leave. The popup of a deleted original leaves its page; a
// popup whose parent no page lists otherwise loses /Parent.
function settleLinksToRemoved(output: PDFDocument, removals: RemovedAnnotations): void {
  const context = output.context;
  const IRT = PDFName.of('IRT'), PARENT = PDFName.of('Parent'), POPUP = PDFName.of('Popup');
  const listed = new Set<string>();
  const pageAnnots = output.getPages().map(page => context.lookup(page.node.get(PDFName.of('Annots'))));
  for (const annots of pageAnnots) {
    if (annots instanceof PDFArray) for (const raw of annots.asArray()) if (raw instanceof PDFRef) listed.add(raw.tag);
  }
  for (const annots of pageAnnots) {
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const raw = annots.get(i), dict = context.lookup(raw);
      if (!(dict instanceof PDFDict)) continue;
      const target = dict.get(IRT);
      if (target instanceof PDFRef) {
        const replacement = removals.replaced.get(target.tag);
        if (replacement) dict.set(IRT, replacement);
        else if (!listed.has(target.tag)) {
          adoptGroupAttributes(dict);
          dict.delete(IRT);
          dict.delete(PDFName.of('RT'));
        }
      }
      if (dict.lookup(PDFName.of('Subtype')) !== POPUP) continue;
      const parent = dict.get(PARENT);
      const original = parent instanceof PDFRef && removals.replaced.has(parent.tag) ? parent.tag
        : raw instanceof PDFRef ? removals.popups.get(raw.tag) : undefined;
      if (original !== undefined) {
        const replacement = removals.replaced.get(original);
        const holder = replacement ? context.lookup(replacement) : undefined;
        if (replacement && holder instanceof PDFDict && raw instanceof PDFRef) {
          dict.set(PARENT, replacement);
          holder.set(POPUP, raw);
        } else annots.remove(i);
      } else if (parent instanceof PDFRef && !listed.has(parent.tag)) dict.delete(PARENT);
    }
  }
}

// An action of the output that names a removed original by reference (a
// link's /A, a trigger under any /AA) names its replacement. With no
// replacement the action leaves its chain, as a jump to a removed page does
// (actionSettler). The owners are found by a walk of everything the catalog
// reaches, so no owner kind is listed here. A bound embedded go-to target
// follows the same rule, and is also lost when no page of the output lists
// its annotation or its page is outside the page tree.
function settleActionsOnRemoved(output: PDFDocument, removals: RemovedAnnotations, settlement: ActionSettlement): void {
  const context = output.context;
  const standing = (target: PDFRef): PDFRef | undefined => {
    const replacement = removals.replaced.get(target.tag);
    return replacement === undefined ? target : replacement ?? undefined;
  };
  const tree = new Set(output.getPages().map(page => page.ref.tag));
  let listed: Set<string> | undefined;
  const listedStanding = (target: PDFRef): PDFRef | undefined => {
    if (!listed) {
      listed = new Set();
      for (const page of output.getPages()) {
        const annots = context.lookup(page.node.get(PDFName.of('Annots')));
        if (annots instanceof PDFArray) for (const raw of annots.asArray()) if (raw instanceof PDFRef) listed.add(raw.tag);
      }
    }
    const now = standing(target);
    return now && listed.has(now.tag) ? now : undefined;
  };
  const settle = actionSettler(context, anyLoss(annotationTargetLoss(context, standing, settlement),
    embeddedTargetLoss(context, page => tree.has(page.tag), listedStanding)), settlement);
  const A = PDFName.of('A'), AA = PDFName.of('AA'), S = PDFName.of('S');
  const isAction = (raw: PDFObject | undefined): boolean => {
    const value = context.lookup(raw);
    return value instanceof PDFDict && value.lookup(S) instanceof PDFName;
  };
  for (const owner of reachableDictionaries(context, [context.trailerInfo.Root])) {
    if (isAction(owner.get(A))) settleActionEntry(owner, A, settle);
    const triggers = context.lookup(owner.get(AA));
    if (!(triggers instanceof PDFDict)) continue;
    for (const [key, value] of triggers.entries()) if (isAction(value)) settleActionEntry(triggers, key, settle);
  }
}

// The copies under the removed originals that nothing else in the output
// reaches (an appearance stream, a popup taken off its page) are recorded as
// removed with no replacement, so a carry that maps source objects to their
// copies reads them as gone.
function recordRemovedSubtrees(output: PDFDocument, removals: RemovedAnnotations): void {
  const { Root, Info } = output.context.trailerInfo;
  const live = reachableTags(output.context, [Root, Info]);
  for (const tag of reachableTags(output.context, removals.references)) {
    if (!live.has(tag) && !removals.replaced.has(tag)) removals.replaced.set(tag, null);
  }
}

interface PagePlacement { doc: PDFDocument; srcIndex: number; outPage: PDFPage }

// copyPages registers a second clone of a page leaf whenever the copied graph
// references that page (an annotation /P, a link or action destination, a
// bead), so the reference names a leaf outside the page tree that no viewer
// can reach. A reference to a placed page re-binds to its FIRST placement in
// output order, found by walking each source page and its copy in parallel
// (copyPages preserves shape). Page references never live in content,
// resources, thumbnails or streams, so the walk skips them; it is iterative
// and visits each output object once, so page size cannot exhaust it. A
// detached leaf nothing references afterwards is deleted.
const NO_PAGE_REFERENCES = new Set(['Parent', 'Resources', 'Contents', 'Thumb'].map(key => PDFName.of(key)));
function bindDetachedPageCopies(output: PDFDocument, placements: PagePlacement[]): void {
  const TYPE = PDFName.of('Type'), PAGE = PDFName.of('Page');
  const tree = new Set(output.getPages().map(page => page.ref.tag));
  const detached = new Map<string, PDFRef>();
  for (const [ref, obj] of output.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.lookup(TYPE) === PAGE && !tree.has(ref.tag)) detached.set(ref.tag, ref);
  }
  if (detached.size === 0) return;
  const first = new Map<PDFDocument, Map<string, PDFRef>>();
  for (const { doc, srcIndex, outPage } of placements) {
    let byTag = first.get(doc);
    if (!byTag) { byTag = new Map(); first.set(doc, byTag); }
    const tag = doc.getPage(srcIndex).ref.tag;
    if (!byTag.has(tag)) byTag.set(tag, outPage.ref);
  }
  interface Step { doc: PDFDocument; src: PDFObject | undefined; out: PDFObject | undefined; rebind?: (ref: PDFRef) => void }
  const stack: Step[] = placements.map(({ doc, srcIndex, outPage }) => ({ doc, src: doc.getPage(srcIndex).node, out: outPage.node }));
  const seen = new Set<PDFObject>();
  for (let step = stack.pop(); step; step = stack.pop()) {
    const { doc, src, out, rebind } = step;
    if (src instanceof PDFRef) {
      if (!(out instanceof PDFRef)) continue;
      const target = doc.context.lookup(src);
      if (target instanceof PDFDict && target.lookup(TYPE) === PAGE) {
        const placed = detached.has(out.tag) ? first.get(doc)?.get(src.tag) : undefined;
        if (placed && rebind) rebind(placed);
        continue;
      }
      stack.push({ doc, src: target, out: output.context.lookup(out) });
      continue;
    }
    if (src === undefined || out === undefined || seen.has(out)) continue;
    seen.add(out);
    if (src instanceof PDFDict && out instanceof PDFDict) {
      for (const [key, value] of src.entries()) {
        if (!NO_PAGE_REFERENCES.has(key)) stack.push({ doc, src: value, out: out.get(key), rebind: ref => out.set(key, ref) });
      }
    } else if (src instanceof PDFArray && out instanceof PDFArray) {
      for (let i = 0; i < Math.min(src.size(), out.size()); i++) {
        stack.push({ doc, src: src.get(i), out: out.get(i), rebind: ref => out.set(i, ref) });
      }
    }
  }
  const referenced = new Set<string>();
  const scan = (obj: PDFObject): void => {
    if (obj instanceof PDFRef) { if (detached.has(obj.tag)) referenced.add(obj.tag); }
    else if (obj instanceof PDFDict) for (const [, value] of obj.entries()) scan(value);
    else if (obj instanceof PDFArray) for (const value of obj.asArray()) scan(value);
    else if (obj instanceof PDFStream) scan(obj.dict);
  };
  for (const [ref, obj] of output.context.enumerateIndirectObjects()) if (!detached.has(ref.tag)) scan(obj);
  for (const [tag, ref] of detached) if (!referenced.has(tag)) output.context.delete(ref);
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
  ownBytes?: Uint8Array,
  metadataOverrides: MetadataOverrides = {},
): Promise<void> {
  // Catalog defaults belong to the document; explicit page conditions belong
  // to that physical page. Cache per source/value so repeated page occurrences
  // share an already validated, byte-identical intent graph.
  const intentCopies = new Map<PDFDocument, Map<PDFObject | undefined, PDFArray | undefined>>();
  const carryIntents = (source: PDFDocument, sourceRoot: PDFDict, targetRoot: PDFDict) => {
    const raw = sourceRoot.get(PDFName.of('OutputIntents'));
    const value = raw === undefined ? undefined : source.context.lookup(raw);
    let copies = intentCopies.get(source);
    if (!copies) { copies = new Map(); intentCopies.set(source, copies); }
    if (!copies.has(value)) copies.set(value, copyOutputIntents(output, source, raw));
    const copied = copies.get(value);
    if (copied) targetRoot.set(PDFName.of('OutputIntents'), output.context.getObjectRef(copied) ?? copied);
    else targetRoot.delete(PDFName.of('OutputIntents'));
  };
  // One record of settled actions for the build: the pass before the copy,
  // the pass after the strip and the catalog carry read the same answers.
  const settlement = newActionSettlement();
  let boundTargets = 0;
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
    { doc: PDFDocument; bytes: Uint8Array; copier: PDFObjectCopier; copiedByIndex: Map<number, PDFPage>; contribution: FormContribution }
  >();
  const contributions: FormContribution[] = [];
  for (const [key, g] of groups) {
    // Every name is rewritten to the reading pdf.js and qpdf give the file's
    // own spelling. A signed document's incremental append pairs the rebuilt
    // pages with the original ones by that reading, so a key pdf-lib would
    // otherwise write back as `#23` keeps the pairing.
    const doc = await loadNormalized(g.bytes);
    boundTargets += bindEmbeddedTargets(doc);
    if (sourceHasXfa(doc)) {
      // Page surgery on an XFA form detaches the form from its pages
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
    dropJumpsToRemovedPages(doc, g.indices, settlement);
    // copyPages' own shape, with the copier kept: the catalog carries below
    // copy through the same cache, so an object reached from a page and the
    // catalog lands once.
    const copier = PDFObjectCopier.for(doc.context, output.context);
    const copied = g.indices.map(index => {
      const node = copier.copy(doc.getPage(index).node);
      return PDFPage.of(node, output.context.register(node), output);
    });
    const copiedByIndex = new Map<number, PDFPage>();
    g.indices.forEach((idx, i) => copiedByIndex.set(idx, copied[i]));
    const contribution: FormContribution = { source: doc, copiedPages: [] };
    contributions.push(contribution);
    sources.set(key, { doc, bytes: g.bytes, copier, copiedByIndex, contribution });
  }
  // The strip reads the copied annotations in the output's context.
  inheritNameReadings(output.context, [...sources.values()].map((s) => s.doc.context));
  const stampImages = await embedStampImages(output, pages);
  const signatureFonts = await embedSignatureFonts(output, pages);
  const used = new Set<PDFPage>();
  const pendingExtras: { copied: PDFPage; page: ExportPage; untouched: ReadonlySet<PDFDict>; pair: CarriedSourcePages['pairs'][number] }[] = [];
  const removals: RemovedAnnotations = { replaced: new Map(), references: [], popups: new Map(), count: 0 };
  // Which source page landed at which output page — the reference-identity
  // channel every catalog/struct remap depends on (catalog-carry.ts).
  const pairsByKey = new Map<string, { srcIndex: number; outPage: PDFPage }[]>();
  const placements: PagePlacement[] = [];
  for (const page of pages) {
    const src = sources.get(page.sourceKey)!;
    let copied = src.copiedByIndex.get(page.pageIndex);
    if (!copied || used.has(copied)) {
      // The same source page placed twice (a file imported into itself, a
      // merge of two partitions of one file) gets its own copy rather than
      // one page object being mutated through two ExportPages.
      [copied] = await output.copyPages(src.doc, [page.pageIndex]);
    }
    used.add(copied);
    carryIntents(src.doc, src.doc.getPage(page.pageIndex).node, copied.node);
    // The copied /Annots still holds the source's entries in their order,
    // so a position the importer left untouched names its copy here.
    const untouched = new Set<PDFDict>();
    const copiedAnnots = output.context.lookup(copied.node.get(PDFName.of('Annots')));
    const copyAt = (slot: number): PDFObject | undefined =>
      copiedAnnots instanceof PDFArray && slot < copiedAnnots.size() ? output.context.lookup(copiedAnnots.get(slot)) : undefined;
    for (const slot of page.untouchedAnnotationSlots ?? []) {
      const dict = copyAt(slot);
      if (dict instanceof PDFDict) untouched.add(dict);
    }
    // Whether a name is unresolved is a fact of the document that wrote it,
    // so each annotation is asked in its source, and the answer names its
    // copy by position. The output holds names of every source.
    const sourceAnnots = src.doc.context.lookup(src.doc.getPage(page.pageIndex).node.get(PDFName.of('Annots')));
    for (let slot = 0; sourceAnnots instanceof PDFArray && slot < sourceAnnots.size(); slot++) {
      const own = src.doc.context.lookup(sourceAnnots.get(slot));
      const dict = own instanceof PDFDict && annotationDictionaryIsAmbiguous(own) ? copyAt(slot) : undefined;
      if (dict instanceof PDFDict) untouched.add(dict);
    }
    // Layer identity is paired against the untouched copy. Adding/removing
    // an annotation or wrapping Contents first changes that graph's shape.
    const pair: CarriedSourcePages['pairs'][number] = { srcIndex: page.pageIndex, outPage: copied };
    pendingExtras.push({ copied, page, untouched, pair });
    output.addPage(copied);
    // copyPages clones the page leaf separately from its recursive object
    // cache. An annotation's /P can therefore name a second, detached copy
    // of that leaf. Bind existing backpointers to the page actually inserted;
    // otherwise even a comment/rotation makes incremental preservation refuse.
    // Leave optional, absent /P entries absent (no invented annotation delta).
    // An /Annots entry that names a missing object or null is the null
    // object (ISO 32000-2 7.3.10) and has no backpointer to rebind.
    for (const ref of copied.node.Annots()?.asArray() ?? []) {
      const annotation = output.context.lookup(ref);
      if (annotation instanceof PDFDict && annotation.has(PDFName.of('P'))) annotation.set(PDFName.of('P'), copied.ref);
    }
    src.contribution.copiedPages.push(copied);
    let pairs = pairsByKey.get(page.sourceKey);
    if (!pairs) {
      pairs = [];
      pairsByKey.set(page.sourceKey, pairs);
    }
    pairs.push(pair);
    placements.push({ doc: src.doc, srcIndex: page.pageIndex, outPage: copied });
  }
  bindDetachedPageCopies(output, placements);
  const fontBindings = carryAcroForm(output, contributions);
  // The structure tree: EVERY source contributes its surviving tags —
  // a donor page's MCIDs arrive in its copied stream, so its subtree must
  // come along (the AcroForm precedent). Also sweeps the stale
  // /StructParents keys page copies drag in, tagged or not.
  const carriedSources: CarriedSourcePages[] = [...sources.entries()].map(([key, s]) => ({
    doc: s.doc,
    pairs: pairsByKey.get(key) ?? [],
    replaced: removals.replaced,
    settlement,
  }));
  const formatSources = carriedSources.map(source => source.doc);
  // Layer state belongs to every source whose content we copy. Resolve the
  // owner separately: its registry/configurations survive even with no pages.
  let owner: CarriedSourcePages | undefined;
  if (ownSourceKey) {
    const own = sources.get(ownSourceKey);
    const ownPairs = pairsByKey.get(ownSourceKey);
    // Document ownership is independent of retained page membership. Zero
    // own pages still carries its language, preferences, dates and behavior;
    // page-relative entries use an empty map, never the donor's namespace.
    const ownDoc = own?.doc ?? (ownBytes ? await loadNormalized(ownBytes) : undefined);
    if (ownDoc) {
      if (!own) boundTargets += bindEmbeddedTargets(ownDoc);
      owner = { doc: ownDoc, pairs: ownPairs ?? [], replaced: removals.replaced, settlement };
    }
  }
  const optionalContent = carryOptionalContent(output, carriedSources, owner);
  if (optionalContent.properties) output.catalog.set(PDFName.of('OCProperties'),
    output.context.getObjectRef(optionalContent.properties) ?? output.context.register(optionalContent.properties));
  const asCopied = new Map<CarriedSourcePages['pairs'][number], PDFObject[]>();
  const writtenDefaults = new Set<PDFDict>();
  for (const { copied, page, untouched, pair } of pendingExtras) {
    const annots = output.context.lookup(copied.node.get(PDFName.of('Annots')));
    if (annots instanceof PDFArray) asCopied.set(pair, annots.asArray().slice());
    applyPageExtras(copied, page, output, stampImages, signatureFonts, untouched, removals, writtenDefaults);
  }
  // The carries below pair each source page with its copy by position. A
  // build that removes an original changes the order of /Annots (the strip,
  // a popup taken off another page), so every page then pairs /Annots as
  // copied; a build that removes none pairs the live arrays.
  if (removals.count > 0) {
    for (const [pair, entries] of asCopied) pair.annotsAsCopied = output.context.obj(entries);
    settleLinksToRemoved(output, removals);
  }
  if (removals.count > 0 || boundTargets > 0) settleActionsOnRemoved(output, removals, settlement);
  if (removals.count > 0) recordRemovedSubtrees(output, removals);
  const structureMaps = carryStructTree(output, carriedSources);
  // Bookmarks, language, preferences and document actions remain owner-only.
  // Actions use the same actual layer identities as the composed registry.
  if (owner) {
    formatSources.push(owner.doc);
    carryDocumentCatalog(output, owner, structureMaps.get(owner.doc), optionalContent.identities.get(owner.doc));
    carryDocumentInfo(output, owner.doc);
    await carryDocumentMetadata(output, owner.doc, metadataOverrides);
    carryIntents(owner.doc, owner.doc.catalog, output.catalog);
  }
  carryThreads(output, carriedSources);
  // Without an owner key the owner is the source holding the owner's bytes,
  // never a donor as well.
  const ownKey = ownSourceKey ?? [...sources].find(([, s]) => s.bytes === ownBytes)?.[0];
  const ownSource = ownKey !== undefined ? sources.get(ownKey) : undefined;
  let ownCarry: CarrySource | undefined = ownSource;
  if (!ownCarry && owner) ownCarry = { doc: owner.doc, copier: PDFObjectCopier.for(owner.doc.context, output.context) };
  else if (!ownCarry && ownBytes) {
    try {
      const doc = await loadNormalized(ownBytes);
      ownCarry = { doc, copier: PDFObjectCopier.for(doc.context, output.context) };
    } catch { ownCarry = undefined; }
  }
  carryEmbeddedFiles(output, ownCarry, [...sources].filter(([key]) => key !== ownKey).map(([, s]) => s));
  carryFormatDeclarations(output, formatSources);
  if (boundTargets > 0) unbindEmbeddedTargets(output);
  // After every annotation is in place: each free text /DA font is a name
  // of the form's default resources (ISO 32000-2 12.5.6.6, 12.7.4.3).
  completeAnnotationDefaultResources(output, contributions, { authored: writtenDefaults, bindings: fontBindings });
}

/** A source document as the build copies from it: loaded, then its names
 *  rewritten to the spelling pdf.js reads (`normalizeEscapedNames`). */
async function loadNormalized(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  normalizeEscapedNames(doc, bytes, 'all');
  return doc;
}

// Info entries this builder generates for itself. A carried value would be
// overwritten by the explicit set after assembly, so the carry skips the key
// outright rather than depending on that ordering.
const GENERATED_INFO_KEYS = new Set(['/Producer']);

// ISO 32000-2 Table 349: /Trapped is the one name-valued Info entry, and its
// value is one of three names (not the booleans that spell the same words).
// An unlisted name is not a value this carry can preserve as meaningful.
const TRAPPED_NAMES = new Set(['/True', '/False', '/Unknown']);

/** pdf-lib's own getInfoDict is private; this is the same lazy shape — the
 * trailer's existing /Info, or one registered on first use. */
function outputInfoDict(output: PDFDocument): PDFDict {
  const existing = output.context.lookup(output.context.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const created = output.context.obj({});
  output.context.trailerInfo.Info = output.context.register(created);
  return created;
}

/** The OWN document's whole Info dictionary travels to the rebuild — not just
 * its dates. A from-scratch rebuild otherwise published a document whose
 * title, author and private entries were silently gone.
 *
 * Values carry as RAW OBJECTS, never through a decode/re-encode: pdf-lib's
 * date accessors parse to a JS Date and re-serialize as UTC `D:…Z`, which
 * drops the timezone offset and pads a partial date out to a full timestamp.
 * Cloning the leaf keeps the original string kind (literal vs hex), its exact
 * bytes and whatever precision the source actually wrote. Dates in particular
 * never come from the run's clock: a clock-stamped Info dict puts different
 * bytes in the file on every commit of the same document, which breaks
 * byte-identity between an in-place save and its control.
 *
 * ISO 32000-2 14.3.3 makes /Info optional and requires every entry outside
 * /CreationDate and /ModDate to be a text string; Table 349 adds /Trapped as
 * the sole name. So a conforming Info dict holds only leaf scalars, and an
 * entry resolving to anything else (a dict, an array, a stream) is refused
 * before the output is touched — never dropped silently, and never followed
 * into an object graph this carry has no business copying.
 *
 * Absence stays absence, including /Trapped, whose absent-means-Unknown
 * default is not materialized. Per 7.3.9 an entry whose value is null, and a
 * reference to a nonexistent object, are both equivalent to omitting the
 * entry, so those are absent entries rather than malformed ones.
 */
function carryDocumentInfo(output: PDFDocument, source: PDFDocument): void {
  const raw = source.context.trailerInfo.Info;
  if (raw === undefined) return;
  const fail = () => new Error(tChrome('app.operation.unverified'));
  const info = source.context.lookup(raw);
  if (info === undefined || info === PDFNull) return;
  if (!(info instanceof PDFDict)) throw fail();
  // The one permitted leaf for a key: `undefined` for an entry that is really
  // absent, the leaf to clone, or a refusal. Resolving is as far as this goes
  // — a dict, array or stream value never gets followed, so no page graph is
  // cloned and no cycle is walked.
  const leaf = (key: PDFName, value: PDFObject): PDFObject | undefined => {
    const resolved = source.context.lookup(value);
    if (resolved === undefined || resolved === PDFNull) return undefined;
    if (key.asString() === '/Trapped') {
      if (resolved instanceof PDFName && TRAPPED_NAMES.has(resolved.asString())) return resolved;
      throw fail();
    }
    if (resolved instanceof PDFString || resolved instanceof PDFHexString) return resolved;
    throw fail();
  };
  // Resolve and validate every entry BEFORE publishing any of them: a refusal
  // must not leave the output holding half a document's identity.
  const carried: [PDFName, PDFObject][] = [];
  for (const [key, value] of info.entries()) {
    if (GENERATED_INFO_KEYS.has(key.asString())) continue;
    const resolved = leaf(key, value);
    if (resolved) carried.push([key, resolved.clone()]);
  }
  if (carried.length === 0) return;
  const target = outputInfoDict(output);
  for (const [key, value] of carried) target.set(key, value);
}

// A build leaves objects nothing references in the output context: the
// originals the strip removed with their appearance streams and popups,
// copies of pages the build dropped, streams a carry replaced. Each holds
// content the document no longer shows, and the writer saves every object of
// the context.
async function saveReachable(output: PDFDocument): Promise<Uint8Array> {
  await flushAndDropUnreachable(output);
  return saveWithFormatDeclarations(output);
}

export async function buildPdf(
  pages: ExportPage[],
  ownBytes?: Uint8Array,
  ownSourceKey?: string,
): Promise<Uint8Array> {
  // A zero-page PDF is invalid; pdf-lib would happily save one. buildPdfx
  // skips empty documents for the same reason.
  if (pages.length === 0) throw new Error('buildPdf: cannot build a PDF with no pages');
  // updateMetadata:false: pdf-lib's constructor otherwise stamps /ModDate and
  // /CreationDate from `new Date()`, so two builds of the same input differ
  // whenever they straddle a second boundary. The whole Info dictionary
  // travels from the source instead (carryDocumentInfo); /Producer is the one
  // entry this builder generates, set explicitly below.
  const output = await PDFDocument.create({ updateMetadata: false });
  await assemblePages(output, pages, ownSourceKey, ownBytes, { producer: `PDFX ${PDFX_VERSION}` });
  // Names the writer, so it describes this build and not the source's tool.
  // GENERATED_INFO_KEYS keeps the carry off the key; this is its only writer.
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  return saveReachable(output);
}

export async function buildPdfx(
  documents: ExportDocument[],
  title: string,
  ownBytes?: Uint8Array,
  ownSourceKey?: string,
): Promise<Uint8Array> {
  const output = await PDFDocument.create({ updateMetadata: false });
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] };

  const nonEmpty = documents.filter((doc) => doc.pages.length > 0);
  await assemblePages(output, nonEmpty.flatMap((doc) => doc.pages), ownSourceKey, ownBytes, {
    producer: `PDFX ${PDFX_VERSION}`, title, keywords: 'PDFX',
  });
  // The embedded-files carry ran inside assemblePages, BEFORE the manifest
  // attach: pdf-lib's save-time embed appends to an existing tree, so the
  // manifest and carried members coexist (embedded-files-carry.test.ts).
  for (const doc of nonEmpty) {
    manifest.documents.push({ name: doc.name, pages: doc.pages.length });
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    // No creationDate/modificationDate: the manifest is generated, and a
    // clock-stamped file spec is the same nondeterminism as the Info dates.
    description: 'PDFX manifest describing the documents in this collection',
  });

  // A collection describes itself, so these three OVERRIDE whatever the own
  // document's Info carried: the title is the collection's name, not a member
  // document's, and the keyword is what identifies the file as a collection.
  // Every other carried entry (author, subject, creator, dates, private
  // fields) survives untouched.
  output.setTitle(title);
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  output.setKeywords(['PDFX']);

  return saveReachable(output);
}
