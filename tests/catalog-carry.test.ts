// The catalog carry (lib/catalog-carry.ts): /Lang, /ViewerPreferences,
// /Outlines, /PageLabels, and /OCProperties survive the from-scratch commit
// rebuild. Before the carry, ONE committed page edit silently deleted every
// bookmark, page label, the layer configuration, the document language and
// viewer preferences — the same loss class as the /AcroForm and
// /Names /EmbeddedFiles drops (found by inspection).
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import { carryDocumentBehavior } from '../src/renderer/lib/catalog-carry';

const N = PDFName.of.bind(PDFName);

const pageOf = (bytes: Uint8Array, index: number, sourceKey = 'own'): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex: index,
});

const text = (v: unknown): string =>
  v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v);

/** Four pages carrying every catalog feature the carry covers. */
async function richSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([200, 200]);
  const ctx = doc.context;
  const pages = doc.getPages();

  doc.catalog.set(N('Lang'), PDFString.of('de-DE'));
  doc.catalog.set(N('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));

  // Page labels: roman front matter (i, ii) then 'A-' decimal body.
  doc.catalog.set(
    N('PageLabels'),
    ctx.obj({ Nums: [0, ctx.obj({ S: 'r' }), 2, ctx.obj({ S: 'D', St: 1, P: PDFString.of('A-') })] }),
  );

  // Outline: Intro → page0, Body → page2 with child Detail → page3.
  const root = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(root);
  const intro = ctx.obj({ Title: PDFString.of('Intro') });
  const introRef = ctx.register(intro);
  intro.set(N('Parent'), rootRef);
  intro.set(N('Dest'), ctx.obj([pages[0].ref, 'Fit']));
  const body = ctx.obj({ Title: PDFString.of('Body') });
  const bodyRef = ctx.register(body);
  body.set(N('Parent'), rootRef);
  body.set(N('Dest'), ctx.obj([pages[2].ref, 'Fit']));
  const detail = ctx.obj({ Title: PDFString.of('Detail') });
  const detailRef = ctx.register(detail);
  detail.set(N('Parent'), bodyRef);
  detail.set(N('Dest'), ctx.obj([pages[3].ref, 'Fit']));
  body.set(N('First'), detailRef);
  body.set(N('Last'), detailRef);
  body.set(N('Count'), PDFNumber.of(1));
  intro.set(N('Next'), bodyRef);
  body.set(N('Prev'), introRef);
  root.set(N('First'), introRef);
  root.set(N('Last'), bodyRef);
  root.set(N('Count'), PDFNumber.of(3));
  doc.catalog.set(N('Outlines'), rootRef);

  // One OCG, used from page 1's resources, configured OFF.
  const ocg = ctx.obj({ Type: 'OCG', Name: PDFString.of('Watermarks') });
  const ocgRef = ctx.register(ocg);
  const props = ctx.obj({});
  props.set(N('MC0'), ocgRef);
  const resources = pages[1].node.lookupMaybe(N('Resources'), PDFDict) ?? ctx.obj({});
  resources.set(N('Properties'), props);
  pages[1].node.set(N('Resources'), resources);
  const ocProps = ctx.obj({});
  ocProps.set(N('OCGs'), ctx.obj([ocgRef]));
  const d = ctx.obj({});
  d.set(N('Order'), ctx.obj([ocgRef]));
  d.set(N('OFF'), ctx.obj([ocgRef]));
  ocProps.set(N('D'), d);
  doc.catalog.set(N('OCProperties'), ocProps);

  return doc.save();
}

async function plainSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

async function rebuild(pages: ExportPage[], ownSourceKey = 'own'): Promise<PDFDocument> {
  const bytes = await buildPdf(pages, undefined, ownSourceKey);
  return PDFDocument.load(bytes);
}

function outlineChildren(doc: PDFDocument, node: PDFDict): PDFDict[] {
  const out: PDFDict[] = [];
  let child = node.lookupMaybe(N('First'), PDFDict);
  while (child) {
    out.push(child);
    child = child.lookupMaybe(N('Next'), PDFDict);
  }
  return out;
}

function numsOf(doc: PDFDocument): { index: number; dict: PDFDict }[] {
  const labels = doc.catalog.lookupMaybe(N('PageLabels'), PDFDict);
  const nums = labels?.lookupMaybe(N('Nums'), PDFArray);
  if (!nums) return [];
  const out: { index: number; dict: PDFDict }[] = [];
  for (let i = 0; i + 1 < nums.size(); i += 2) {
    out.push({
      index: (nums.lookup(i) as PDFNumber).asNumber(),
      dict: nums.lookupMaybe(i + 1, PDFDict)!,
    });
  }
  return out;
}

describe('catalog carry — /Lang and /ViewerPreferences', () => {
  it('both survive a rebuild', async () => {
    const src = await richSource();
    const out = await rebuild([0, 1, 2, 3].map((i) => pageOf(src, i)));
    expect(text(out.catalog.lookup(N('Lang')))).toBe('de-DE');
    const vp = out.catalog.lookupMaybe(N('ViewerPreferences'), PDFDict);
    expect(vp?.lookup(N('DisplayDocTitle'))).toBe(PDFBool.True);
  });

  it('a plain document gains none of the carried keys', async () => {
    const src = await plainSource();
    const out = await rebuild([pageOf(src, 0)]);
    for (const key of ['Lang', 'ViewerPreferences', 'Outlines', 'PageLabels', 'OCProperties', 'StructTreeRoot', 'MarkInfo']) {
      expect(out.catalog.get(N(key))).toBeUndefined();
    }
  });
});

describe('catalog carry — /Outlines', () => {
  it('dests remap through reorder; an item whose page was deleted keeps its title, loses the jump', async () => {
    const src = await richSource();
    // Page 0 deleted; order 2,3,1 — Intro's target is gone, Body → output
    // page 0, Detail → output page 1.
    const out = await rebuild([pageOf(src, 2), pageOf(src, 3), pageOf(src, 1)]);
    const outPages = out.getPages();
    const outlines = out.catalog.lookupMaybe(N('Outlines'), PDFDict);
    expect(outlines).toBeDefined();
    const tops = outlineChildren(out, outlines!);
    expect(tops.map((t) => text(t.lookup(N('Title'))))).toEqual(['Intro', 'Body']);
    expect(tops[0].get(N('Dest'))).toBeUndefined(); // page gone — no jump
    const bodyDest = tops[1].lookupMaybe(N('Dest'), PDFArray);
    expect(bodyDest?.get(0)).toEqual(outPages[0].ref);
    const detail = outlineChildren(out, tops[1]);
    expect(detail.map((t) => text(t.lookup(N('Title'))))).toEqual(['Detail']);
    const detailDest = detail[0].lookupMaybe(N('Dest'), PDFArray);
    expect(detailDest?.get(0)).toEqual(outPages[1].ref);
  });
});

describe('catalog carry — /PageLabels', () => {
  it('ranges re-base across a deletion', async () => {
    const src = await richSource();
    // Delete page 0 (was label i). Page1 was ii → new range r St 2; pages
    // 2,3 were A-1, A-2 → one range at position 1.
    const out = await rebuild([pageOf(src, 1), pageOf(src, 2), pageOf(src, 3)]);
    const nums = numsOf(out);
    expect(nums.map((n) => n.index)).toEqual([0, 1]);
    expect(text(nums[0].dict.lookup(N('S')))).toBe('/r');
    expect((nums[0].dict.lookup(N('St')) as PDFNumber).asNumber()).toBe(2);
    expect(text(nums[1].dict.lookup(N('S')))).toBe('/D');
    expect(text(nums[1].dict.lookup(N('P')))).toBe('A-');
    expect((nums[1].dict.lookup(N('St')) as PDFNumber).asNumber()).toBe(1);
  });

  it('a donor page breaks own ranges with plain position numbering', async () => {
    const own = await richSource();
    const donor = await plainSource();
    const out = await rebuild([
      pageOf(own, 0),
      pageOf(donor, 0, 'donor'),
      pageOf(own, 1),
    ]);
    const nums = numsOf(out);
    expect(nums.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(text(nums[0].dict.lookup(N('S')))).toBe('/r');
    expect(text(nums[1].dict.lookup(N('S')))).toBe('/D');
    expect((nums[1].dict.lookup(N('St')) as PDFNumber).asNumber()).toBe(2);
    expect(text(nums[2].dict.lookup(N('S')))).toBe('/r');
    expect((nums[2].dict.lookup(N('St')) as PDFNumber).asNumber()).toBe(2);
  });
});

describe('catalog carry — /OCProperties', () => {
  it('the configured OCG is THE one reachable from the copied page resources; OFF survives', async () => {
    const src = await richSource();
    const out = await rebuild([pageOf(src, 0), pageOf(src, 1)]);
    const ocProps = out.catalog.lookupMaybe(N('OCProperties'), PDFDict);
    expect(ocProps).toBeDefined();
    const ocgs = ocProps!.lookupMaybe(N('OCGs'), PDFArray);
    expect(ocgs?.size()).toBe(1);
    const carried = ocgs!.get(0) as PDFRef;

    const outPage1 = out.getPages()[1];
    const resources = outPage1.node.lookupMaybe(N('Resources'), PDFDict);
    const props = resources?.lookupMaybe(N('Properties'), PDFDict);
    expect(props?.get(N('MC0'))).toEqual(carried);

    const d = ocProps!.lookupMaybe(N('D'), PDFDict);
    const off = d?.lookupMaybe(N('OFF'), PDFArray);
    expect(off?.size()).toBe(1);
    expect(off!.get(0)).toEqual(carried);
    const name = (out.context.lookup(carried) as PDFDict).lookup(N('Name'));
    expect(text(name)).toBe('Watermarks');
  });

  it('dropping every layer-using page retains the document-owned registry and state', async () => {
    const src = await richSource();
    const out = await rebuild([pageOf(src, 0)]); // page 1 (the OCG user) gone
    const props = out.catalog.lookup(N('OCProperties'), PDFDict);
    const group = props.lookup(N('OCGs'), PDFArray).get(0);
    expect(props.lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toEqual([group]);
  });
});

describe('catalog carry — own-source only', () => {
  it("a donor's bookmarks are not imported", async () => {
    const own = await plainSource();
    const donor = await richSource();
    const out = await rebuild([pageOf(own, 0), pageOf(donor, 0, 'donor')]);
    expect(out.catalog.get(N('Outlines'))).toBeUndefined();
    expect(out.catalog.get(N('Lang'))).toBeUndefined();
  });
});

// ── document actions (/AA) ──────────────────────────────────────────────────

async function withDocActions(bytes: Uint8Array, opts?: { gotoPage?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const js = doc.context.obj({}) as PDFDict;
  js.set(N('S'), N('JavaScript'));
  js.set(N('JS'), PDFHexString.fromText("app.alert('closing');"));
  const aa = doc.context.obj({}) as PDFDict;
  aa.set(N('WC'), js);
  if (opts?.gotoPage) {
    // A /Next chain ending in a GoTo whose destination references a PAGE —
    // the copier-hazard shape that requires the actual output page reference.
    const dest = doc.context.obj([doc.getPage(0).ref, N('Fit')]);
    const gotoAction = doc.context.obj({}) as PDFDict;
    gotoAction.set(N('S'), N('GoTo'));
    gotoAction.set(N('D'), dest);
    js.set(N('Next'), gotoAction);
  }
  doc.catalog.set(N('AA'), doc.context.register(aa));
  return doc.save();
}

describe('catalog carry — /AA document actions', () => {
  it('carries the own document\'s /AA whole', async () => {
    const src = await withDocActions(await plainSource());
    const out = await rebuild([pageOf(src, 0)]);
    const aa = out.catalog.lookupMaybe(N('AA'), PDFDict);
    expect(aa).toBeDefined();
    const wc = aa!.lookupMaybe(N('WC'), PDFDict);
    expect(text(wc!.lookup(N('JS')))).toBe("app.alert('closing');");
  });

  it("a donor's /AA is not imported (own-source only)", async () => {
    const own = await plainSource();
    const donor = await withDocActions(await plainSource());
    const out = await rebuild([pageOf(own, 0), pageOf(donor, 0, 'donor')]);
    expect(out.catalog.get(N('AA'))).toBeUndefined();
  });

  it('an /AA chain binds its destination to the actual output page', async () => {
    const src = await withDocActions(await plainSource(), { gotoPage: true });
    const out = await rebuild([pageOf(src, 0)]);
    const action = out.catalog.lookup(N('AA'), PDFDict).lookup(N('WC'), PDFDict);
    expect(action.lookup(N('Next'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
    expect(out.getPageCount()).toBe(1);
  });
});

async function scriptSource(target: 'none' | 'page' | 'named' | 'cycle' = 'none'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.addPage([610, 800]); pdf.addPage([620, 800]);
  const action = pdf.context.obj({ S: 'JavaScript', JS: pdf.context.register(pdf.context.flateStream('// preserved')) });
  const actionRef = pdf.context.register(action);
  if (target === 'page') action.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: [pdf.getPage(0).ref, 'Fit'] }));
  if (target === 'named') action.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: PDFString.of('named') }));
  if (target === 'cycle') action.set(N('Next'), actionRef);
  const child = pdf.context.register(pdf.context.obj({ Limits: [PDFString.of(' Name '), PDFString.of(' Name ')], Names: [PDFString.of(' Name '), actionRef] }));
  pdf.catalog.set(N('Names'), pdf.context.obj({ JavaScript: { Kids: [child] } }));
  return pdf.save();
}
function scriptAction(pdf: PDFDocument) {
  const tree = pdf.catalog.lookup(N('Names'), PDFDict).lookup(N('JavaScript'), PDFDict);
  return tree.lookup(N('Kids'), PDFArray).lookup(0, PDFDict).lookup(N('Names'), PDFArray);
}
describe('catalog carry — document JavaScript name tree', () => {
  it('preserves the entire nested tree, whitespace name and compressed script on a page rebuild', async () => {
    const src = await scriptSource(), out = await rebuild([pageOf(src, 1)]), names = scriptAction(out);
    expect(text(names.get(0))).toBe(' Name ');
    const action = names.lookup(1, PDFDict), stream = action.lookup(N('JS'));
    if (!(stream instanceof PDFRawStream)) throw new Error('Expected script stream');
    expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toBe('// preserved');
    expect(out.getPageCount()).toBe(1);
  });
  it('maps a chained destination to the actual reordered output page without copying an orphan', async () => {
    const src = await scriptSource('page'), out = await rebuild([pageOf(src, 1), pageOf(src, 0)]);
    const next = scriptAction(out).lookup(1, PDFDict).lookup(N('Next'), PDFDict);
    expect(next.lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    const pages = out.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFDict && obj.get(N('Type')) === N('Page'));
    expect(pages).toHaveLength(2);
  });
  it.each(['removed', 'duplicated', 'named'])('refuses an unprovable %s destination without replacing source bytes', async mode => {
    const src = await scriptSource(mode === 'named' ? 'named' : 'page'), before = src.slice();
    const pages = mode === 'removed' ? [pageOf(src, 1)] : mode === 'duplicated' ? [pageOf(src, 0), pageOf(src, 0)] : [pageOf(src, 0)];
    await expect(rebuild(pages)).rejects.toThrow(); expect(src).toEqual(before);
  });
  it('preserves action cycles as cycles, without executing or flattening them', async () => {
    const src = await scriptSource('cycle'), out = await rebuild([pageOf(src, 0)]), names = scriptAction(out);
    expect(names.lookup(1, PDFDict).get(N('Next'))).toEqual(names.get(1));
  });
  it('does not import scripts from donor pages', async () => {
    const own = await plainSource(), donor = await scriptSource();
    const out = await rebuild([pageOf(own, 0), pageOf(donor, 0, 'donor')]);
    expect(out.catalog.lookupMaybe(N('Names'), PDFDict)?.get(N('JavaScript'))).toBeUndefined();
  });
  it.each(['pdf', 'pdfx'])('retains own scripts when all remaining pages are donor pages: %s', async format => {
    const own = await scriptSource(), donor = await plainSource(), pages = [pageOf(donor, 0, 'donor')];
    const bytes = format === 'pdf' ? await buildPdf(pages, own, 'own')
      : await buildPdfx([{ name: 'Document', pages }], 'Document', own, 'own');
    const out = await PDFDocument.load(bytes); expect(text(scriptAction(out).get(0))).toBe(' Name '); expect(out.getPageCount()).toBe(1);
  });
  it.each([{ format: 'pdf', keepOwn: true }, { format: 'pdf', keepOwn: false },
    { format: 'pdfx', keepOwn: true }, { format: 'pdfx', keepOwn: false }])('retains document ownership: $format / kept own pages = $keepOwn', async ({ format, keepOwn }) => {
    const own = await PDFDocument.load(await richSource()), donorDoc = await PDFDocument.load(await richSource());
    donorDoc.catalog.set(N('Lang'), PDFString.of('fr-FR'));
    donorDoc.catalog.set(N('ViewerPreferences'), donorDoc.context.obj({ DisplayDocTitle: false }));
    const donor = await donorDoc.save();
    own.setCreationDate(new Date('2001-02-03T04:05:06Z')); own.setModificationDate(new Date('2002-03-04T05:06:07Z'));
    const original = await own.save(), pages = [...(keepOwn ? [pageOf(original, 0)] : []), pageOf(donor, 0, 'donor')];
    const bytes = format === 'pdf' ? await buildPdf(pages, original, 'own') : await buildPdfx([{ name: 'D', pages }], 'D', original, 'own');
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(text(out.catalog.lookup(N('Lang')))).toBe('de-DE');
    expect(out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('DisplayDocTitle'), PDFBool).asBoolean()).toBe(true);
    expect(out.getCreationDate()?.toISOString()).toBe('2001-02-03T04:05:06.000Z');
    expect(out.getModificationDate()?.toISOString()).toBe('2002-03-04T05:06:07.000Z');
    const heading = out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);
    expect(text(heading.lookup(N('Title')))).toBe('Intro');
    if (!keepOwn) {
      expect(heading.get(N('Dest'))).toBeUndefined();
      // Both rich fixtures declare a registry-only group on their removed
      // page 1; neither document's declared layer list is discarded.
      expect(out.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('OCGs'), PDFArray).size()).toBe(2);
    }
    expect(out.getPageCount()).toBe(keepOwn ? 2 : 1);
  });
  it('does not invent source dates when loading a document without metadata', async () => {
    const own = await PDFDocument.create({ updateMetadata: false }); own.addPage();
    const out = await PDFDocument.load(await buildPdf([pageOf(await own.save(), 0)], undefined, 'own'), { updateMetadata: false });
    expect(out.getCreationDate()).toBeUndefined(); expect(out.getModificationDate()).toBeUndefined();
  });
});

