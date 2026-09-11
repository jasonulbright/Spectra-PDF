import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import { testPython } from './support/python';

async function fixture() {
  const pdf = await PDFDocument.create(); const a = pdf.addPage(); const b = pdf.addPage();
  const field = pdf.getForm().createTextField('shared');
  field.addToPage(a); field.addToPage(b);
  for (const page of [a, b]) {
    page.node.Annots()!.push(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link',
      Rect: [10, 10, 50, 50], P: page.ref, A: { S: 'URI', URI: PDFString.of('https://example.com') } })));
    page.node.Annots()!.push(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 20, 30, 30] })));
  }
  return pdf.save();
}
async function owners(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes); let found = 0; let absent = 0;
  for (const page of pdf.getPages()) {
    for (const ref of page.node.lookup(PDFName.of('Annots'), PDFArray).asArray()) {
      const annot = pdf.context.lookup(ref, PDFDict); const owner = annot.get(PDFName.of('P'));
      if (!owner) { absent++; continue; }
      expect(owner.toString()).toBe(page.ref.toString()); found++;
    }
  }
  return { found, absent };
}
describe('rebuilt annotation owner identity', () => {
  it.each([[0, 1], [1, 0], [1], [0, 0, 1]].map(indices => ({ indices })))('points at actual output pages in order $indices', async ({ indices }) => {
    const bytes = await fixture(); const original = bytes.slice();
    const pages = indices.map(pageIndex => ({ bytes, sourceKey: 'source', pageIndex }));
    const out = await buildPdf(pages, bytes, 'source');
    expect(await owners(out)).toEqual({ found: indices.length * 2, absent: indices.length });
    expect(bytes).toEqual(original);
  });
  it('uses the same ownership rule in the multipart builder', async () => {
    const bytes = await fixture();
    const out = await buildPdfx([0, 1].map(pageIndex => ({ name: `Part ${pageIndex}`, pages: [{ bytes, pageIndex, sourceKey: 'source' }] })), 'Parts', bytes, 'source');
    expect(await owners(out)).toEqual({ found: 4, absent: 2 });
  });
  it('real incremental append preserves a signature after a builder comment/rotation', async () => {
    const source = resolve('e2e-tests/fixtures/signed.pdf');
    const original = new Uint8Array(readFileSync(source));
    const directory = mkdtempSync(resolve('annotation-owners.local.d-'));
    const python = testPython();
    for (const kind of ['comment', 'rotate'] as const) {
      const modified = resolve(directory, `${kind}.pdf`); const output = resolve(directory, `${kind}-out.pdf`);
      const pages = [{ bytes: original, sourceKey: source, pageIndex: 0,
        ...(kind === 'rotate' ? { rotation: 90 as const } : { annotations: [{ kind: 'highlight' as const, x: .2, y: .2, w: .3, h: .1, color: '#ffd54f' }] }) }];
      writeFileSync(modified, await buildPdf(pages, original, source));
      const report = JSON.parse(execFileSync(python, ['-B', '-c',
        'import json,sys; from engine.incremental import transplant_incremental; print(json.dumps(transplant_incremental(*sys.argv[1:])))', source, modified, output],
      { env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 15_000 }));
      expect(report, kind).toMatchObject({ applied: true });
      expect(readFileSync(output).subarray(0, original.length).equals(Buffer.from(original))).toBe(true);
    }
  // Two cold Python/crypto imports exceeded the unit-test default on hosted
  // runners. Keep each child bounded and allow both real append checks to finish.
  }, 40_000);
});
