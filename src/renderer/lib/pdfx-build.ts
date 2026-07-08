import { PDFDocument, PDFArray, PDFHexString, PDFName, degrees } from 'pdf-lib';

import { MANIFEST_NAME, PDFX_VERSION } from './pdfx-format';
import type { ExportAnnotation, ExportDocument, ExportPage, PdfxManifest } from './pdfx-format';

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

// Map a display-normalized rect (top-left origin, in the orientation a viewer
// shows after applying the page's FINAL rotation) back into PDF user space.
// Corner interpolation per quarter-turn; validated against pdf.js viewport
// round-trips in tests/workspace-commit.test.ts.
export function displayRectToPdf(
  a: { x: number; y: number; w: number; h: number },
  mediaBox: { x: number; y: number; width: number; height: number },
  rotation: number,
): [number, number, number, number] {
  const { x: mx, y: my, width: W, height: H } = mediaBox;
  const corners: [number, number][] = [
    [a.x, a.y],
    [a.x + a.w, a.y + a.h],
  ];
  const mapped = corners.map(([u, v]): [number, number] => {
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
  });
  const xs = [mapped[0][0], mapped[1][0]];
  const ys = [mapped[0][1], mapped[1][1]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const HIGHLIGHT_ALPHA = 0.4;
const FREETEXT_FONT_SIZE = 12;

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

function addAnnotations(
  output: PDFDocument,
  copied: import('pdf-lib').PDFPage,
  annotations: ExportAnnotation[],
): void {
  const context = output.context;
  const { x, y, width, height } = copied.getMediaBox();
  const rotation = ((copied.getRotation().angle % 360) + 360) % 360;
  for (const a of annotations) {
    const [x0, y0, x1, y1] = displayRectToPdf(a, { x, y, width, height }, rotation);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
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
  if (page.annotations?.length) addAnnotations(output, copied, page.annotations);
}

export async function buildPdf(pages: ExportPage[]): Promise<Uint8Array> {
  // A zero-page PDF is invalid; pdf-lib would happily save one. buildPdfx
  // skips empty documents for the same reason.
  if (pages.length === 0) throw new Error('buildPdf: cannot build a PDF with no pages');
  const output = await PDFDocument.create();
  const sources = new Map<string, PDFDocument>();
  for (const page of pages) {
    let source = sources.get(page.sourceKey);
    if (!source) {
      source = await PDFDocument.load(page.bytes, { ignoreEncryption: true });
      sources.set(page.sourceKey, source);
    }
    const [copied] = await output.copyPages(source, [page.pageIndex]);
    applyPageExtras(copied, page, output);
    output.addPage(copied);
  }
  output.setProducer(`PDFX ${PDFX_VERSION}`);
  return output.save();
}

export async function buildPdfx(documents: ExportDocument[], title: string): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] };
  const sources = new Map<string, PDFDocument>();

  for (const doc of documents) {
    if (doc.pages.length === 0) continue;
    for (const page of doc.pages) {
      let source = sources.get(page.sourceKey);
      if (!source) {
        source = await PDFDocument.load(page.bytes, { ignoreEncryption: true });
        sources.set(page.sourceKey, source);
      }
      const [copied] = await output.copyPages(source, [page.pageIndex]);
      applyPageExtras(copied, page, output);
      output.addPage(copied);
    }
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
