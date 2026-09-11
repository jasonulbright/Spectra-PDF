import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  selectCanvasPages,
  getWorkspacePageIds,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
  deleteSelectedCanvasPages,
  getCanvasDocs,
  importPagesIntoDoc,
  waitForActiveCanvasPageIds,
  deleteCanvasPagesAndWait,
  signActiveFileInPlace,
  setView,
  setActiveOp,
  focusTab,
  getSelectedCanvasPageIds,
} from '../support/harness.js';

// The catalog carry (lib/catalog-carry.ts): bookmarks and page labels
// survive a COMMITTED page edit. Before the carry, one committed rotation
// silently deleted /Outlines and /PageLabels (with /Lang, /ViewerPreferences
// and the layers config — those are pinned at the vitest level, where OCG
// reference identity can be asserted directly). The fixture is enriched
// through the REAL CLI arms and read back through them — no mocks anywhere.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

async function taggedSource(role: 'P' | 'H1', sameNamespace: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false }), ctx = pdf.context, N = PDFName.of;
  const page = pdf.addPage([300, 700]), root = ctx.obj({ Type: 'StructTreeRoot' }), rootRef = ctx.register(root);
  const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFHexString.fromText(sameNamespace ? 'urn:shared' : `urn:live:${role}`), RoleMapNS: { Local: role } }));
  const element = ctx.obj({ S: 'Local', NS: ns, P: rootRef, Pg: page.ref, K: 0, ID: PDFString.of('same-id'),
    Alt: PDFHexString.fromText(`${role} — résumé`), R: 2, C: 'Shared' });
  const ref = ctx.register(element);
  page.node.set(N('Contents'), ctx.register(ctx.stream('/Local <</MCID 0>> BDC 0 0 10 10 re f EMC')));
  page.node.set(N('StructParents'), PDFNumber.of(0));
  root.set(N('K'), ctx.obj([ref])); root.set(N('Namespaces'), ctx.obj([ns]));
  root.set(N('ClassMap'), ctx.obj({ Shared: { O: 'Layout', TextAlign: role === 'P' ? 'Start' : 'End' } }));
  root.set(N('ParentTree'), ctx.obj({ Nums: [0, ctx.obj([ref])] })); root.set(N('ParentTreeNextKey'), PDFNumber.of(1));
  pdf.catalog.set(N('StructTreeRoot'), rootRef); pdf.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true, Suspects: true }));
  pdf.catalog.set(N('Version'), N('2.0'));
  return pdf.save();
}

let TMP = '';

function cliJson(args: string[]): unknown {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  const lines = out.trim().split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.slice(start).join('\n'));
}

