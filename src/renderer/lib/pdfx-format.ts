// The .pdfx format: a plain, fully backwards-compatible PDF whose pages are the
// concatenation of one or more logical documents, with a JSON manifest attached
// (as a standard PDF file attachment) recording the document boundaries. Any PDF
// viewer opens it as a normal PDF; this app reads the manifest to restore the
// multi-document structure.
import type { PDFDocumentProxy } from 'pdfjs-dist';

export { buildPdf, buildPdfx } from './pdfx-build';

export const MANIFEST_NAME = 'pdfx-manifest.json';
export const PDFX_VERSION = '1.0';

export interface PdfxManifestDocument {
  name: string;
  pages: number;
}

export interface PdfxManifest {
  pdfx: string;
  title?: string;
  documents: PdfxManifestDocument[];
}

export interface PagePartition {
  name: string;
  indices: number[];
}

// Display-normalized annotation (0..1 in the rendered, rotation-inclusive
// orientation); the builder maps it into PDF user space. Spectra PDF extension —
// absent keeps PDFx-identical output.
export interface ExportAnnotation {
  kind:
    | 'highlight'
    | 'freetext'
    | 'ink'
    | 'stamp'
    | 'textmarkup'
    | 'note'
    | 'measure'
    | 'shape'
    | 'callout'
    | 'count'
    | 'countlegend';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string; // #rrggbb
  note?: string;
  points?: number[]; // measure/shape/callout-leader: flat [x0,y0,...] in x/y/w/h space
  strokes?: number[][]; // ink only (N2): one flat path per pen lift, same space
  imageData?: string; // stamp only: custom image stamp's data URL (the AP draws it)
  markupType?: 'highlight' | 'underline' | 'strikeout' | 'squiggly'; // textmarkup only
  quads?: number[]; // textmarkup only: flat [x0,y0,x1,y1,...] per quad, in x/y/w/h space
  // measure only — the dimension class + the /Measure dict inputs.
  measureKind?: 'distance' | 'perimeter' | 'area';
  measureRatio?: string;
  measureUnitsPerPt?: number;
  measureUnit?: string;
  // shape/callout (rung 2) — see PageAnnotation's field comments.
  shapeType?: 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud';
  strokeWidth?: number;
  fillColor?: string;
  opacity?: number;
  calloutBox?: [number, number, number, number];
  lineEndings?: [string, string];
  cloudIntensity?: number;
  // count / countlegend (N11 slice C) — see PageAnnotation's field comments.
  countGroup?: string;
  countSymbol?: string;
  countSeq?: number;
  legendRows?: import('./count-marks').CountLegendRow[];
  legendTitle?: string;
  legendTotalWord?: string;
  // Present for imported annotations only — see PageAnnotation.importedOriginal
  // and the "importing existing annotations safely" design note. The builder
  // uses this to positively match and strip the ORIGINAL object from the
  // copied page before re-appending this (possibly edited) annotation, so
  // imported-but-unedited annotations don't end up duplicated in the output.
  importedOriginal?: {
    subtype:
      | 'Square' | 'FreeText' | 'Ink' | 'Stamp' | 'Highlight' | 'Underline' | 'StrikeOut'
      | 'Squiggly' | 'Text' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine';
    rect: [number, number, number, number];
    contents?: string;
  };
}

export interface ExportPage {
  bytes: Uint8Array;
  sourceKey: string;
  pageIndex: number;
  // Extra quarter-turns applied on top of the page's inherent /Rotate.
  // Deviation from the PDFx original: carries PageRef.rotation through the
  // commit bridge. Absent/0 keeps PDFx-identical output.
  rotation?: 0 | 90 | 180 | 270;
  annotations?: ExportAnnotation[];
  // Fingerprints of imported annotations the user removed — see
  // PageRef.removedImportedOriginals. The builder strips their matching
  // original from the copied page's real /Annots WITHOUT re-appending them
  // (unlike `annotations`, which is always re-appended after stripping).
  removedImportedOriginals?: NonNullable<ExportAnnotation['importedOriginal']>[];
}

export interface ExportDocument {
  name: string;
  pages: ExportPage[];
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

export function stripExtension(filename: string): string {
  return filename.replace(/\.(pdf|pdfx)$/i, '');
}

export async function readManifest(pdf: PDFDocumentProxy): Promise<PdfxManifest | null> {
  const attachments = (await pdf.getAttachments()) as Record<
    string,
    { filename?: string; content: Uint8Array }
  > | null;
  if (!attachments) return null;

  for (const [key, attachment] of Object.entries(attachments)) {
    if ((attachment.filename ?? key) !== MANIFEST_NAME) continue;
    try {
      const manifest = JSON.parse(new TextDecoder().decode(attachment.content)) as PdfxManifest;
      const valid =
        manifest &&
        Array.isArray(manifest.documents) &&
        manifest.documents.every(
          (d) => typeof d.name === 'string' && Number.isInteger(d.pages) && d.pages > 0
        );
      return valid ? manifest : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function partitionPages(
  manifest: PdfxManifest | null,
  totalPages: number,
  fallbackName: string
): PagePartition[] {
  if (!manifest) return [{ name: fallbackName, indices: range(0, totalPages) }];

  const partitions: PagePartition[] = [];
  let cursor = 0;
  for (const entry of manifest.documents) {
    const count = Math.min(entry.pages, totalPages - cursor);
    if (count <= 0) break;
    partitions.push({ name: entry.name, indices: range(cursor, count) });
    cursor += count;
  }
  if (cursor < totalPages) {
    partitions.push({ name: 'Untitled', indices: range(cursor, totalPages - cursor) });
  }
  return partitions;
}
