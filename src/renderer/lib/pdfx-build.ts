import { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFPage, PDFString, degrees } from 'pdf-lib';

import { MANIFEST_NAME, PDFX_VERSION } from './pdfx-format';
import type { ExportAnnotation, ExportDocument, ExportPage, PdfxManifest } from './pdfx-format';
import { carryAcroForm, prepareSourceForms } from './acroform-carry';
import type { FormContribution } from './acroform-carry';

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
    const STRIPPABLE = new Set(['Square', 'FreeText', 'Ink', 'Stamp', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
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
        fp.rect.every((v, k) => Math.abs(v - rect[k]) <= 0.5),
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
    // Ink strokes are legitimately zero-width/height (a straight horizontal
    // or vertical line) — degenerate only for the box-shaped kinds.
    if (a.kind !== 'ink' && (rx1 - rx0 <= 0 || ry1 - ry0 <= 0)) continue;
    // Pad ink's rect/BBox past the stroke's half-width so a flat line's edge
    // isn't sitting exactly on the BBox boundary (a Form XObject clips to
    // BBox, and that's a knife-edge float-rounding risk at pad == half-width).
    const pad = a.kind === 'ink' ? 2 : 0;
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
      annot = context.obj({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: [x0, y0, x1, y1],
        C: [r, g, b],
        F: 4, // print
        InkList: [flatPdf],
        BS: { W: strokeW },
        AP: { N: ap },
      });
      if (a.note) annot.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
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

function applyPageExtras(copied: import('pdf-lib').PDFPage, page: ExportPage, output: PDFDocument): void {
  applyRotation(copied, page);
  // Must still run when `annotations` is empty but removedImportedOriginals
  // isn't — e.g. the user deleted the only imported annotation on this page,
  // leaving nothing to re-append but still needing the original stripped.
  if (page.annotations?.length || page.removedImportedOriginals?.length) {
    addAnnotations(output, copied, page.annotations ?? [], page.removedImportedOriginals ?? []);
  }
}

// Load each distinct source once, prepare its form-field trees for the kept
// subset of pages, and copy every kept page in ONE copyPages call per source
// — pdf-lib's object copier caches per call, so a field tree shared by
// widgets on several kept pages copies ONCE (the old per-page calls would
// have duplicated the root and forked same-name fields). Pages are then
// added in output order, and carryAcroForm rebuilds the output /AcroForm
// from the copied widgets — without it a rebuild destroys every form field
// (see lib/acroform-carry.ts).
async function assemblePages(output: PDFDocument, pages: ExportPage[]): Promise<void> {
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
    prepareSourceForms(doc, g.indices);
    const copied = await output.copyPages(doc, g.indices);
    const copiedByIndex = new Map<number, PDFPage>();
    g.indices.forEach((idx, i) => copiedByIndex.set(idx, copied[i]));
    const contribution: FormContribution = { source: doc, copiedPages: [] };
    contributions.push(contribution);
    sources.set(key, { doc, copiedByIndex, contribution });
  }
  const used = new Set<PDFPage>();
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
    applyPageExtras(copied, page, output);
    output.addPage(copied);
    src.contribution.copiedPages.push(copied);
  }
  carryAcroForm(output, contributions);
}

export async function buildPdf(pages: ExportPage[]): Promise<Uint8Array> {
  // A zero-page PDF is invalid; pdf-lib would happily save one. buildPdfx
  // skips empty documents for the same reason.
  if (pages.length === 0) throw new Error('buildPdf: cannot build a PDF with no pages');
  const output = await PDFDocument.create();
  await assemblePages(output, pages);
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  return output.save();
}

export async function buildPdfx(documents: ExportDocument[], title: string): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] };

  const nonEmpty = documents.filter((doc) => doc.pages.length > 0);
  await assemblePages(output, nonEmpty.flatMap((doc) => doc.pages));
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
