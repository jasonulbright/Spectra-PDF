import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFHexString, PDFName, PDFString } from 'pdf-lib';
import {
  PDF_DOC_DIFFERENCES,
  decodePdfTextString,
  pdfNameKey,
  pdfNameText,
  pdfStringCodes,
} from '../src/renderer/lib/pdf-text-string';

const require = createRequire(import.meta.url);
const chars = (...codes: number[]): string => String.fromCharCode(...codes);
const BACKSLASH = chars(0x5c);

describe('string object codes', () => {
  it('a hex string skips whitespace between digits', () => {
    expect(pdfStringCodes(PDFHexString.of('48 69'))).toEqual([0x48, 0x69]);
    expect(pdfStringCodes(PDFHexString.of(`FE${chars(0x0d, 0x0a)}FF 00 41`))).toEqual([0xfe, 0xff, 0x00, 0x41]);
  });

  it('a hex string with an odd digit count pads the last digit with 0', () => {
    expect(pdfStringCodes(PDFHexString.of('487'))).toEqual([0x48, 0x70]);
  });

  it('a literal string drops a backslash before CR LF, CR or LF', () => {
    const raw = `a${BACKSLASH}${chars(0x0d, 0x0a)}b${BACKSLASH}${chars(0x0d)}c${BACKSLASH}${chars(0x0a)}d`;
    expect(pdfStringCodes(PDFString.of(raw))).toEqual([0x61, 0x62, 0x63, 0x64]);
  });

  it('a three-digit octal escape above 255 stays one code', () => {
    expect(pdfStringCodes(PDFString.of(`${BACKSLASH}777`))).toEqual([0o777]);
    expect(pdfStringCodes(PDFString.of(`${BACKSLASH}53${BACKSLASH}0019`))).toEqual([0o53, 0o1, 0x39]);
  });

  it('a literal string reads the escapes of Table 3 and keeps an unknown one as its character', () => {
    const raw = ['n', 'r', 't', 'b', 'f', '(', ')', BACKSLASH, 'q'].map((c) => BACKSLASH + c).join('');
    expect(pdfStringCodes(PDFString.of(raw))).toEqual([0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x28, 0x29, 0x5c, 0x71]);
  });
});

describe('text string decoding', () => {
  it('an odd UTF-16 run that fails to decode falls back on the trimmed codes', () => {
    const text = decodePdfTextString([0xfe, 0xff, 0xd8, 0x00, 0x41]);
    expect(text).toBe(chars(0xfe, 0xff, 0xd8, 0x00));
  });

  it('a code above 255 outside a BOM run keeps its value', () => {
    expect(decodePdfTextString([0o777])).toBe(chars(0x1ff));
  });
});

describe('name text', () => {
  it('decodes a lowercase #xx escape the parser left in place', () => {
    expect(pdfNameText(PDFName.of('#c3#a9'))).toBe(chars(0xe9));
    expect(pdfNameText(PDFName.of('caf#C3#a9'))).toBe(`caf${chars(0xe9)}`);
  });

  it('spells a name with a lowercase escape the way pdf.js does', () => {
    expect(pdfNameKey(PDFName.of('High#6cight'))).toBe('Highlight');
  });

  it('reads bytes that are not UTF-8 one for one', () => {
    expect(pdfNameText(PDFName.of('A#e9'))).toBe(`A${chars(0xe9)}`);
  });
});

describe('the PDFDocEncoding table', () => {
  it('matches the importer table in the installed pdf.js', () => {
    const worker = readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
    const match = /const PDFStringTranslateTable = \[([^\]]*)\];/.exec(worker);
    expect(match).not.toBeNull();
    const table = match![1].split(',').map((entry) => Number(entry.trim()));
    const differences = new Map<number, number>();
    table.forEach((code, byte) => {
      if (code) differences.set(byte, code);
    });
    expect([...PDF_DOC_DIFFERENCES]).toEqual([...differences]);
  });
});
