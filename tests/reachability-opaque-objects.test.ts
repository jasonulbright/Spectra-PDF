import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFInvalidObject, PDFRef } from 'pdf-lib';
import { addFormFields } from '../src/renderer/lib/form-authoring';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';
import { dropUnreachableObjects } from '../src/renderer/lib/pdf-reachability';
import { latin1, qpdfReading } from './support/saved-pdf';

function assemble(objects: string[]): Uint8Array {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const CONTENT = 'BT /F1 24 Tf 72 700 Td (Hello) Tj ET';
const DESCRIPTOR =
  '<< /Type /FontDescriptor /FontName /Times-Roman /Flags 34 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile3 8 0 R >>';
const PROGRAM = '<< /Subtype /Type1C /Length 4 >>\nstream\nABCD\nendstream';

/** A one-page file whose object 6 is the page font; objects 7 and 8 are
 *  named by object 6 only. Object 9 is named by nothing. */
function fontFile(font: string, extra: string[] = []): Uint8Array {
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 5 0 R /Contents 4 0 R >>',
    `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
    '<< /Font << /F1 6 0 R >> >>',
    font,
    DESCRIPTOR,
    PROGRAM,
    '<< /Orphan (unreferenced) >>',
    ...extra,
  ]);
}

const FIELD: NewFieldSpec = { name: 'added', type: 'text', pageIndex: 0, rect: [20, 100, 140, 120] };
const held = (doc: PDFDocument, n: number): boolean => doc.context.lookup(PDFRef.of(n)) !== undefined;
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

const FONT = '/Type /Font /Subtype /Type1 /BaseFont /Times-Roman';

describe('field creation on a file with an object the parser keeps as raw bytes', () => {
  const unparsed: Record<string, string> = {
    'a number with two signs': `<< ${FONT} /FontDescriptor 7 0 R /Junk --1 >>`,
    'a number with an exponent': `<< ${FONT} /FontDescriptor 7 0 R /Junk 1.5e-3 >>`,
  };
  for (const [label, font] of Object.entries(unparsed)) {
    it(`keeps the objects only that object names: ${label}`, async () => {
      const bytes = fontFile(font);
      expect((await load(bytes)).context.lookup(PDFRef.of(6))).toBeInstanceOf(PDFInvalidObject);
      const out = await addFormFields(bytes, [FIELD]);
      const after = await load(out);
      expect(held(after, 7)).toBe(true);
      expect(held(after, 8)).toBe(true);
      expect(latin1(out)).toContain('ABCD');
      expect(held(after, 9)).toBe(false);
      const reading = qpdfReading(out);
      expect(reading.problems.length).toBe(qpdfReading(bytes).problems.length);
      expect(reading.unreachable).toEqual([]);
    });
  }

  it('sweeps a file whose every object parses as before', async () => {
    const bytes = fontFile(`<< ${FONT} /FontDescriptor 7 0 R /Junk -1 >>`);
    const out = await addFormFields(bytes, [FIELD]);
    const after = await load(out);
    expect(held(after, 7)).toBe(true);
    expect(held(after, 8)).toBe(true);
    expect(held(after, 9)).toBe(false);
    expect(latin1(out)).not.toContain('unreferenced');
  });
});

describe('the sweep reads references out of raw object bytes', () => {
  const BAD = '/Junk --1';
  const positions: Record<string, string> = {
    'a dictionary value': `<< ${BAD} /FontDescriptor 7 0 R >>`,
    'the first token': `[7 0 R --1]`,
    'an array entry with no space before the bracket': `<< ${BAD} /K [7 0 R] >>`,
    'an array entry between other references': `<< ${BAD} /K [1 0 R 7 0 R 2 0 R] >>`,
    'a nested dictionary': `<< ${BAD} /A << /B << /C 7 0 R >> >> >>`,
    'directly after a name with no space': `<< ${BAD} /K/L 7 0 R>>`,
    'tokens on three lines': `<< ${BAD} /K 7\n0\r\nR >>`,
    'tokens separated by tabs and form feeds': `<< ${BAD} /K 7\t0\fR >>`,
    'a comment between the tokens': `<< ${BAD} /K 7 % note\n0 % note\nR >>`,
    'after a percent sign inside a string of the same line': `<< ${BAD} /S (100% sure) /K 7 0 R >>`,
    'leading zeros': `<< ${BAD} /K 007 00 R >>`,
    'directly before the closing bracket': `<< ${BAD} /K 7 0 R>>`,
    'the dictionary of a stream': `<< ${BAD} /K 7 0 R /Length 2 >>\nstream\nxy\nendstream`,
  };
  for (const [label, body] of Object.entries(positions)) {
    it(label, async () => {
      const doc = await load(fontFile(body));
      expect(doc.context.lookup(PDFRef.of(6))).toBeInstanceOf(PDFInvalidObject);
      dropUnreachableObjects(doc);
      expect(held(doc, 6)).toBe(true);
      expect(held(doc, 7)).toBe(true);
      expect(held(doc, 8)).toBe(true);
      expect(held(doc, 9)).toBe(false);
    });
  }

  it('follows a chain through two raw objects', async () => {
    const doc = await load(fontFile(`<< ${BAD} /K 10 0 R >>`, [`<< ${BAD} /K 7 0 R >>`]));
    dropUnreachableObjects(doc);
    expect([6, 7, 8, 10].map((n) => held(doc, n))).toEqual([true, true, true, true]);
    expect(held(doc, 9)).toBe(false);
  });

  it('deletes a raw object nothing names, with what only it names', async () => {
    const doc = await load(fontFile(`<< ${FONT} >>`, [`<< ${BAD} /K 7 0 R >>`]));
    expect(doc.context.lookup(PDFRef.of(10))).toBeInstanceOf(PDFInvalidObject);
    dropUnreachableObjects(doc);
    expect([7, 8, 9, 10].map((n) => held(doc, n))).toEqual([false, false, false, false]);
  });
});

describe('the sweep deletes nothing when an object stream did not expand', () => {
  it('keeps every object of the context', async () => {
    const members = '11 0 12 14 << /A --1 >> << /B 7 0 R >>';
    const container = `<< /Type /ObjStm /N 2 /First 10 /Length ${members.length} >>\nstream\n${members}\nendstream`;
    const doc = await load(fontFile(`<< ${FONT} >>`, [container]));
    expect(doc.context.lookup(PDFRef.of(10))).toBeInstanceOf(PDFInvalidObject);
    const before = doc.context.enumerateIndirectObjects().length;
    dropUnreachableObjects(doc);
    expect(doc.context.enumerateIndirectObjects().length).toBe(before);
    expect([7, 8, 9, 10].map((n) => held(doc, n))).toEqual([true, true, true, true]);
  });
});
