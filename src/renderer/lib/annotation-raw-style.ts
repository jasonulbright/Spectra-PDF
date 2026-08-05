// Raw /Annots style sidecar (rung 2). pdf.js's getAnnotations() hides the
// entries faithful shape import needs — /IC interior color, /CA opacity,
// /BE cloudy borders, /CL callout leaders, /RD text-box insets, /LE on
// polylines, /Measure markers — so the workspace indexer reads them straight
// off the file with pdf-lib and the importer merges them into pdf.js's parse
// by (subtype, rect) fingerprint, the same positive-match discipline as the
// commit-time strip. No sidecar (encrypted file, parse failure) degrades to
// pdf.js-only import: the shape kinds then stay UNIMPORTED rather than
// imported blind — faithful-or-untouched.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PdfBuffer } from '../state/types';

export interface RawAnnotStyle {
  subtype: string;
  rect: [number, number, number, number];
  /** /BS /W — absent means the PDF default (1). */
  strokeWidth?: number;
  /** /CA 0..1. */
  opacity?: number;
  /** /IC as #rrggbb (gray and CMYK converted; absent = no fill). */
  fillColor?: string;
  /** /BE with /S /C — the cloudy border; /I is its intensity (default 2). */
  cloudy?: boolean;
  cloudIntensity?: number;
  /** /IT name (LineDimension, PolygonCloud, FreeTextCallout, …). */
  it?: string;
  /** /CL flat numbers (4 or 6) — the callout leader in PDF space. */
  cl?: number[];
  /** /LE names — pair for Line/PolyLine, single for FreeText. */
  le?: string[];
  /** /Vertices flat numbers (Polygon/PolyLine). */
  vertices?: number[];
  /** /L flat numbers (Line endpoints). */
  l?: number[];
  /** A /Measure dict is present — a dimension, not a drawing shape. */
  measure?: boolean;
  /** /RD [left top right bottom] insets (FreeText callouts). */
  rd?: [number, number, number, number];
  /** /Subj — the annotation's subject. pdf.js does not surface it, and it is
   * where a count mark carries its GROUP name. */
  subj?: string;
  /** The private /SpectraSymbol name — which vector symbol a count mark's
   * marker draws (the /SpectraMask precedent). */
  spectraSymbol?: string;
  /** The private /SpectraLegend JSON — a placed takeoff legend's snapshot
   * rows. Text, so it survives any producer that rewrites the dictionary. */
  spectraLegend?: string;
  /** The private /SpectraSymbolParts JSON — a placed symbol's own geometry
   * Carried so the drawing redraws where the SET it came from
   * was never imported. Sanitized at the importer, never trusted here. */
  spectraSymbolParts?: string;
}