describe('catalog state survives committed page edits', () => {
  before(async () => {
    TMP = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-catalog-'));
    await waitForHarness();
  });

  after(() => {
    if (TMP && existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('bookmarks and page labels ride through a committed rotation', async () => {
    // Enrich a scratch copy through the real CLI: one bookmark to page 2 and
    // roman-numeral labels from page 1.
    const src = resolve(TMP, 'rich.pdf');
    copyFileSync(SAMPLE_PDF, src);
    const outlined = resolve(TMP, 'outlined.pdf');
    const outlineJson = resolve(TMP, 'outline.json');
    writeFileSync(
      outlineJson,
      JSON.stringify({ outline: [{ title: 'Catalog Carry Marker', page: 2, children: [] }] }),
    );
    execFileSync(APP_EXE, ['outline', src, '--from-json', outlineJson, '-o', outlined], {
      stdio: 'pipe',
    });
    const labeled = resolve(TMP, 'labeled.pdf');
    execFileSync(APP_EXE, ['page-labels', outlined, '-o', labeled, '--range', '1:r'], {
      stdio: 'pipe',
    });

    await openByPaths([labeled]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the enriched file did not land on canvas',
    });
    const ids = await getWorkspacePageIds();
    await selectCanvasPages([ids[0]]);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits();

    const dest = resolve(TMP, 'committed.pdf');
    await saveActiveAs(dest);

    // The bookmark survived, still pointing at page 2 — read back through
    // the same CLI arm that wrote it.
    const outline = cliJson(['outline', dest]) as {
      outline: { title: string; page: number }[];
    };
    expect(outline.outline.length).toBe(1);
    expect(outline.outline[0].title).toBe('Catalog Carry Marker');
    expect(outline.outline[0].page).toBe(2);

    // The label range survived (structure pinned semantically in vitest —
    // here the committed file must still carry the roman range at all).
    const bytes = readFileSync(dest);
    expect(bytes.includes('/PageLabels')).toBe(true);
  });

  for (const removeSelected of [false, true]) it(`preserves print/bookmark/Info identity, or refuses loss (remove selected=${removeSelected})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../catalog-metadata-live.local.d-'));
    const path = resolve(dir, 'source.pdf'), N = PDFName.of;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    for (const width of [300, 400, 500]) pdf.addPage([width, 700]);
    pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [2, 2], DisplayDocTitle: true }));
    const info = pdf.context.obj({ Title: PDFString.of('Own document'), Author: PDFString.of('Original author'),
      Private: PDFString.of('Private value'), CreationDate: PDFString.of('D:2020') });
    pdf.context.trailerInfo.Info = pdf.context.register(info);
    const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }), rootRef = pdf.context.register(root);
    const item = pdf.context.obj({ Parent: rootRef, Title: PDFString.of('Preserved only, never opened'),
      A: { S: 'URI', URI: PDFString.of('https://example.invalid/manual') }, F: 2, C: [1, 0, 0] });
    const ref = pdf.context.register(item); root.set(N('First'), ref); root.set(N('Last'), ref); pdf.catalog.set(N('Outlines'), rootRef);
    const original = Buffer.from(await pdf.save()); writeFileSync(path, original);
    await closeAllFiles(); await openByPaths([path]);
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    const ids = await waitForActiveCanvasPageIds(); expect(ids).toHaveLength(3);
    await deleteCanvasPagesAndWait([ids[removeSelected ? 1 : 0]]);
    if (removeSelected) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('commitPendingEdits failed'); expect(error).toContain('verif');
      expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 3);
    } else {
      await commitPendingEdits(); const saved = resolve(dir, 'saved.pdf'); await saveActiveAs(saved);
      const out = await PDFDocument.load(readFileSync(saved), { updateMetadata: false });
      const range = out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('PrintPageRange'), PDFArray);
      expect(range.asArray().map(x => (x as PDFNumber).asNumber())).toEqual([1, 1]);
      expect(out.getPage(0).getWidth()).toBe(400);
      expect(out.getTitle()).toBe('Own document'); expect(out.getAuthor()).toBe('Original author');
      const carried = out.context.lookup(out.context.trailerInfo.Info!, PDFDict);
      expect(carried.lookup(N('Private'), PDFString).decodeText()).toBe('Private value');
      expect(carried.lookup(N('CreationDate'), PDFString).asString()).toBe('D:2020');
      const bookmark = out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);
      expect(bookmark.lookup(N('A'), PDFDict).lookup(N('URI'), PDFString).decodeText()).toBe('https://example.invalid/manual');
      expect(bookmark.lookup(N('F'), PDFNumber).asNumber()).toBe(2);
      expect(bookmark.lookup(N('C'), PDFArray).asArray().map(x => (x as PDFNumber).asNumber())).toEqual([1, 0, 0]);
    }
    expect(readFileSync(path).equals(original)).toBe(true);
  });
  for (const keepOwn of [true, false]) it(`keeps document language, preferences and dates with ${keepOwn ? 'one original page' : 'only imported pages'}`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/catalog-owner-live.local.d-'));
    const own = resolve(dir, 'own.pdf'), donor = resolve(dir, 'donor.pdf'), N = PDFName.of;
    for (const [path, language, count] of [[own, 'de-DE', 2], [donor, 'fr-FR', 1]] as const) {
      const pdf = await PDFDocument.create(); for (let i = 0; i < count; i++) pdf.addPage([600 + i * 10, 800]);
      pdf.catalog.set(N('Lang'), PDFString.of(language));
      pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ DisplayDocTitle: path === own }));
      pdf.setCreationDate(new Date(path === own ? '2001-02-03T04:05:06Z' : '2011-01-01T00:00:00Z'));
      pdf.setModificationDate(new Date(path === own ? '2002-03-04T05:06:07Z' : '2012-01-01T00:00:00Z'));
      writeFileSync(path, await pdf.save());
    }
    await closeAllFiles(); await openByPaths([own]);
    const doc = (await getCanvasDocs())[0], originalIds = await getWorkspacePageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await importPagesIntoDoc(donor, doc.id, 2); await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 3);
    await selectCanvasPages(keepOwn ? [originalIds[0]] : originalIds); await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === (keepOwn ? 2 : 1));
    await commitPendingEdits(); const out = await PDFDocument.load(readFileSync(work), { updateMetadata: false });
    expect(out.getPageCount()).toBe(keepOwn ? 2 : 1);
    expect(out.catalog.lookup(N('Lang'), PDFString).decodeText()).toBe('de-DE');
    expect(out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('DisplayDocTitle'), PDFBool).asBoolean()).toBe(true);
    expect(out.getCreationDate()?.toISOString()).toBe('2001-02-03T04:05:06.000Z');
    expect(out.getModificationDate()?.toISOString()).toBe('2002-03-04T05:06:07.000Z');
    expect(readFileSync(own).equals(before)).toBe(true);
  });

  for (const malformed of [false, true]) it(`preserves XMP through the actual browser worker, or refuses atomically (malformed=${malformed})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../xmp-live.local.d-')), path = resolve(dir, 'source.pdf'), N = PDFName.of;
    const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:m="https://example.invalid/matter/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><m:MatterID>Live-é-2026-143</m:MatterID><pdf:Producer>Original tool</pdf:Producer></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const pdf = await PDFDocument.create({ updateMetadata: false }); pdf.addPage([300, 700]); pdf.addPage([400, 700]);
    pdf.catalog.set(N('Metadata'), pdf.context.register(pdf.context.flateStream(new TextEncoder().encode(malformed ? packet.replace('</rdf:RDF>', '') : packet), { Type: 'Metadata', Subtype: 'XML' })));
    const original = Buffer.from(await pdf.save()); writeFileSync(path, original);
    await closeAllFiles(); await openByPaths([path]); const ids = await waitForActiveCanvasPageIds(); expect(ids).toHaveLength(2);
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await selectCanvasPages([ids[0]]); expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    if (malformed) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('verif'); expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
    } else {
      await commitPendingEdits(); const dest = resolve(dir, 'saved.pdf'); await saveActiveAs(dest);
      const saved = await PDFDocument.load(readFileSync(dest), { updateMetadata: false });
      expect(saved.getPage(0).getRotation().angle).toBe(90);
      const stream = saved.catalog.lookup(N('Metadata')); expect(stream).toBeInstanceOf(PDFRawStream);
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream as PDFRawStream).decode());
      expect(xml).toContain('Live-é-2026-143'); expect(xml).toContain(`PDFX`); expect(xml).not.toContain('Original tool');
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => {
        const restored = await PDFDocument.load(readFileSync(work), { updateMetadata: false });
        return restored.getPage(0).getRotation().angle === 0;
      });
    }
    expect(readFileSync(path).equals(original)).toBe(true);
  });
  it('a signed page edit keeps XMP, output profile and the signed byte prefix', async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../xmp-signed-live.local.d-')), path = resolve(dir, 'source.pdf'), N = PDFName.of;
    const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:m="https://example.invalid/matter/"><m:MatterID>Signed-metadata-143</m:MatterID></rdf:Description></rdf:RDF></x:xmpmeta>';
    const pdf = await PDFDocument.create({ updateMetadata: false }); pdf.addPage([300, 700]);
    pdf.catalog.set(N('Metadata'), pdf.context.register(pdf.context.flateStream(new TextEncoder().encode(xml), { Type: 'Metadata', Subtype: 'XML' })));
    const profile = new Uint8Array(readFileSync(resolve(__dirname, '../../resources/icc/USWebCoatedSWOP.icc')));
    pdf.catalog.set(N('OutputIntents'), pdf.context.obj([pdf.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFX',
      OutputConditionIdentifier: PDFString.of('U.S. Web Coated (SWOP)'), DestOutputProfile: pdf.context.register(pdf.context.flateStream(profile, { N: 4 })) })]));
    writeFileSync(path, await pdf.save()); await closeAllFiles(); await openByPaths([path]);
    await setView('operations'); await setActiveOp('signatures');
    await signActiveFileInPlace({ pfxPath: resolve(__dirname, '../fixtures/test-signer.pfx'), password: 'testpw' });
    const work = (await getState()).activeFile!.workingPath, signed = readFileSync(work);
    await setView('canvas'); await focusTab({ doc: path });
    // Signing replaces the buffer; select only a still-live post-signing page.
    await browser.waitUntil(async () => {
      const ids = await waitForActiveCanvasPageIds();
      await selectCanvasPages([ids[0]]);
      const selected = await getSelectedCanvasPageIds(), live = await getWorkspacePageIds();
      return selected.length === 1 && selected[0] === ids[0] && live.includes(ids[0]);
    }, { timeout: 30_000, timeoutMsg: 'signed document did not settle into a selectable canvas page' });
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true); await commitPendingEdits();
    const saved = readFileSync(work); expect(saved.subarray(0, signed.length).equals(signed)).toBe(true);
    const out = await PDFDocument.load(saved, { updateMetadata: false }); expect(out.getPage(0).getRotation().angle).toBe(90);
    const metadata = out.catalog.lookup(N('Metadata')); expect(metadata).toBeInstanceOf(PDFRawStream);
    expect(new TextDecoder().decode(decodePDFRawStream(metadata as PDFRawStream).decode())).toContain('Signed-metadata-143');
    const carriedProfile = out.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict).lookup(N('DestOutputProfile'));
    expect(carriedProfile).toBeInstanceOf(PDFRawStream);
    expect(decodePDFRawStream(carriedProfile as PDFRawStream).decode()).toEqual(profile);
    const checked = cliJson(['verify-signatures', work]) as { signatures: { intact: boolean; valid: boolean }[] }; expect(checked.signatures).toHaveLength(1);
    expect(checked.signatures[0].intact).toBe(true); expect(checked.signatures[0].valid).toBe(true);
  });
  for (const malformed of [false, true]) it(`preserves the actual output profile or refuses without publication (malformed=${malformed})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../output-intent-live.local.d-')), path = resolve(dir, 'source.pdf'), N = PDFName.of;
    const profile = new Uint8Array(readFileSync(resolve(__dirname, '../../resources/icc/USWebCoatedSWOP.icc')));
    expect(new TextDecoder().decode(profile.slice(36, 40))).toBe('acsp');
    const pdf = await PDFDocument.create({ updateMetadata: false }); pdf.addPage([300, 700]);
    pdf.catalog.set(N('OutputIntents'), malformed ? PDFString.of('not an intent array') : pdf.context.obj([
      pdf.context.register(pdf.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('U.S. Web Coated (SWOP)'),
        DestOutputProfile: pdf.context.register(pdf.context.flateStream(profile, { N: 4 })) })),
    ]));
    const original = Buffer.from(await pdf.save()); writeFileSync(path, original);
    await closeAllFiles(); await openByPaths([path]); const ids = await waitForActiveCanvasPageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await selectCanvasPages([ids[0]]); expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    if (malformed) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('verif'); expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
    } else {
      await commitPendingEdits(); const dest = resolve(dir, 'saved.pdf'); await saveActiveAs(dest);
      const saved = await PDFDocument.load(readFileSync(dest), { updateMetadata: false });
      const intent = saved.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict);
      expect(intent.lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe('U.S. Web Coated (SWOP)');
      const stream = intent.lookup(N('DestOutputProfile')); expect(stream).toBeInstanceOf(PDFRawStream);
      expect(decodePDFRawStream(stream as PDFRawStream).decode()).toEqual(profile);
      expect(saved.getPage(0).getRotation().angle).toBe(90);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await PDFDocument.load(readFileSync(work), { updateMetadata: false })).getPage(0).getRotation().angle === 0);
    }
    expect(readFileSync(path).equals(original)).toBe(true);
  });

  for (const conflict of [false, true]) it(`preserves imported tag meanings or refuses their conflict atomically (conflict=${conflict})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../tag-semantics-live.local.d-'));
    const own = resolve(dir, 'own.pdf'), donor = resolve(dir, 'donor.pdf'), N = PDFName.of;
    const originals = [Buffer.from(await taggedSource('P', conflict)), Buffer.from(await taggedSource('H1', conflict))];
    writeFileSync(own, originals[0]); writeFileSync(donor, originals[1]);
    await closeAllFiles(); await openByPaths([own]); await waitForActiveCanvasPageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await importPagesIntoDoc(donor, (await getCanvasDocs())[0].id, 1);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    if (conflict) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('verif'); expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    } else {
      await commitPendingEdits();
      const saved = readFileSync(work), out = await PDFDocument.load(saved, { updateMetadata: false });
      expect(saved.subarray(0, 8).toString()).toBe('%PDF-2.0');
      const root = out.catalog.lookup(N('StructTreeRoot'), PDFDict), kids = root.lookup(N('K'), PDFArray);
      expect(kids.size()).toBe(2);
      const list = kids.asArray().map(v => out.context.lookup(v, PDFDict));
      expect(list.map(e => e.lookup(N('NS'), PDFDict).lookup(N('RoleMapNS'), PDFDict).lookup(e.lookup(N('S'), PDFName), PDFName).decodeText())).toEqual(['P', 'H1']);
      expect(list.map(e => e.lookup(N('Alt'), PDFHexString).decodeText())).toEqual(['P — résumé', 'H1 — résumé']);
      expect(list.map(e => e.lookup(N('R'), PDFNumber).asNumber())).toEqual([2, 2]);
      const classes = root.lookup(N('ClassMap'), PDFDict);
      expect(list.map(e => classes.lookup(e.lookup(N('C'), PDFName), PDFDict).lookup(N('TextAlign'), PDFName).decodeText())).toEqual(['Start', 'End']);
      expect(new Set(list.map(e => Buffer.from((e.lookup(N('ID')) as PDFString | PDFHexString).asBytes()).toString('hex'))).size).toBe(2);
      expect(list.map(e => (e.get(N('Pg')) as PDFRef).tag)).toEqual(out.getPages().map(p => p.ref.tag));
      const parents = root.lookup(N('ParentTree'), PDFDict).lookup(N('Nums'), PDFArray);
      for (let i = 0; i < 2; i++) {
        const key = out.getPage(i).node.lookup(N('StructParents'), PDFNumber).asNumber();
        const slot = parents.asArray().findIndex((v, j) => j % 2 === 0 && (v as PDFNumber).asNumber() === key);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(parents.lookup(slot + 1, PDFArray).get(0)).toEqual(kids.get(i));
      }
      expect(out.catalog.lookup(N('MarkInfo'), PDFDict).lookup(N('Suspects'), PDFBool).asBoolean()).toBe(true);
    }
    expect(readFileSync(own).equals(originals[0])).toBe(true); expect(readFileSync(donor).equals(originals[1])).toBe(true);
  });

  for (const conflict of [false, true]) it(`keeps format and extension declarations through publication (conflict=${conflict})`, async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../format-declarations-live.local.d-'));
    const own = resolve(dir, 'own.pdf'), donor = resolve(dir, 'donor.pdf'), N = PDFName.of;
    const originals: Buffer[] = [];
    for (const [i, path] of [own, donor].entries()) {
      const doc = await PDFDocument.create({ updateMetadata: false }); doc.addPage([300 + i * 100, 700]);
      doc.catalog.set(N('Extensions'), doc.context.obj({ ADBE: { BaseVersion: '1.7', ExtensionLevel: conflict ? 3 : 3 + i, Private: i } }));
      const bytes = Buffer.from(await doc.save()); bytes.set(Buffer.from('%PDF-2.0'), 0); originals.push(bytes); writeFileSync(path, bytes);
    }
    await closeAllFiles(); await openByPaths([own]); await waitForActiveCanvasPageIds();
    const work = (await getState()).activeFile!.workingPath, before = readFileSync(work);
    await importPagesIntoDoc(donor, (await getCanvasDocs())[0].id, 1);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 2);
    if (conflict) {
      let error = ''; try { await commitPendingEdits(); } catch (caught) { error = String(caught); }
      expect(error).toContain('verif'); expect(readFileSync(work).equals(before)).toBe(true);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 1);
    } else {
      await commitPendingEdits(); const dest = resolve(dir, 'saved.pdf'); await saveActiveAs(dest);
      const bytes = readFileSync(dest), out = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(bytes.subarray(0, 8).toString()).toBe('%PDF-2.0'); expect(out.catalog.lookup(N('Version'), PDFName).decodeText()).toBe('2.0');
      const entries = out.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'), PDFArray);
      expect(entries.asArray().map(v => (v as PDFDict).lookup(N('ExtensionLevel'), PDFNumber).asNumber())).toEqual([3, 4]);
      expect(entries.asArray().map(v => (v as PDFDict).lookup(N('Private'), PDFNumber).asNumber())).toEqual([0, 1]);
    }
    expect(readFileSync(own).equals(originals[0])).toBe(true); expect(readFileSync(donor).equals(originals[1])).toBe(true);
  });

  it('raises the effective version for an imported PDF 2.0 page while keeping a valid signed prefix', async () => {
    const dir = mkdtempSync(resolve(__dirname, '../../format-signed-live.local.d-'));
    const own = resolve(dir, 'signed.pdf'), donor = resolve(dir, 'donor.pdf'), N = PDFName.of;
    copyFileSync(resolve(__dirname, '../fixtures/signed.pdf'), own);
    const signed = readFileSync(own), original = await PDFDocument.load(signed, { updateMetadata: false });
    expect(original.catalog.lookup(N('Version'), PDFName).decodeText()).toBe('1.7');
    const source = await PDFDocument.create({ updateMetadata: false }); source.addPage([300, 700]);
    const profile = new Uint8Array(readFileSync(resolve(__dirname, '../../resources/icc/USWebCoatedSWOP.icc')));
    source.getPage(0).node.set(N('OutputIntents'), source.context.obj([source.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFX',
      OutputConditionIdentifier: PDFString.of('Page-local live profile'), DestOutputProfile: source.context.register(source.context.flateStream(profile, { N: 4 })) })]));
    const donorBytes = Buffer.from(await source.save()); donorBytes.set(Buffer.from('%PDF-2.0'), 0); writeFileSync(donor, donorBytes);
    await closeAllFiles(); await openByPaths([own]); await waitForActiveCanvasPageIds();
    const count = original.getPageCount();
    await importPagesIntoDoc(donor, (await getCanvasDocs())[0].id, count);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === count + 1);
    await commitPendingEdits(); const work = (await getState()).activeFile!.workingPath, saved = readFileSync(work);
    expect(saved.subarray(0, signed.length).equals(signed)).toBe(true);
    const out = await PDFDocument.load(saved, { updateMetadata: false });
    expect(out.catalog.lookup(N('Version'), PDFName).decodeText()).toBe('2.0'); expect(out.getPageCount()).toBe(count + 1);
    const carried = out.getPage(count).node.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict).lookup(N('DestOutputProfile'));
    expect(carried).toBeInstanceOf(PDFRawStream); expect(decodePDFRawStream(carried as PDFRawStream).decode()).toEqual(profile);
    const checked = cliJson(['verify-signatures', work]) as { signatures: { intact: boolean; valid: boolean }[] };
    expect(checked.signatures).toHaveLength(1); expect(checked.signatures[0].intact).toBe(true); expect(checked.signatures[0].valid).toBe(true);
    expect(readFileSync(own).equals(signed)).toBe(true); expect(readFileSync(donor).equals(donorBytes)).toBe(true);
  });
});
