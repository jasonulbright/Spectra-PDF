// The checks `expectSound` relies on report what they claim to report. Each
// test here saves a file with one known defect and requires qpdf's reading
// (tests/support/saved_pdf_oracle.py) to name it.

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PDFContext, PDFPage } from 'pdf-lib';
import { expectSound, qpdfReading } from './support/saved-pdf';

const N = PDFName.of;

async function saved(build: (ctx: PDFContext, page: PDFPage) => void, useObjectStreams = true): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  build(doc.context, page);
  return doc.save({ useObjectStreams });
}

const helvetica = (ctx: PDFContext) => ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));

describe('qpdf reading of a saved file', () => {
  it.each([[true], [false]])('lists an object nothing references (object streams: %s)', async (useObjectStreams) => {
    const bytes = await saved((ctx) => {
      const orphan = ctx.obj({ Kind: 'Orphan' });
      orphan.set(N('Text'), PDFString.of('ORPHANTEXT'));
      ctx.register(orphan);
    }, useObjectStreams);
    const reading = qpdfReading(bytes, ['ORPHANTEXT']);
    expect(reading.unreachable).toHaveLength(1);
    expect(reading.found).toEqual(['ORPHANTEXT']);
    await expect(expectSound(bytes)).rejects.toThrow();
  });

  it.each([[true], [false]])('lists nothing for a file with no such object (object streams: %s)', async (useObjectStreams) => {
    const reading = qpdfReading(await saved(() => undefined, useObjectStreams));
    expect(reading).toMatchObject({ problems: [], unreachable: [], missing: [], pages: 1 });
  });

  it('names a font the page content uses and the page does not hold', async () => {
    const bytes = await saved((ctx, page) => {
      page.node.set(N('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf (x) Tj ET')));
    });
    expect(qpdfReading(bytes).missing).toEqual(['page 1: /Font /F1']);
    await expect(expectSound(bytes)).rejects.toThrow();
  });

  it('counts a font the page content uses and the page holds', async () => {
    const bytes = await saved((ctx, page) => {
      page.node.set(N('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf (x) Tj ET')));
      page.node.set(N('Resources'), ctx.obj({ Font: { F1: helvetica(ctx) } }));
    });
    expect(qpdfReading(bytes)).toMatchObject({ missing: [], used: { fonts: 1, embedded_fonts: 0 } });
    await expectSound(bytes);
  });

  it('names an image an annotation appearance draws and does not hold', async () => {
    const bytes = await saved((ctx, page) => {
      const appearance = ctx.register(ctx.stream('q 10 0 0 10 0 0 cm /Im0 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
      const stamp = ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 20, 20], AP: { N: appearance } });
      page.node.set(N('Annots'), ctx.obj([ctx.register(stamp)]));
    });
    expect(qpdfReading(bytes).missing).toEqual(['page 1 annotation 0 /N: /XObject /Im0']);
  });

  it('follows a form XObject into the resources it names', async () => {
    const bytes = await saved((ctx, page) => {
      const inner = ctx.register(ctx.stream('BT /F9 12 Tf (x) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { Font: {} } }));
      page.node.set(N('Contents'), ctx.register(ctx.stream('/Fm0 Do')));
      page.node.set(N('Resources'), ctx.obj({ XObject: { Fm0: inner } }));
    });
    expect(qpdfReading(bytes)).toMatchObject({ missing: ['page 1 /Fm0: /Font /F9'], used: { forms: 1 } });
  });
});

describe('qpdf reading of a form', () => {
  const formWith = (resources: (ctx: PDFContext) => Record<string, unknown>, fieldAppearance?: string) =>
    saved((ctx, page) => {
      const field = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [20, 300, 140, 320] });
      field.set(N('T'), PDFString.of('name'));
      if (fieldAppearance) field.set(N('DA'), PDFString.of(fieldAppearance));
      const fieldRef = ctx.register(field);
      page.node.set(N('Annots'), ctx.obj([fieldRef]));
      const form = ctx.obj({ Fields: [fieldRef], ...resources(ctx) });
      form.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'));
      page.doc.catalog.set(N('AcroForm'), ctx.register(form));
    });

  it('names a font a default appearance selects and the default resources do not hold', async () => {
    const bytes = await formWith((ctx) => ({ DR: { Font: { Other: helvetica(ctx) } } }), '/Field 10 Tf 0 g');
    expect(qpdfReading(bytes).missing).toEqual(['form /DA: /Font /Helv', 'field name /DA: /Font /Field']);
    await expect(expectSound(bytes)).rejects.toThrow();
  });

  it('names the font when the form has no default resources', async () => {
    expect(qpdfReading(await formWith(() => ({}))).missing).toEqual(['form /DA: /Font /Helv']);
  });

  it('counts each font the default resources resolve', async () => {
    const bytes = await formWith((ctx) => ({ DR: { Font: { Helv: helvetica(ctx), Field: helvetica(ctx) } } }), '/Field 10 Tf 0 g');
    expect(qpdfReading(bytes)).toMatchObject({ missing: [], used: { form_fonts: 2, form_resources: 2 } });
    await expectSound(bytes);
  });

  it('names a default resource entry that is no object, and the reference walk names one that is missing', async () => {
    const bytes = await formWith((ctx) => ({ DR: { Font: { Helv: helvetica(ctx), Number: 5 } } }));
    expect(qpdfReading(bytes).missing).toEqual(['form /DR /Font /Number: not an object']);
    const dangling = await formWith((ctx) => ({ DR: { Font: { Helv: helvetica(ctx), Gone: ctx.nextRef() } } }));
    await expect(expectSound(dangling)).rejects.toThrow();
  });
});
