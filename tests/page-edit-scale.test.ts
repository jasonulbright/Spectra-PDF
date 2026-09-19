import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import type { CarriedSourcePages } from '../src/renderer/lib/catalog-carry';
import {
  OPTIONAL_CONTENT_LIMITS,
  carryOptionalContent,
  optionalContentBudget,
  type OptionalContentLimits,
} from '../src/renderer/lib/optional-content-carry';
import { STRUCT_LIMITS, carryStructTree, structBudgets, type StructLimits } from '../src/renderer/lib/struct-carry';

const N = PDFName.of.bind(PDFName);

interface Shape {
  pages: number;
  layer?: boolean;
  tagged?: boolean;
  /** Entries in the shared font's /Widths: scalar leaves. */
  widths?: number;
  /** Registered objects the shared font references: a graph every page shares. */
  shared?: number;
  /** Distinct arrays in a Type3 font on page 0 only: a unique graph. */
  unique?: number;
}

/** A producer-shaped page: one embedded TrueType font shared by every page
 * (descriptor, font file, /Widths), a unique image, and ten annotations whose
 * appearance streams reference the shared font. */
async function producerDocument({ pages, layer = false, tagged = false, widths = 2000, shared = 0, unique = 0 }: Shape): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx = pdf.context;
  const fontFile = ctx.register(ctx.flateStream(new Uint8Array(2000)));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Body', Flags: 32, FontBBox: [-100, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: fontFile }));
  const vendor = Array.from({ length: shared }, (_, i) => ctx.register(ctx.obj({ Index: i })));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Body', FirstChar: 0, LastChar: widths - 1, Widths: Array.from({ length: widths }, (_, i) => 500 + (i % 50)), FontDescriptor: descriptor, VendorShared: vendor }));
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: 'Layer' }));
  if (layer) pdf.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }));
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([612, 792]);
    const image = ctx.register(ctx.flateStream(new Uint8Array(30), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 10, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const resources = ctx.obj({ Font: { F1: font }, XObject: { Im1: image } });
    if (layer) resources.set(N('Properties'), ctx.obj({ L0: ocg }));
    if (p === 0 && unique > 0) {
      const type3 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', Private: Array.from({ length: unique }, () => [0, 0]) }));
      resources.lookup(N('Font'), PDFDict).set(N('F2'), type3);
    }
    page.node.set(N('Resources'), resources);
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(layer
      ? '/OC /L0 BDC BT /F1 12 Tf 72 720 Td (Body) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q EMC'
      : 'BT /F1 12 Tf 72 720 Td (Body) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q')));
    const annots: PDFRef[] = [];
    for (let a = 0; a < 10; a++) {
      const appearance = ctx.register(ctx.flateStream('BT /F1 9 Tf 2 6 Td (n) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20], Resources: { Font: { F1: font } } }));
      annots.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [a * 30, 10, a * 30 + 20, 30], P: page.ref, DA: '/F1 9 Tf', AP: { N: appearance } })));
    }
    page.node.set(N('Annots'), ctx.obj(annots));
  }
  if (tagged) {
    const root = ctx.obj({ Type: 'StructTreeRoot' }), rootRef = ctx.register(root);
    const kids: PDFRef[] = [], nums = ctx.obj([]);
    pdf.getPages().forEach((page, i) => {
      const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: page.ref, K: 0 }));
      kids.push(elem); nums.push(ctx.obj(i)); nums.push(ctx.obj([elem]));
      page.node.set(N('StructParents'), ctx.obj(i));
    });
    root.set(N('K'), ctx.obj(kids)); root.set(N('ParentTree'), ctx.obj({ Nums: nums }));
    pdf.catalog.set(N('StructTreeRoot'), rootRef); pdf.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  }
  return pdf.save();
}

async function deleteOnePage(format: 'pdf' | 'pdfx', bytes: Uint8Array, pageCount: number, deleted: number) {
  const pages: ExportPage[] = Array.from({ length: pageCount }, (_, pageIndex) => ({ bytes, sourceKey: 'own', pageIndex }))
    .filter(page => page.pageIndex !== deleted);
  return format === 'pdf' ? buildPdf(pages, bytes, 'own') : buildPdfx([{ name: 'Document', pages }], 'Document', bytes, 'own');
}

