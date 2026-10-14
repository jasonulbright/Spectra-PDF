// The private copy the stamp raster renders is opened as the shown document
// was: the cache entry's bytes, which stay encrypted for a password document
// (ISO 32000-2 7.6.4.1), and the password the path has when the copy opens.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdf } from './support/saved-pdf';
import { testPython } from './support/python';

vi.mock('../src/renderer/lib/pdfRenderer', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    loadDocument: (buffer: Uint8Array | ArrayBuffer | number[], password?: string) =>
      pdfjs.getDocument({
        data: buffer instanceof Uint8Array ? buffer.slice() : new Uint8Array(buffer as ArrayBuffer),
        ...(password !== undefined ? { password } : {}),
      }).promise,
  };
});

import { contentKeyOf, evictExcept, getDocumentProxy, openPrivateCopy } from '../src/renderer/lib/pdfDocCache';
import { forgetDocumentPassword, rememberDocumentPassword } from '../src/renderer/lib/document-passwords';
import { holdAppearanceRaster } from '../src/renderer/lib/appearance-raster';

const HAS_CANVAS = (() => {
  try {
    createRequire(import.meta.url).resolve('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
})();

const PASSWORD = 'open sesame';

/** One page with a stamp at [50 400 250 500], red in its left half and blue
 *  in its right half. */
async function stampPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
  }));
  const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [50, 400, 250, 500], F: 4, AP: { N: appearance } });
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
  return doc.save();
}

/** `bytes` encrypted with a user password. */
function encrypted(bytes: Uint8Array): Uint8Array {
  const out = execFileSync(testPython(), ['-B', '-c', [
    'import base64, io, sys, pikepdf',
    'pdf = pikepdf.open(io.BytesIO(base64.b64decode(sys.stdin.read())))',
    'out = io.BytesIO()',
    'pdf.save(out, encryption=pikepdf.Encryption(user=sys.argv[1], owner="owner", R=6))',
    'sys.stdout.write(base64.b64encode(out.getvalue()).decode("ascii"))',
  ].join('\n'), PASSWORD], { input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return new Uint8Array(Buffer.from(out, 'base64'));
}

async function stampId(pdf: PDFDocumentProxy): Promise<string> {
  const annotations = (await (await pdf.getPage(1)).getAnnotations()) as { id: string; subtype: string }[];
  return annotations.find((a) => a.subtype === 'Stamp')!.id;
}

type Pixel = [number, number, number, number];
const pixel = (canvas: unknown, x: number, y: number): Pixel =>
  Array.from((canvas as { getContext(kind: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } })
    .getContext('2d').getImageData(x, y, 1, 1).data) as Pixel;

describe('the private copy of a password document', () => {
  it.skipIf(!HAS_CANVAS)('rasters a carried stamp of a document opened with a user password', async () => {
    const cipher = encrypted(await stampPage());
    await expect(loadPdf(cipher)).rejects.toMatchObject({ name: 'PasswordException' });
    const path = 'C:/locked.pdf';
    rememberDocumentPassword(path, PASSWORD);
    try {
      const pdf = await getDocumentProxy(path, cipher);
      const hold = holdAppearanceRaster({ pdf, contentKey: await contentKeyOf(pdf), open: () => openPrivateCopy(pdf) }, 1, await stampId(pdf), 2);
      const raster = await hold.raster;
      expect({ width: raster!.canvas.width, height: raster!.canvas.height }).toEqual({ width: 400, height: 200 });
      expect([pixel(raster!.canvas, 100, 100), pixel(raster!.canvas, 300, 100)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
      hold.release();
    } finally {
      forgetDocumentPassword(path);
      evictExcept(new Set());
    }
  });

  it('opens with the password the path has when the copy opens, and fails without one', async () => {
    const cipher = encrypted(await stampPage());
    const path = 'C:/locked-later.pdf';
    rememberDocumentPassword(path, PASSWORD);
    try {
      const pdf = await getDocumentProxy(path, cipher);
      forgetDocumentPassword(path);
      await expect(openPrivateCopy(pdf)).rejects.toMatchObject({ name: 'PasswordException' });
      rememberDocumentPassword(path, PASSWORD);
      const copy = await openPrivateCopy(pdf);
      expect(copy).not.toBe(pdf);
      expect(copy.numPages).toBe(1);
      await copy.loadingTask.destroy();
    } finally {
      forgetDocumentPassword(path);
      evictExcept(new Set());
    }
  });

  it('refuses a document the cache did not load, whose bytes it could only read as stored', async () => {
    const cipher = encrypted(await stampPage());
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const shown = (await pdfjs.getDocument({ data: cipher.slice(), password: PASSWORD }).promise) as unknown as PDFDocumentProxy;
    try {
      const getData = vi.spyOn(shown, 'getData');
      await expect(openPrivateCopy(shown)).rejects.toThrow(/not loaded by the proxy cache/);
      expect(getData).not.toHaveBeenCalled();
      // The raster keeps no result of the refusal.
      const source = { pdf: shown, contentKey: null, open: () => openPrivateCopy(shown) };
      const hold = holdAppearanceRaster(source, 1, await stampId(shown), 2);
      expect(await hold.raster).toBeNull();
      hold.release();
    } finally {
      await shown.loadingTask.destroy();
    }
  });
});