function num(v: unknown): number | undefined {
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function numArray(arr: unknown): number[] | undefined {
  if (!(arr instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const n = num(arr.lookup(i));
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** /IC (or any PDF colour array) → #rrggbb. 1 = gray, 3 = RGB, 4 = CMYK. */
function colorHex(arr: unknown): string | undefined {
  const nums = numArray(arr);
  if (!nums) return undefined;
  if (nums.length === 3) return toHex(nums[0], nums[1], nums[2]);
  if (nums.length === 1) return toHex(nums[0], nums[0], nums[0]);
  if (nums.length === 4) {
    const [c, m, y, k] = nums;
    return toHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
  }
  return undefined;
}

function nameOf(v: unknown): string | undefined {
  return v instanceof PDFName ? v.decodeText() : undefined;
}

/** A PDF text string (literal or hex) as JS text; a /Name decodes too, since
 * the private /SpectraSymbol is written as one. */
function textOf(v: unknown): string | undefined {
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

/** Per-page raw annotation styles, in /Annots order. Returns null when the
 * file can't be parsed (encrypted, damaged) — the importer treats that as
 * "no sidecar", never as "no styles". */
export async function readRawAnnotationStyles(buffer: PdfBuffer): Promise<RawAnnotStyle[][] | null> {
  let doc: PDFDocument;
  try {
    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : buffer instanceof ArrayBuffer
          ? new Uint8Array(buffer)
          : Uint8Array.from(buffer);
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const pages = doc.getPages();
  const out: RawAnnotStyle[][] = [];
  for (const page of pages) {
    const styles: RawAnnotStyle[] = [];
    try {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          // Per-ANNOTATION fault tolerance: one malformed entry must not
          // hide its siblings' styles (the importer would then leave THEM
          // untouched too — safe, but needlessly lossy).
          try {
          let dict: PDFDict;
          try {
            dict = annots.lookup(i, PDFDict);
          } catch {
            continue;
          }
          const subtype = nameOf(dict.lookupMaybe(PDFName.of('Subtype'), PDFName));
          const rect = numArray(dict.lookupMaybe(PDFName.of('Rect'), PDFArray));
          if (!subtype || !rect || rect.length !== 4) continue;
          const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
          const be = dict.lookupMaybe(PDFName.of('BE'), PDFDict);
          // /LE is legitimately an ARRAY on Line/PolyLine and a NAME on
          // FreeText — a typed lookupMaybe THROWS on the other shape, so
          // resolve untyped and branch on instanceof.
          const leRaw = dict.lookup(PDFName.of('LE'));
          let le: string[] | undefined;
          if (leRaw instanceof PDFArray) {
            const names: string[] = [];
            for (let j = 0; j < leRaw.size(); j++) {
              const n = nameOf(leRaw.lookup(j));
              if (n) names.push(n);
            }
            if (names.length) le = names;
          } else if (leRaw instanceof PDFName) {
            le = [leRaw.decodeText()];
          }
          const rd = numArray(dict.lookupMaybe(PDFName.of('RD'), PDFArray));
          styles.push({
            subtype,
            rect: rect as [number, number, number, number],
            strokeWidth: num(bs?.lookupMaybe(PDFName.of('W'), PDFNumber)),
            opacity: num(dict.lookupMaybe(PDFName.of('CA'), PDFNumber)),
            fillColor: colorHex(dict.lookupMaybe(PDFName.of('IC'), PDFArray)),
            cloudy: nameOf(be?.lookupMaybe(PDFName.of('S'), PDFName)) === 'C',
            cloudIntensity: num(be?.lookupMaybe(PDFName.of('I'), PDFNumber)),
            it: nameOf(dict.lookupMaybe(PDFName.of('IT'), PDFName)),
            cl: numArray(dict.lookupMaybe(PDFName.of('CL'), PDFArray)),
            le,
            vertices: numArray(dict.lookupMaybe(PDFName.of('Vertices'), PDFArray)),
            l: numArray(dict.lookupMaybe(PDFName.of('L'), PDFArray)),
            measure: !!dict.get(PDFName.of('Measure')),
            subj: textOf(dict.lookup(PDFName.of('Subj'))),
            spectraSymbol: textOf(dict.lookup(PDFName.of('SpectraSymbol'))),
            spectraLegend: textOf(dict.lookup(PDFName.of('SpectraLegend'))),
            spectraSymbolParts: textOf(dict.lookup(PDFName.of('SpectraSymbolParts'))),
            ...(rd && rd.length === 4 ? { rd: rd as [number, number, number, number] } : {}),
          });
          } catch {
            continue; // this entry only — its siblings still get styles
          }
        }
      }
    } catch {
      // A malformed page's /Annots yields no sidecar entries for that page;
      // the importer falls back per-annotation.
    }
    out.push(styles);
  }
  return out;
}

/** Find (and consume) the raw entry matching a pdf.js annotation — subtype +
 * rect within tolerance, first unconsumed match, exactly the strip's rules. */
export function takeRawStyle(
  styles: RawAnnotStyle[] | undefined,
  consumed: Set<number>,
  subtype: string,
  rect: [number, number, number, number],
): RawAnnotStyle | undefined {
  if (!styles) return undefined;
  for (let i = 0; i < styles.length; i++) {
    if (consumed.has(i)) continue;
    const s = styles[i];
    if (s.subtype !== subtype) continue;
    if (s.rect.every((v, k) => Math.abs(v - rect[k]) <= 0.5)) {
      consumed.add(i);
      return s;
    }
  }
  return undefined;
}
