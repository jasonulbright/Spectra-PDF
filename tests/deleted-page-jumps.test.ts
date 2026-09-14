import { describe, expect, it } from 'vitest';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const N = PDFName.of.bind(PDFName);

type Shape = (pdf: PDFDocument) => void;

/** Three pages 300/400/500 wide, rebuilt as the given source page order. */
async function rebuildAs(format: 'pdf' | 'pdfx', order: number[], shape: Shape, pageCount = 3): Promise<PDFDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pageCount; i++) pdf.addPage([300 + 100 * i, 700]);
  shape(pdf);
  const bytes = await pdf.save(), before = bytes.slice();
  const pages: ExportPage[] = order.map(pageIndex => ({ bytes, sourceKey: 'own', pageIndex }));
  const built = format === 'pdf' ? await buildPdf(pages, bytes, 'own')
    : await buildPdfx([{ name: 'Document', pages }], 'Document', bytes, 'own');
  expect(bytes).toEqual(before);
  const out = await PDFDocument.load(built, { updateMetadata: false });
  expect(out.getPages().map(page => page.getWidth())).toEqual(order.map(index => 300 + 100 * index));
  const pageObjects = out.context.enumerateIndirectObjects()
    .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('Page'));
  expect(pageObjects.map(([ref]) => ref.tag).sort()).toEqual(out.getPages().map(page => page.ref.tag).sort());
  return out;
}
/** Source page index 1 is the deleted one. */
const deletePageTwo = (format: 'pdf' | 'pdfx', shape: Shape) => rebuildAs(format, [0, 2], shape);

/** One article thread whose beads sit on the given pages, circularly linked. */
function thread(pdf: PDFDocument, onPages: number[]) {
  const ctx = pdf.context, threadRef = ctx.register(ctx.obj({ Type: 'Thread', I: { Title: PDFString.of('Story') } }));
  const beads = onPages.map(pageIndex => ctx.register(ctx.obj({ Type: 'Bead', P: pdf.getPage(pageIndex).ref, R: [10, 10, 100, 100] })));
  beads.forEach((ref, i) => {
    const bead = ctx.lookup(ref, PDFDict), page = pdf.getPage(onPages[i]).node;
    bead.set(N('N'), beads[(i + 1) % beads.length]);
    bead.set(N('V'), beads[(i - 1 + beads.length) % beads.length]);
    if (i === 0) bead.set(N('T'), threadRef);
    page.set(N('B'), ctx.obj([ref]));
  });
  ctx.lookup(threadRef, PDFDict).set(N('F'), beads[0]);
  pdf.catalog.set(N('Threads'), ctx.obj([threadRef]));
}

describe.each(['pdf', 'pdfx'] as const)('document state pointing at a page placed twice binds to its first placement (%s)', format => {
  const duplicateP1 = (shape: Shape) => rebuildAs(format, [0, 1, 1], shape);
  const outline = (pdf: PDFDocument, entries: Record<string, unknown>) => {
    const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }), rootRef = pdf.context.register(root);
    const item = pdf.context.register(pdf.context.obj({ Title: PDFString.of('One'), Parent: rootRef, ...entries }));
    root.set(N('First'), item); root.set(N('Last'), item); pdf.catalog.set(N('Outlines'), rootRef);
  };
  const bookmark = (out: PDFDocument) => out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);

  it('outline /Dest', async () => {
    const out = await duplicateP1(pdf => outline(pdf, { Dest: fit(pdf, 1) }));
    expect(bookmark(out).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('outline /A GoTo', async () => {
    const out = await duplicateP1(pdf => outline(pdf, { A: goTo(pdf, 1) }));
    expect(bookmark(out).lookup(N('A'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('/OpenAction [p1 /Fit]', async () => {
    const out = await duplicateP1(pdf => pdf.catalog.set(N('OpenAction'), fit(pdf, 1)));
    expect(out.catalog.lookup(N('OpenAction'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('a named destination used by an outline item', async () => {
    const out = await duplicateP1(pdf => {
      pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('one'), fit(pdf, 1)] } }));
      outline(pdf, { Dest: PDFString.of('one') });
    });
    expect(bookmark(out).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });
});

describe('page reference binding on a heavily annotated page', () => {
  it('builds 5,000 annotations with /P over 10,000 resource objects without refusing', async () => {
    const out = await rebuildAs('pdf', [0, 2], pdf => {
      const ctx = pdf.context, states = ctx.obj({});
      for (let i = 0; i < 10000; i++) states.set(N(`GS${i}`), ctx.register(ctx.obj({ Type: 'ExtGState', CA: 1 })));
      pdf.getPage(0).node.set(N('Resources'), ctx.obj({ ExtGState: states }));
      const annots = Array.from({ length: 5000 }, (_, i) => ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [i % 200, 0, i % 200 + 5, 5], P: pdf.getPage(0).ref })));
      pdf.getPage(0).node.set(N('Annots'), ctx.obj(annots));
    });
    const annots = out.getPage(0).node.lookup(N('Annots'), PDFArray);
    expect(annots.size()).toBe(5000);
    expect(annots.lookup(4999, PDFDict).get(N('P'))).toEqual(out.getPage(0).ref);
  }, 120000);

  it.each(['pdf', 'pdfx'] as const)('builds a long chain of page-to-page links without refusing (%s)', async format => {
    const order = Array.from({ length: 100 }, (_, i) => i).filter(i => i !== 49);
    const out = await rebuildAs(format, order, pdf => {
      pdf.getPages().forEach((page, i) => page.node.set(N('Annots'), pdf.context.obj([
        pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 5, 5], P: page.ref })),
        pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 5, 5], Dest: fit(pdf, (i + 1) % 100) })),
      ])));
    }, 100);
    const link = (index: number) => out.getPage(index).node.lookup(N('Annots'), PDFArray).lookup(1, PDFDict);
    expect(link(0).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    expect(link(48).get(N('Dest'))).toBeUndefined();
    expect(link(98).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
  }, 120000);
});

