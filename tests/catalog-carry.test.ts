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
  PDFString,
} from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

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

  it('dropping every page that uses the OCG drops the config too', async () => {
    const src = await richSource();
    const out = await rebuild([pageOf(src, 0)]); // page 1 (the OCG user) gone
    expect(out.catalog.get(N('OCProperties'))).toBeUndefined();
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
    // the copier-hazard shape the carry must refuse.
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

  it('an /AA chain that reaches a page drops instead of dragging a page copy', async () => {
    const src = await withDocActions(await plainSource(), { gotoPage: true });
    const out = await rebuild([pageOf(src, 0)]);
    expect(out.catalog.get(N('AA'))).toBeUndefined();
    expect(out.getPageCount()).toBe(1);
  });
});