describe('catalog carry — complete document action graphs', () => {
  async function fixture(edit: (pdf: PDFDocument, action: PDFDict, ref: PDFRef) => void) {
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); pdf.addPage([610, 800]);
    const action = pdf.context.obj({ S: 'JavaScript', JS: pdf.context.register(pdf.context.flateStream('// never executed')) });
    const ref = pdf.context.register(action); pdf.catalog.set(N('AA'), pdf.context.obj({ WC: ref, WS: ref }));
    pdf.catalog.set(N('OpenAction'), ref);
    pdf.catalog.set(N('Names'), pdf.context.obj({ JavaScript: { Names: [PDFString.of('shared'), ref] } }));
    edit(pdf, action, ref); return pdf.save();
  }
  function action(pdf: PDFDocument) { return pdf.catalog.lookup(N('AA'), PDFDict).lookup(N('WC'), PDFDict); }
  it('retains shared roots, compressed text, ordered branches and cycles in one graph', async () => {
    const src = await fixture((pdf, act, ref) => {
      act.set(N('Next'), pdf.context.obj([{ S: 'GoTo', D: [pdf.getPage(1).ref, 'Fit'] }, ref]));
      // More than the old eight-level silent-drop cutoff, but within the bounded copier.
      let node = act;
      for (let i = 0; i < 15; i++) { const child = pdf.context.obj({}); node.set(N('Private'), child); node = child; }
    });
    const out = await rebuild([pageOf(src, 1), pageOf(src, 0)]), aa = out.catalog.lookup(N('AA'), PDFDict), ref = aa.get(N('WC'));
    expect(aa.get(N('WS'))).toEqual(ref); expect(out.catalog.get(N('OpenAction'))).toEqual(ref);
    expect(out.catalog.lookup(N('Names'), PDFDict).lookup(N('JavaScript'), PDFDict).lookup(N('Names'), PDFArray).get(1)).toEqual(ref);
    expect(action(out).lookup(N('Next'), PDFArray).lookup(0, PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
    expect(action(out).lookup(N('Next'), PDFArray).get(1)).toEqual(ref);
    const script = action(out).lookup(N('JS'));
    if (!(script instanceof PDFRawStream)) throw new Error('Expected retained script stream');
    expect(new TextDecoder().decode(decodePDFRawStream(script).decode())).toBe('// never executed');
    expect(out.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFDict && obj.get(N('Type')) === N('Page'))).toHaveLength(2);
  });
  it.each(['array', 'modern', 'legacy'])('preserves an OpenAction %s destination through reorder', async mode => {
    const src = await fixture(pdf => {
      const dest = pdf.context.obj([pdf.getPage(1).ref, 'Fit']);
      pdf.catalog.set(N('OpenAction'), mode === 'array' ? dest : mode === 'modern' ? PDFHexString.of('746172676574') : N('target'));
      pdf.catalog.lookup(N('Names'), PDFDict).set(N('Dests'), pdf.context.obj({ Kids: [{ Names: [PDFString.of('target'), { D: dest }] }] }));
      // The same spelling in the legacy namespace must NOT shadow a string destination.
      pdf.catalog.set(N('Dests'), pdf.context.obj({ target: mode === 'legacy' ? dest : [pdf.getPage(0).ref, 'Fit'] }));
    });
    const out = await rebuild([pageOf(src, 1), pageOf(src, 0)]);
    expect(out.catalog.lookup(N('OpenAction'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
  });
  it('uses byte equality for named destinations, not decoded display text', async () => {
    const src = await fixture((pdf, act) => {
      act.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: PDFString.of('target') }));
      pdf.catalog.lookup(N('Names'), PDFDict).set(N('Dests'), pdf.context.obj({ Names: [
        PDFString.of('target'), [pdf.getPage(1).ref, 'Fit'], PDFHexString.fromText('target'), [pdf.getPage(0).ref, 'Fit'],
      ] }));
    });
    const out = await rebuild([pageOf(src, 0), pageOf(src, 1)]);
    expect(action(out).lookup(N('Next'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });
  it.each(['removed', 'duplicated', 'missing-name', 'duplicate-name', 'cyclic-name-tree', 'malformed-root', 'depth', 'page-tree'])('refuses %s without altering source bytes', async mode => {
    const src = await fixture((pdf, act) => {
      if (mode === 'malformed-root') pdf.catalog.set(N('AA'), PDFNumber.of(42));
      else if (mode === 'page-tree') act.set(N('Private'), pdf.catalog.get(N('Pages'))!);
      else if (mode === 'depth') { let node = act; for (let i = 0; i < 140; i++) { const child = pdf.context.obj({}); node.set(N('Private'), child); node = child; } }
      else if (mode.includes('name')) {
        act.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: PDFString.of('target') }));
        if (mode === 'duplicate-name') pdf.catalog.lookup(N('Names'), PDFDict).set(N('Dests'), pdf.context.obj({ Names: [PDFString.of('target'), [pdf.getPage(0).ref, 'Fit'], PDFHexString.of('746172676574'), [pdf.getPage(1).ref, 'Fit']] }));
        if (mode === 'cyclic-name-tree') { const dict = pdf.context.obj({}), ref = pdf.context.register(dict); dict.set(N('Kids'), pdf.context.obj([ref])); pdf.catalog.lookup(N('Names'), PDFDict).set(N('Dests'), ref); }
      } else act.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: [pdf.getPage(0).ref, 'Fit'] }));
    });
    const before = src.slice(), pages = mode === 'removed' ? [pageOf(src, 1)] : mode === 'duplicated' ? [pageOf(src, 0), pageOf(src, 0)] : [pageOf(src, 0), pageOf(src, 1)];
    await expect(rebuild(pages)).rejects.toThrow(); expect(src).toEqual(before);
  });
  it('does not take an already-copied action subtree as a page-identity authority', async () => {
    const src = await PDFDocument.load(await fixture((pdf, act) => { act.set(N('Next'), pdf.context.obj({ S: 'GoTo', D: [pdf.getPage(1).ref, 'Fit'] })); }));
    const out = await PDFDocument.create(); const pages = await out.copyPages(src, [1, 0]); pages.forEach(p => out.addPage(p));
    const actionRef = src.catalog.lookup(N('AA'), PDFDict).get(N('WC')) as PDFRef;
    const wrongRef = out.context.register(out.context.obj({ S: 'JavaScript', JS: PDFString.of('// wrong copied subtree') }));
    carryDocumentBehavior(out, { doc: src, pairs: [{ srcIndex: 1, outPage: pages[0] }, { srcIndex: 0, outPage: pages[1] }] }, new Map([[actionRef.tag, wrongRef]]));
    expect(action(out).lookup(N('Next'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(pages[0].ref);
    expect(action(out).lookup(N('JS'))).toBeInstanceOf(PDFRawStream);
  });
  it('refuses an orphan page even when its Type name is indirect', async () => {
    const src = await fixture((pdf, act) => {
      act.set(N('Private'), pdf.context.register(pdf.context.obj({ Type: pdf.context.register(N('Page')) })));
    });
    await expect(rebuild([pageOf(src, 0)])).rejects.toThrow();
  });
  it('preserves a remote destination without resolving it in the local namespace', async () => {
    const src = await fixture((pdf, act) => {
      act.set(N('Next'), pdf.context.obj({ S: 'GoToR', F: PDFString.of('external.pdf'), D: PDFString.of('external-name') }));
    });
    const out = await rebuild([pageOf(src, 0)]);
    expect(text(action(out).lookup(N('Next'), PDFDict).lookup(N('D')))).toBe('external-name');
  });
  it.each(['pdf', 'pdfx'])('retains document action roots with donor-only pages: %s', async format => {
    const src = await fixture(() => {}), donor = await plainSource(), pages = [pageOf(donor, 0, 'donor')];
    const bytes = format === 'pdf' ? await buildPdf(pages, src, 'own') : await buildPdfx([{ name: 'Document', pages }], 'Document', src, 'own');
    const out = await PDFDocument.load(bytes); expect(action(out)).toBeInstanceOf(PDFDict); expect(out.catalog.get(N('OpenAction'))).toBeDefined();
  });
});
