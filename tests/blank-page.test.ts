// buildBlankPagePdf (M6.3, § 9.3): the bytes handed to the import machinery.
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildBlankPagePdf, DEFAULT_PAGE_SIZE } from '../src/renderer/lib/blank-page';

describe('buildBlankPagePdf', () => {
  it('produces exactly one page at the requested size', async () => {
    const bytes = await buildBlankPagePdf(200, 300);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBe(200);
    expect(height).toBe(300);
  });

  it('carries no AcroForm and no content', async () => {
    // The import machinery runs the AcroForm carry over every source; a
    // blank page must contribute nothing to it.
    const bytes = await buildBlankPagePdf(100, 100);
    const doc = await PDFDocument.load(bytes);
    expect(doc.catalog.get(doc.context.obj('AcroForm') as never)).toBeUndefined();
  });

  it('falls back to Letter for garbage sizes', async () => {
    for (const [w, h] of [[0, 100], [-5, 100], [NaN, 100], [Infinity, 100]] as const) {
      const doc = await PDFDocument.load(await buildBlankPagePdf(w, h));
      const size = doc.getPage(0).getSize();
      expect(size.width).toBe(DEFAULT_PAGE_SIZE[0]);
      expect(size.height).toBe(100);
    }
    const defaulted = await PDFDocument.load(await buildBlankPagePdf());
    expect(defaulted.getPage(0).getSize()).toEqual({
      width: DEFAULT_PAGE_SIZE[0],
      height: DEFAULT_PAGE_SIZE[1],
    });
  });
});