const fit = (pdf: PDFDocument, index: number) => pdf.context.obj([pdf.getPage(index).ref, 'Fit']);
const goTo = (pdf: PDFDocument, index: number) => pdf.context.obj({ S: 'GoTo', D: fit(pdf, index) });
const script = (text: string) => ({ S: 'JavaScript', JS: PDFString.of(text) });
const links = (pdf: PDFDocument, entries: Record<string, unknown>[]) => {
  const refs = entries.map(entry => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], ...entry })));
  pdf.getPage(0).node.set(N('Annots'), pdf.context.obj(refs));
};
const linkOut = (out: PDFDocument, index: number) => out.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(index, PDFDict);
const scriptText = (value: unknown) => ((value as PDFDict).lookup(N('JS')) as PDFString).decodeText();

describe.each(['pdf', 'pdfx'] as const)('a deleted page loses only the jumps into it (%s)', format => {
  it('omits an explicit-destination opening view to the deleted page', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('OpenAction'), fit(pdf, 1)));
    expect(out.catalog.get(N('OpenAction'))).toBeUndefined();
  });

  it('omits a GoTo opening action, including one reached through a chain', async () => {
    for (const chained of [false, true]) {
      const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('OpenAction'),
        chained ? pdf.context.obj({ ...script('// first'), Next: [script('// second'), goTo(pdf, 1)] }) : goTo(pdf, 1)));
      expect(out.catalog.get(N('OpenAction'))).toBeUndefined();
    }
  });

  it('keeps an opening view to a retained page, remapped', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('OpenAction'), fit(pdf, 2)));
    expect(out.catalog.lookup(N('OpenAction'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('keeps an opening action that jumps nowhere', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('OpenAction'), pdf.context.obj(script('// open'))));
    expect(scriptText(out.catalog.lookup(N('OpenAction'), PDFDict))).toBe('// open');
  });

  it('strips explicit jumps to the deleted page from links and keeps every other link intact', async () => {
    const out = await deletePageTwo(format, pdf => {
      pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('two'), fit(pdf, 1)] } }));
      links(pdf, [
        { Dest: fit(pdf, 1) },
        { A: goTo(pdf, 1) },
        { A: { ...script('// chained'), Next: goTo(pdf, 1) } },
        { Dest: fit(pdf, 2) },
        { A: goTo(pdf, 2) },
        { Dest: PDFString.of('two') },
      ]);
    });
    for (const index of [0, 1, 2]) {
      const link = linkOut(out, index);
      expect(link.get(N('Dest'))).toBeUndefined(); expect(link.get(N('A'))).toBeUndefined();
      expect(link.lookup(N('Subtype'))).toBe(N('Link'));
    }
    expect(linkOut(out, 3).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    expect(linkOut(out, 4).lookup(N('A'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    expect(linkOut(out, 5).lookup(N('Dest'), PDFString).decodeText()).toBe('two');
  });

  it('binds annotation page back-pointers and retained-page links to the inserted pages', async () => {
    const out = await deletePageTwo(format, pdf => links(pdf, [
      { P: pdf.getPage(0).ref, Dest: fit(pdf, 0) },
      { A: { S: 'GoTo', D: fit(pdf, 2), Next: goTo(pdf, 0) } },
    ]));
    expect(linkOut(out, 0).get(N('P'))).toEqual(out.getPage(0).ref);
    expect(linkOut(out, 0).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
    const action = linkOut(out, 1).lookup(N('A'), PDFDict);
    expect(action.lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    expect(action.lookup(N('Next'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
  });

  it('drops widget and page trigger jumps to the deleted page and keeps the rest', async () => {
    const out = await deletePageTwo(format, pdf => {
      const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10],
        A: goTo(pdf, 1), AA: { U: goTo(pdf, 1), D: script('// down') } }));
      pdf.getPage(0).node.set(N('Annots'), pdf.context.obj([widget]));
      pdf.getPage(0).node.set(N('AA'), pdf.context.obj({ O: goTo(pdf, 1), C: goTo(pdf, 2) }));
    });
    const widget = linkOut(out, 0), triggers = widget.lookup(N('AA'), PDFDict);
    expect(widget.get(N('A'))).toBeUndefined();
    expect(triggers.get(N('U'))).toBeUndefined();
    expect(scriptText(triggers.lookup(N('D'), PDFDict))).toBe('// down');
    const pageTriggers = out.getPage(0).node.lookup(N('AA'), PDFDict);
    expect(pageTriggers.get(N('O'))).toBeUndefined();
    expect(pageTriggers.lookup(N('C'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('unlinks a bead on the deleted page and keeps the thread on the retained beads', async () => {
    const out = await deletePageTwo(format, pdf => thread(pdf, [0, 1, 2]));
    const threadRef = out.catalog.lookup(N('Threads'), PDFArray).get(0) as PDFRef;
    const threadDict = out.context.lookup(threadRef, PDFDict), first = threadDict.lookup(N('F'), PDFDict);
    const second = first.lookup(N('N'), PDFDict);
    expect(first.get(N('P'))).toEqual(out.getPage(0).ref);
    expect(first.get(N('T'))).toEqual(threadRef);
    expect(second.get(N('P'))).toEqual(out.getPage(1).ref);
    expect(second.get(N('N'))).toEqual(threadDict.get(N('F')));
    expect(first.get(N('V'))).toEqual(first.get(N('N')));
    expect(out.getPage(1).node.lookup(N('B'), PDFArray).get(0)).toEqual(first.get(N('N')));
  });

  it('keeps a thread whose beads are all on retained pages', async () => {
    const out = await deletePageTwo(format, pdf => thread(pdf, [0, 2]));
    const first = out.catalog.lookup(N('Threads'), PDFArray).lookup(0, PDFDict).lookup(N('F'), PDFDict);
    expect(first.get(N('P'))).toEqual(out.getPage(0).ref);
    expect(first.lookup(N('N'), PDFDict).get(N('P'))).toEqual(out.getPage(1).ref);
  });

  it('omits a thread whose every bead was on the deleted page', async () => {
    const out = await deletePageTwo(format, pdf => thread(pdf, [1]));
    expect(out.catalog.get(N('Threads'))).toBeUndefined();
  });

  it('drops popup and reply references to annotations on the deleted page', async () => {
    const out = await deletePageTwo(format, pdf => {
      const [popup, note] = [0, 1].map(() => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 1, 1], P: pdf.getPage(1).ref })));
      pdf.context.lookup(popup, PDFDict).set(N('Subtype'), N('Popup'));
      pdf.getPage(1).node.set(N('Annots'), pdf.context.obj([popup, note]));
      links(pdf, [
        { Subtype: 'Text', P: pdf.getPage(0).ref, Popup: popup, Contents: PDFString.of('x') },
        { Subtype: 'Text', P: pdf.getPage(0).ref, IRT: note, RT: 'R', Contents: PDFString.of('reply') },
      ]);
    });
    expect(linkOut(out, 0).get(N('Popup'))).toBeUndefined();
    expect(linkOut(out, 1).get(N('IRT'))).toBeUndefined();
    expect(linkOut(out, 1).get(N('RT'))).toBeUndefined();
    expect(linkOut(out, 1).lookup(N('Contents'), PDFString).decodeText()).toBe('reply');
  });

  it('binds references to a duplicated page to its first placement', async () => {
    const out = await rebuildAs(format, [0, 2, 2], pdf => {
      links(pdf, [{ Dest: fit(pdf, 2) }]);
      const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 1, 1], P: pdf.getPage(2).ref }));
      pdf.getPage(2).node.set(N('Annots'), pdf.context.obj([note]));
    });
    expect(linkOut(out, 0).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
    for (const index of [1, 2]) {
      expect(out.getPage(index).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict).get(N('P'))).toEqual(out.getPage(index).ref);
    }
  });

  it('saves with an unreferenced named destination to the deleted page', async () => {
    await deletePageTwo(format, pdf => pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('two'), fit(pdf, 1)] } })));
  });

  it('omits a print range selecting only the deleted page and keeps every other preference', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [2, 2], DisplayDocTitle: true, NumCopies: 3 })));
    const prefs = out.catalog.lookup(N('ViewerPreferences'), PDFDict);
    expect(prefs.get(N('PrintPageRange'))).toBeUndefined();
    expect(prefs.lookup(N('DisplayDocTitle'))).toBe(PDFBool.True);
    expect(prefs.lookup(N('NumCopies'), PDFNumber).asNumber()).toBe(3);
  });

  it('remaps a print range that still selects a retained page', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [1, 2] })));
    const range = out.catalog.lookup(N('ViewerPreferences'), PDFDict).lookup(N('PrintPageRange'), PDFArray);
    expect(range.asArray().map(n => (n as PDFNumber).asNumber())).toEqual([1, 1]);
  });

  it('refuses a malformed print range', async () => {
    await expect(deletePageTwo(format, pdf => pdf.catalog.set(N('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [2] })))).rejects.toThrow();
  });

  it('omits a document trigger chaining to the deleted page and keeps the other triggers', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('AA'), pdf.context.register(pdf.context.obj({
      WC: { ...script('// close'), Next: goTo(pdf, 1) },
      WS: script('// save'),
      DP: goTo(pdf, 2),
    }))));
    const aa = out.catalog.lookup(N('AA'), PDFDict);
    expect(aa.get(N('WC'))).toBeUndefined();
    expect(scriptText(aa.lookup(N('WS'), PDFDict))).toBe('// save');
    expect(aa.lookup(N('DP'), PDFDict).lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('omits the trigger dictionary when every trigger jumps to the deleted page', async () => {
    const out = await deletePageTwo(format, pdf => pdf.catalog.set(N('AA'), pdf.context.obj({ WC: goTo(pdf, 1) })));
    expect(out.catalog.get(N('AA'))).toBeUndefined();
  });

  it('omits a document script entry chaining to the deleted page, keeps the rest and fixes the limits', async () => {
    const out = await deletePageTwo(format, pdf => {
      const leaf = (names: [string, PDFDict][]) => pdf.context.register(pdf.context.obj({
        Limits: [PDFString.of(names[0][0]), PDFString.of(names[names.length - 1][0])],
        Names: names.flatMap(([name, action]) => [PDFString.of(name), pdf.context.register(action)]),
      }));
      const removed = pdf.context.obj({ ...script('// b'), Next: goTo(pdf, 1) });
      pdf.catalog.set(N('Names'), pdf.context.obj({ JavaScript: { Kids: [
        leaf([['a', pdf.context.obj(script('// a'))], ['b', removed]]),
        leaf([['c', removed]]),
        leaf([['d', pdf.context.obj({ ...script('// d'), Next: goTo(pdf, 2) })]]),
      ] } }));
    });
    const kids = out.catalog.lookup(N('Names'), PDFDict).lookup(N('JavaScript'), PDFDict).lookup(N('Kids'), PDFArray);
    expect(kids.size()).toBe(2);
    const first = kids.lookup(0, PDFDict), second = kids.lookup(1, PDFDict);
    const strings = (arr: PDFArray) => arr.asArray().filter(v => v instanceof PDFString).map(v => (v as PDFString).decodeText());
    expect(strings(first.lookup(N('Names'), PDFArray))).toEqual(['a']);
    expect(strings(first.lookup(N('Limits'), PDFArray))).toEqual(['a', 'a']);
    expect(scriptText(first.lookup(N('Names'), PDFArray).lookup(1, PDFDict))).toBe('// a');
    expect(strings(second.lookup(N('Limits'), PDFArray))).toEqual(['d', 'd']);
    const next = second.lookup(N('Names'), PDFArray).lookup(1, PDFDict).lookup(N('Next'), PDFDict);
    expect(next.lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(1).ref);
  });

  it('keeps a bookmark to the deleted page without its jump', async () => {
    const out = await deletePageTwo(format, pdf => {
      const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }), rootRef = pdf.context.register(root);
      const item: PDFRef = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Two'), Parent: rootRef, Dest: fit(pdf, 1) }));
      root.set(N('First'), item); root.set(N('Last'), item); pdf.catalog.set(N('Outlines'), rootRef);
    });
    const bookmark = out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);
    expect(bookmark.lookup(N('Title'), PDFString).decodeText()).toBe('Two');
    expect(bookmark.get(N('Dest'))).toBeUndefined();
  });
});
