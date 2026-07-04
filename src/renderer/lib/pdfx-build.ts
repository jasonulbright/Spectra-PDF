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
    const annot = context.obj({
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
