import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { testPython } from './python';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const ORACLE = join(__dirname, 'saved_pdf_oracle.py');

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
}

export const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

/** Every spelling a text can take in a file: its characters, UTF-16BE code
 *  units, and the hex digits of both. Compared in lower case. */
function spellings(text: string): string[] {
  const utf16 = [...text].map((c) => `\0${c}`).join('');
  const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return [text, utf16, hex(text), hex(utf16)].map((s) => s.toLowerCase());
}

/** The texts among `needles` the saved file holds: in its raw bytes, in any
 *  object pdf-lib parses (objects inside object streams included), or in any
 *  decoded stream. */
export async function held(bytes: Uint8Array, needles: string[]): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts = [latin1(bytes)];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    parts.push(obj instanceof PDFStream ? obj.dict.toString() : obj.toString());
    if (obj instanceof PDFRawStream) {
      try { parts.push(latin1(decodePDFRawStream(obj).decode())); } catch { parts.push(latin1(obj.contents)); }
    }
  }
  const text = parts.join('\n').toLowerCase();
  return needles.filter((needle) => spellings(needle).some((spelling) => text.includes(spelling)));
}

export interface QpdfReading {
  /** qpdf's syntax check. */
  problems: string[];
  /** The needles an object qpdf lists holds. */
  found: string[];
  pages: number;
  /** Objects qpdf lists that the trailer does not reach by qpdf's own walk. */
  unreachable: string[];
  /** Resources a page or appearance content stream names and does not hold,
   *  fonts a default appearance of the form, a field or a free text
   *  annotation names and the form's default resources do not hold, default
   *  appearances that start with a byte order mark, and default resource
   *  entries that are not objects. */
  missing: string[];
  /** The entries of `missing` for a default appearance font the default
   *  resources do not hold. None names a page or a position. */
  default_fonts: string[];
  /** How many resource names resolved, by kind. `form_fonts` counts the fonts
   *  of default appearances (form, fields and free text annotations);
   *  `form_resources` the default resource entries. */
  used: {
    fonts: number; embedded_fonts: number; images: number; forms: number; graphics_states: number; shadings: number;
    form_fonts: number; form_resources: number;
  };
}

/** qpdf's reading of the file (`saved_pdf_oracle.py`). It shares no code with
 *  the product's walk or with pdf-lib. */
export function qpdfReading(bytes: Uint8Array, needles: string[] = []): QpdfReading {
  const directory = mkdtempSync(join(tmpdir(), 'spectra-saved-'));
  try {
    const path = join(directory, 'saved.pdf');
    writeFileSync(path, bytes);
    return JSON.parse(execFileSync(testPython(), ['-B', ORACLE, path, ...needles],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true })) as QpdfReading;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The references the trailer reaches, by a pdf-lib walk. */
function reached(doc: PDFDocument): Set<string> {
  const tags = new Set<string>();
  const { Root, Info, Encrypt, ID } = doc.context.trailerInfo;
  const stack: (PDFObject | undefined)[] = [Root, Info, Encrypt, ID];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value instanceof PDFRef) {
      if (tags.has(value.tag)) continue;
      tags.add(value.tag);
      stack.push(doc.context.lookup(value));
    } else if (value instanceof PDFStream) stack.push(value.dict);
    else if (value instanceof PDFDict) for (const [, entry] of value.entries()) stack.push(entry);
    else if (value instanceof PDFArray) stack.push(...value.asArray());
  }
  return tags;
}

/** The saved file reloads in pdf-lib, pdf.js and qpdf. Every reference names
 *  an object the file holds. The trailer reaches every object, by a pdf-lib
 *  walk and by qpdf's. Every resource a page or an appearance stream names
 *  resolves, and so does every font a default appearance of the form, a
 *  field or a free text annotation names. No reader finds any of `gone`.
 *  Returns qpdf's reading.
 *  `inherited` matches a syntax problem the input file already has and the
 *  save keeps by design; every other problem fails.
 *  `input` is the file the save was made from, or qpdf's reading of it. A
 *  default appearance font that file already left unresolved, for the same
 *  form, field or free text annotation, is the input's defect and passes; one
 *  the input resolved, or did not hold, fails. */
export async function expectSound(
  bytes: Uint8Array, gone: string[] = [], inherited?: RegExp, input?: Uint8Array | QpdfReading,
): Promise<QpdfReading> {
  expect(await held(bytes, gone)).toEqual([]);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const live = reached(doc);
  const dangling: string[] = [];
  const unreached: string[] = [];
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!live.has(ref.tag)) unreached.push(ref.tag);
  for (const tag of live) if (doc.context.lookup(PDFRef.of(Number(tag.split(' ')[0]), Number(tag.split(' ')[1]))) === undefined) dangling.push(tag);
  expect({ dangling, unreached }).toEqual({ dangling: [], unreached: [] });
  const pdf = await loadPdf(bytes);
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    await page.getAnnotations();
    await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  }
  const pages = pdf.numPages;
  await pdf.loadingTask.destroy();
  const reading = qpdfReading(bytes, gone);
  if (inherited) reading.problems = reading.problems.filter((problem) => !inherited.test(problem));
  if (input) {
    const before = new Set((input instanceof Uint8Array ? qpdfReading(input) : input).default_fonts);
    const kept = new Set(reading.default_fonts.filter((entry) => before.has(entry)));
    reading.missing = reading.missing.filter((entry) => !kept.has(entry));
  }
  expect({ ...reading, used: undefined, default_fonts: undefined })
    .toEqual({ problems: [], found: [], pages, unreachable: [], missing: [], used: undefined, default_fonts: undefined });
  return reading;
}

export interface Shown { id: string; subtype: string; text: string; inReplyTo: string | null }

/** One page's annotations as pdf.js shows them. */
export async function shown(bytes: Uint8Array, pageNumber = 1): Promise<Shown[]> {
  const pdf = await loadPdf(bytes);
  const annots = (await (await pdf.getPage(pageNumber)).getAnnotations()) as { id: string; subtype: string; contentsObj?: { str: string }; inReplyTo?: string | null }[];
  await pdf.loadingTask.destroy();
  return annots.map((a) => ({ id: a.id, subtype: a.subtype, text: a.contentsObj?.str ?? '', inReplyTo: a.inReplyTo ?? null }));
}

export const brief = (list: Shown[]): string[] => list.map(({ subtype, text }) => `${subtype}:${text}`).sort();

export function annotsOf(doc: PDFDocument, pageIndex = 0): { ref: PDFObject; dict: PDFDict }[] {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  return (annots?.asArray() ?? []).map((ref) => ({ ref, dict: doc.context.lookup(ref, PDFDict) }));
}

export const subtypeOf = (dict: PDFDict): string => String(dict.get(PDFName.of('Subtype')));