const pageObjectsOutsideTheTree = (out: PDFDocument) => {
  const tree = new Set(out.getPages().map(page => page.ref.tag));
  return out.context.enumerateIndirectObjects()
    .filter(([ref, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('Page') && !tree.has(ref.tag));
};

describe.each([false, true])('deleting one page of a producer-shaped document (layer on every page = %s)', layer => {
  it.each(['pdf', 'pdfx'] as const)('saves with every page accounted for: %s', async format => {
    const source = await producerDocument({ pages: 4, layer });
    const before = source.slice();
    const out = await PDFDocument.load(await deleteOnePage(format, source, 4, 2), { updateMetadata: false });
    expect(source).toEqual(before);
    expect(out.getPageCount()).toBe(3);
    expect(pageObjectsOutsideTheTree(out)).toHaveLength(0);
    if (layer) expect(out.catalog.lookup(N('OCProperties'), PDFDict).get(N('OCGs'))).toBeDefined();
  });
});

describe('deleting one page of a tagged producer-shaped document', () => {
  it.each(['pdf', 'pdfx'] as const)('saves with every page and its structure element accounted for: %s', async format => {
    const source = await producerDocument({ pages: 4, layer: true, tagged: true });
    const before = source.slice();
    const out = await PDFDocument.load(await deleteOnePage(format, source, 4, 2), { updateMetadata: false });
    expect(source).toEqual(before);
    expect(out.getPageCount()).toBe(3);
    expect(pageObjectsOutsideTheTree(out)).toHaveLength(0);
    const elements = out.context.enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('StructElem'));
    expect(elements).toHaveLength(3);
  });
});

/** Objects charged to each budget a page edit spends: the layer carry's, and
 * the structure carry's stale-key sweep and tree. */
interface Spend {
  layers: number;
  sweep: number;
  tree: number;
}
const BUDGETS = ['layers', 'sweep', 'tree'] as const;

/** Copy the kept pages the way the builder does — one copyPages call for the
 * source — and run both carries on them with fresh budgets. */
async function spend(
  bytes: Uint8Array,
  keep: (pageCount: number) => number[],
  limits: { layers?: OptionalContentLimits; sweep?: StructLimits; tree?: StructLimits } = {},
): Promise<Spend> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const output = await PDFDocument.create({ updateMetadata: false });
  const indices = keep(doc.getPageCount());
  const copied = await output.copyPages(doc, indices);
  for (const page of copied) output.addPage(page);
  const source: CarriedSourcePages = { doc, pairs: copied.map((outPage, i) => ({ srcIndex: indices[i], outPage })) };
  const layers = optionalContentBudget(limits.layers);
  carryOptionalContent(output, [source], source, layers);
  const struct = { sweep: structBudgets(limits.sweep).sweep, tree: structBudgets(limits.tree).tree };
  carryStructTree(output, [source], struct);
  return { layers: layers.objects, sweep: struct.sweep.objects, tree: struct.tree.objects };
}

/** Every page but the first: a one-page deletion. */
const allButFirst = (pageCount: number) => Array.from({ length: pageCount - 1 }, (_, i) => i + 1);
const deletion = async (shape: Shape) => spend(await producerDocument(shape), allButFirst);

describe('page edit work is charged per page, never per shared object', () => {
  const heaviest = { layer: true, tagged: true } as const;

  it('charges every kept page the same, so the charge grows linearly with pages', async () => {
    const [two, three, four] = await Promise.all([2, 3, 4].map(pages => deletion({ pages, ...heaviest })));
    for (const budget of BUDGETS) {
      expect(four[budget] - three[budget]).toBeGreaterThan(0);
      expect(four[budget] - three[budget]).toBe(three[budget] - two[budget]);
    }
  });

  it('charges a graph every page shares once, whatever the page count', async () => {
    const growth = async (pages: number) => {
      const [bare, shared] = await Promise.all([0, 40].map(count => deletion({ pages, ...heaviest, shared: count })));
      return BUDGETS.map(budget => shared[budget] - bare[budget]);
    };
    const [onTwo, onFour] = await Promise.all([growth(2), growth(4)]);
    expect(onFour).toEqual(onTwo);
    for (const extra of onTwo) expect(extra).toBeGreaterThanOrEqual(40);
  });

  it("never charges scalar leaves such as a font's /Widths", async () => {
    const [narrow, wide] = await Promise.all([20, 2000].map(widths => deletion({ pages: 3, ...heaviest, widths })));
    expect(wide).toEqual(narrow);
  });

  it('fits a one-page deletion from a 1,000-page producer-shaped document inside the production bounds', async () => {
    expect(OPTIONAL_CONTENT_LIMITS).toEqual({ objects: 200_000, bytes: 64 * 1024 * 1024 });
    expect(STRUCT_LIMITS).toEqual({ objects: 200_000, bytes: 64 * 1024 * 1024 });
    expect(Object.isFrozen(OPTIONAL_CONTENT_LIMITS) && Object.isFrozen(STRUCT_LIMITS)).toBe(true);
    const [three, four] = await Promise.all([3, 4].map(pages => deletion({ pages, ...heaviest })));
    const limit: Spend = { layers: OPTIONAL_CONTENT_LIMITS.objects, sweep: STRUCT_LIMITS.objects, tree: STRUCT_LIMITS.objects };
    for (const budget of BUDGETS) {
      // Linear per page (above): 999 kept pages cost the 3 measured plus 996 more.
      expect(four[budget] + (four[budget] - three[budget]) * 996).toBeLessThanOrEqual(limit[budget]);
    }
  });
});

