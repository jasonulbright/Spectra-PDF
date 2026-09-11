import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { testPython } from './support/python';

const N = PDFName.of;
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
async function fixture(nested = false) {
  const doc = await PDFDocument.create({ updateMetadata: false }), ctx = doc.context;
  const page = doc.addPage([200, 200]);
  const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hidden plate') }));
  const resources = ctx.obj({ Properties: { Layer: group } });
  const paint = '/OC /Layer BDC 1 0 0 rg 0 0 100 100 re f EMC';
  if (nested) {
    const form = ctx.register(ctx.stream(paint, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: resources }));
    page.node.set(N('Resources'), ctx.obj({ XObject: { Plate: form } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/Plate Do')));
  } else {
    page.node.set(N('Resources'), resources);
    page.node.set(N('Contents'), ctx.register(ctx.stream(paint)));
  }
  const config = ctx.obj({ BaseState: 'ON', OFF: [group], Order: [group] });
  const props = ctx.obj({ OCGs: [group], D: config });
  doc.catalog.set(N('OCProperties'), props);
  return { doc, ctx, page, group, config, props };
}
function renderedGroup(doc: PDFDocument, index = 0, nested = false): PDFRef {
  let resources = doc.getPage(index).node.lookup(N('Resources'), PDFDict);
  if (nested) {
    const form = resources.lookup(N('XObject'), PDFDict).lookup(N('Plate'));
    if (!(form instanceof PDFRawStream)) throw new Error('Expected copied Form');
    resources = form.dict.lookup(N('Resources'), PDFDict);
  }
  return resources.lookup(N('Properties'), PDFDict).get(N('Layer')) as PDFRef;
}
const propsOf = (doc: PDFDocument) => doc.catalog.lookup(N('OCProperties'), PDFDict);
const exportPage = (bytes: Uint8Array, sourceKey = 'own') => ({ bytes, sourceKey, pageIndex: 0 });

describe('optional content through the publication builder', () => {
  it.each(['ON', 'OFF', 'omitted', 'alternate'])('keeps a signed layer declaration append-safe (%s)', async (mode) => {
    const f = await fixture();
    if (mode === 'OFF') f.config.set(N('BaseState'), N('OFF'));
    if (mode === 'omitted') f.config.delete(N('BaseState'));
    if (mode === 'alternate') f.props.set(N('Configs'), f.ctx.obj([{ Name: PDFString.of('Alternate'), BaseState: 'ON', ON: [f.group] }]));
    const directory = mkdtempSync(resolve('optional-content-signed.local.d-'));
    const input = resolve(directory, 'input.pdf'), signed = resolve(directory, 'signed.pdf');
    const modified = resolve(directory, 'modified.pdf'), output = resolve(directory, 'output.pdf');
    const python = (code: string, args: string[]) => execFileSync(testPython(), ['-B', '-c', code, ...args], {
      env: { ...process.env, PYTHONPATH: resolve('src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 30000,
    });
    writeFileSync(input, await f.doc.save());
    python('import sys; from engine.signatures import sign_pdf; sign_pdf(sys.argv[1],sys.argv[2],pfx_path=sys.argv[3],password="testpw")',
      [input, signed, resolve('e2e-tests/fixtures/test-signer.pfx')]);
    const bytes = new Uint8Array(readFileSync(signed));
    writeFileSync(modified, await buildPdf([{ bytes, sourceKey: signed, pageIndex: 0, rotation: 90 }], bytes, signed));
    const report = JSON.parse(python('import json,sys; from engine.incremental import transplant_incremental; print(json.dumps(transplant_incremental(*sys.argv[1:])))', [signed, modified, output]));
    expect(report).toMatchObject({ applied: true });
    expect(readFileSync(output).subarray(0, bytes.length)).toEqual(Buffer.from(bytes));
    const result = await load(readFileSync(output));
    expect(propsOf(result).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(renderedGroup(result));
    expect(result.getPage(0).getRotation().angle).toBe(90);
  }, 70000);
  it('binds a document layer action to the actual group in a nested Form', async () => {
    const f = await fixture(true);
    f.doc.catalog.set(N('OpenAction'), f.ctx.obj({ S: 'SetOCGState', State: ['ON', f.group] }));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([exportPage(bytes)], bytes, 'own'));
    expect(out.catalog.lookup(N('OpenAction'), PDFDict).lookup(N('State'), PDFArray).get(1)).toEqual(renderedGroup(out, 0, true));
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(renderedGroup(out, 0, true));
  });
  it('keeps a registry-only action target even when all owner pages are replaced', async () => {
    const f = await fixture(), donor = await fixture();
    f.doc.catalog.set(N('OpenAction'), f.ctx.obj({ S: 'SetOCGState', State: ['OFF', f.group] }));
    const own = await f.doc.save(), bytes = await donor.doc.save();
    const out = await load(await buildPdf([exportPage(bytes, 'donor')], own, 'own'));
    const target = out.catalog.lookup(N('OpenAction'), PDFDict).lookup(N('State'), PDFArray).get(1);
    expect(propsOf(out).lookup(N('OCGs'), PDFArray).asArray()).toContainEqual(target);
    expect(target).not.toEqual(renderedGroup(out));
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(renderedGroup(out));
  });
  it('carries hidden content for a page-only export without a document owner', async () => {
    const f = await fixture(), bytes = await f.doc.save();
    const out = await load(await buildPdf([exportPage(bytes, 'donor')]));
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(renderedGroup(out));
  });
  it('binds a layer action to the one shared layer across copied pages', async () => {
    const f = await fixture();
    f.doc.catalog.set(N('OpenAction'), f.ctx.obj({ S: 'SetOCGState', State: ['Toggle', f.group] }));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([exportPage(bytes), exportPage(bytes)], bytes, 'own'));
    const refs = [renderedGroup(out, 0), renderedGroup(out, 1)];
    expect(refs[0]).toEqual(refs[1]);
    expect(out.catalog.lookup(N('OpenAction'), PDFDict).lookup(N('State'), PDFArray).asArray()).toEqual([N('Toggle'), refs[0]]);
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toEqual([refs[0]]);
  });
  it('binds an opaque action edge without splitting the shared layer identity', async () => {
    const f = await fixture();
    f.doc.catalog.set(N('OpenAction'), f.ctx.obj({ S: 'Named', N: 'NextPage', PrivateGroup: f.group }));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([exportPage(bytes), exportPage(bytes)], bytes, 'own'));
    expect(renderedGroup(out, 0)).toEqual(renderedGroup(out, 1));
    expect(out.catalog.lookup(N('OpenAction'), PDFDict).get(N('PrivateGroup'))).toEqual(renderedGroup(out));
  });
  it('does not silently replace a conflicting layer presentation when inserting donor pages', async () => {
    const a = await fixture(), b = await fixture();
    a.config.set(N('ListMode'), N('VisiblePages')); b.config.set(N('ListMode'), N('AllPages'));
    const own = await a.doc.save(), donor = await b.doc.save();
    await expect(buildPdf([exportPage(own), exportPage(donor, 'donor')], own, 'own')).rejects.toThrow('verif');
  });
  it('keeps an existing hidden annotation hidden when a new comment is added', async () => {
    const f = await fixture();
    f.page.node.set(N('Resources'), f.ctx.obj({}));
    f.page.node.set(N('Contents'), f.ctx.register(f.ctx.stream('')));
    f.page.node.set(N('Annots'), f.ctx.obj([f.ctx.register(f.ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 20, 20], OC: f.group, Contents: PDFString.of('Hidden note') }))]));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([{ ...exportPage(bytes), annotations: [{ kind: 'highlight', x: .2, y: .2, w: .3, h: .1, color: '#ffd54f' }] }], bytes, 'own'));
    const annotations = out.getPage(0).node.lookup(N('Annots'), PDFArray);
    expect(annotations.size()).toBe(2);
    const group = annotations.lookup(0, PDFDict).get(N('OC'));
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(group);
  });
  it('does not mistake ordinary marked-content properties for an invalid layer', async () => {
    const f = await fixture();
    f.page.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Language'), f.ctx.register(f.ctx.obj({ Lang: PDFString.of('en-US'), ActualText: PDFString.of('ordinary text') })));
    f.page.node.set(N('Contents'), f.ctx.register(f.ctx.stream('/Span /Language BDC EMC')));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([exportPage(bytes)], bytes, 'own'));
    expect(out.getPage(0).node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).lookup(N('Language'), PDFDict).lookup(N('Lang'), PDFString).decodeText()).toBe('en-US');
  });
  it('preserves the layer gate when reauthoring an imported annotation', async () => {
    const f = await fixture();
    f.page.node.set(N('Resources'), f.ctx.obj({}));
    f.page.node.set(N('Contents'), f.ctx.register(f.ctx.stream('')));
    f.page.node.set(N('Annots'), f.ctx.obj([f.ctx.register(f.ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 20, 20], OC: f.group, Contents: PDFString.of('Hidden square') }))]));
    const bytes = await f.doc.save();
    const out = await load(await buildPdf([{ ...exportPage(bytes), annotations: [{ kind: 'highlight', x: .1, y: .1, w: .2, h: .2, color: '#ffd54f', note: 'Edited hidden square', importedOriginal: { subtype: 'Square', rect: [0, 0, 20, 20], contents: 'Hidden square' } }] }], bytes, 'own'));
    const annotations = out.getPage(0).node.lookup(N('Annots'), PDFArray);
    expect(annotations.size()).toBe(1);
    const group = annotations.lookup(0, PDFDict).get(N('OC'));
    expect(group).toBeInstanceOf(PDFRef);
    expect(propsOf(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(group);
  });
  it('keeps every copied occurrence visible when a radio-group action turns its source layer on', async () => {
    const f = await fixture(), other = f.ctx.register(f.ctx.obj({ Type: 'OCG', Name: PDFString.of('Other plate') }));
    f.props.set(N('OCGs'), f.ctx.obj([f.group, other]));
    f.config.set(N('RBGroups'), f.ctx.obj([[f.group, other]]));
    f.config.set(N('Order'), f.ctx.obj([f.group, other]));
    f.page.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Other'), other);
    const source = await f.doc.save();
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    async function visibleAfterAction(bytes: Uint8Array) {
      const task = getDocument({ data: bytes.slice() });
      const document = await task.promise;
      try {
        const config = await document.getOptionalContentConfig();
        const targets: string[] = [];
        for (const [id, group] of config) if (group.name === 'Hidden plate') targets.push(id);
        expect(targets.length).toBeGreaterThan(0);
        config.setOCGState({ state: ['ON', ...targets], preserveRB: true });
        return targets.map(id => config.getGroup(id).visible);
      } finally { await task.destroy(); }
    }
    expect(await visibleAfterAction(source)).toEqual([true]);
    const output = await buildPdf([exportPage(source), exportPage(source)], source, 'own');
    expect((await visibleAfterAction(output)).every(Boolean)).toBe(true);
  });
});