describe('page edit work guard', () => {
  const keepAll = (pageCount: number) => Array.from({ length: pageCount }, (_, i) => i);
  const withUnique = (unique: number) => producerDocument({ pages: 2, tagged: true, unique });

  it('charges each distinct object of a unique graph once', async () => {
    const [eight, nine] = await Promise.all([8, 9].map(async unique => spend(await withUnique(unique), keepAll)));
    for (const budget of BUDGETS) expect(nine[budget]).toBe(eight[budget] + 1);
  });

  it.each(BUDGETS)('refuses a unique graph one object past an injected %s bound', async budget => {
    const [eight, nine] = await Promise.all([withUnique(8), withUnique(9)]);
    const objects = (await spend(eight, keepAll))[budget];
    const limits = { [budget]: { ...(budget === 'layers' ? OPTIONAL_CONTENT_LIMITS : STRUCT_LIMITS), objects } };
    await expect(spend(eight, keepAll, limits)).resolves.toBeDefined();
    await expect(spend(nine, keepAll, limits)).rejects.toThrow('The operation result could not be verified.');
  });
});

/** Three pages; page 0 carries `annotations` annotations whose /P names it,
 * over `resources` graphics-state objects. */
async function annotatedPage(annotations: number, resources: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 3; i++) pdf.addPage([300 + 100 * i, 700]);
  const ctx = pdf.context, states = ctx.obj({});
  for (let i = 0; i < resources; i++) states.set(N(`GS${i}`), ctx.register(ctx.obj({ Type: 'ExtGState', CA: 1 })));
  pdf.getPage(0).node.set(N('Resources'), ctx.obj({ ExtGState: states }));
  const annots = Array.from({ length: annotations }, (_, i) => ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [i % 200, 0, i % 200 + 5, 5], P: pdf.getPage(0).ref })));
  pdf.getPage(0).node.set(N('Annots'), ctx.obj(annots));
  return pdf.save();
}

describe('page edit work on a heavily annotated page', () => {
  /** Deleting page 1 keeps the annotated page 0 and page 2. */
  const charge = async (annotations: number, resources: number) =>
    spend(await annotatedPage(annotations, resources), () => [0, 2]);

  it('charges annotations and resources additively, never their product', async () => {
    const [a4r10, a8r10, a4r40, a8r40] = await Promise.all([[4, 10], [8, 10], [4, 40], [8, 40]].map(([a, r]) => charge(a, r)));
    for (const budget of BUDGETS) {
      // Four more annotations cost the same over 40 resources as over 10.
      expect(a8r40[budget] - a4r40[budget]).toBe(a8r10[budget] - a4r10[budget]);
    }
  });

  it('fits 5,000 annotations with /P over 10,000 resource objects inside the production bounds', async () => {
    const [a4r10, a8r10, a12r10, a4r40, a4r70] = await Promise.all(
      [[4, 10], [8, 10], [12, 10], [4, 40], [4, 70]].map(([a, r]) => charge(a, r)),
    );
    const limit: Spend = { layers: OPTIONAL_CONTENT_LIMITS.objects, sweep: STRUCT_LIMITS.objects, tree: STRUCT_LIMITS.objects };
    for (const budget of BUDGETS) {
      const perAnnotation = (a8r10[budget] - a4r10[budget]) / 4;
      const perResource = (a4r40[budget] - a4r10[budget]) / 30;
      // Linear in each: the next four annotations and the next 30 resources
      // cost what the previous ones did.
      expect(a12r10[budget] - a8r10[budget]).toBe(perAnnotation * 4);
      expect(a4r70[budget] - a4r40[budget]).toBe(perResource * 30);
      const predicted = a4r10[budget] + perAnnotation * (5_000 - 4) + perResource * (10_000 - 10);
      expect(predicted).toBeLessThanOrEqual(limit[budget]);
    }
  });
});
