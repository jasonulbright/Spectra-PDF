// An embedded go-to action can locate its target file by a file attachment
// annotation of this document: /T << /R /C /P page /A annotation >>, with the
// page as a page number or a named destination and the annotation as its
// index in the page's /Annots or as its /NM (ISO 32000-2 12.6.4.4, Table 205).
// A commit changes page numbers and /Annots indices. The action names the same
// page and the same annotation afterwards, or leaves its chain when either is
// gone.

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject, PDFPage } from 'pdf-lib';
import { commit, deleting } from './support/commit-cycle';
import { annotsOf, expectSound, held, subtypeOf } from './support/saved-pdf';
import type { PageRef } from '../src/renderer/state/types';

const N = PDFName.of;

interface Parts { doc: PDFDocument; ctx: PDFContext; pages: PDFPage[]; link: PDFDict; far: PDFDict }

/** Three pages. Page 2 lists a note the import reads, a file attachment
 *  annotation and a link, in that order. Page 3 lists a second link. Page 1
 *  has body text only. `wire` adds the actions under test. */
async function source(wire: (parts: Parts) => void, options: { directAttachment?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([300, 600]), doc.addPage([300, 600]), doc.addPage([300, 600])];
  const ctx = doc.context;
  pages.forEach((page, index) => page.node.set(N('Contents'), ctx.register(ctx.stream(`BT 20 300 Td ET % BODYOFPAGE${index + 1}`))));
  const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  note.set(N('Contents'), PDFHexString.fromText('FIRSTNOTE'));
  const file = ctx.register(ctx.stream('%PDF-1.7 child', { Type: 'EmbeddedFile' }));
  const spec = ctx.obj({ Type: 'Filespec', EF: { F: file } });
  spec.set(N('F'), PDFString.of('child.pdf'));
  const attachment = ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [40, 370, 60, 390], FS: ctx.register(spec) });
  attachment.set(N('NM'), PDFString.of('attachment-name'));
  attachment.set(N('Contents'), PDFString.of('THEATTACHMENT'));
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 498, 202, 522] });
  pages[1].node.set(N('Annots'), ctx.obj([ctx.register(note), options.directAttachment ? attachment : ctx.register(attachment), ctx.register(link)]));
  const far = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 498, 202, 522] });
  pages[2].node.set(N('Annots'), ctx.obj([ctx.register(far)]));
  wire({ doc, ctx, pages, link, far });
  return doc.save();
}

type Literal = string | number | boolean | { [key: string]: Literal };

const embedded = (ctx: PDFContext, target: { [key: string]: Literal }, extra: Record<string, unknown> = {}): PDFDict => {
  const action: PDFDict = ctx.obj({ Type: 'Action', S: 'GoToE', ...extra });
  action.set(N('T'), ctx.obj(target));
  action.set(N('D'), PDFString.of('Chapter 1'));
  return action;
};

const linkAt = (doc: PDFDocument, pageIndex: number): PDFDict => annotsOf(doc, pageIndex).find((a) => subtypeOf(a.dict) === '/Link')!.dict;
const targetOf = (action: PDFDict | undefined): PDFDict | undefined => action?.lookupMaybe(N('T'), PDFDict);

/** What the target dictionary names: the page's body text and the annotation
 *  at /A, read as a reader of the saved file reads them. */
function named(doc: PDFDocument, target: PDFDict | undefined): string {
  if (!target) return 'no target';
  const page = target.lookup(N('P')), annotation = target.lookup(N('A'));
  if (!(page instanceof PDFNumber)) return `page ${String(page)}`;
  const index = page.asNumber();
  if (!(annotation instanceof PDFNumber)) return `page ${index + 1}, annotation ${String(annotation)}`;
  const listed = annotsOf(doc, index)[annotation.asNumber()];
  const contents = listed?.dict.lookup(N('Contents'));
  return `page ${index + 1}, ${listed ? subtypeOf(listed.dict) : 'nothing'} ${contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : ''}`;
}

/** The body text marker of each page of the saved file, in order. */
async function bodies(bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  const doc = await PDFDocument.load(bytes);
  for (let index = 0; index < doc.getPageCount(); index++) {
    const marks: string[] = [];
    for (const n of [1, 2, 3]) if ((await held(await isolate(doc, index), [`BODYOFPAGE${n}`])).length > 0) marks.push(`BODYOFPAGE${n}`);
    out.push(marks.join('+'));
  }
  return out;
}
async function isolate(doc: PDFDocument, index: number): Promise<Uint8Array> {
  const one = await PDFDocument.create();
  const [page] = await one.copyPages(doc, [index]);
  page.node.delete(N('Annots'));
  one.addPage(page);
  return one.save();
}

const deleteNote = (pages: PageRef[]): PageRef[] => pages.map((page, index) => index === 1 ? deleting(page, () => true) : page);
const editNote = (pages: PageRef[]): PageRef[] => pages.map((page, index) => index === 1
  ? { ...page, annotations: page.annotations!.map((a) => ({ ...a, note: 'EDITEDNOTE' })) } : page);

const ATTACHMENT = '/FileAttachment THEATTACHMENT';
const noMarker = async (bytes: Uint8Array) => expect(await held(bytes, ['SpectraBoundTarget'])).toEqual([]);

describe('an embedded go-to that names a file attachment annotation by position', () => {
  const byPosition = () => source(({ ctx, link }) => link.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 }))));

  it('reads the attachment in the source', async () => {
    const doc = await PDFDocument.load(await byPosition());
    expect(named(doc, targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict)))).toBe(`page 2, ${ATTACHMENT}`);
  });

  it.each([
    ['the annotation before it is deleted', deleteNote],
    ['the annotation before it is edited', editNote],
    ['no annotation changes', (pages: PageRef[]) => pages],
  ])('names the same attachment when %s, through two commits', async (_label, edit) => {
    const once = await commit(await byPosition(), edit);
    for (const bytes of [once, await commit(once)]) {
      const doc = await PDFDocument.load(bytes);
      const target = targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict));
      expect(named(doc, target)).toBe(`page 2, ${ATTACHMENT}`);
      await noMarker(bytes);
      await expectSound(bytes);
    }
  });

  it('names the new index after a delete of the annotation before it', async () => {
    const doc = await PDFDocument.load(await commit(await byPosition(), deleteNote));
    const target = targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict))!;
    expect([String(target.get(N('P'))), String(target.get(N('A')))]).toEqual(['1', '0']);
  });

  it('names the new page number after the page before it is deleted', async () => {
    const once = await commit(await byPosition(), ([, second, third]) => [second, third]);
    const doc = await PDFDocument.load(once);
    expect(await bodies(once)).toEqual(['BODYOFPAGE2', 'BODYOFPAGE3']);
    expect(named(doc, targetOf(linkAt(doc, 0).lookup(N('A'), PDFDict)))).toBe(`page 1, ${ATTACHMENT}`);
    await noMarker(once);
    await expectSound(once, ['BODYOFPAGE1']);
  });

  it('names the new page number after its page moves', async () => {
    const once = await commit(await byPosition(), ([first, second, third]) => [third, first, second]);
    const doc = await PDFDocument.load(once);
    expect(await bodies(once)).toEqual(['BODYOFPAGE3', 'BODYOFPAGE1', 'BODYOFPAGE2']);
    expect(named(doc, targetOf(linkAt(doc, 2).lookup(N('A'), PDFDict)))).toBe(`page 3, ${ATTACHMENT}`);
    await expectSound(once);
  });

  it('follows a page move and a delete before the annotation in one commit', async () => {
    const once = await commit(await byPosition(), (pages) => { const [first, second, third] = deleteNote(pages); return [second, third, first]; });
    const doc = await PDFDocument.load(once);
    const target = targetOf(linkAt(doc, 0).lookup(N('A'), PDFDict))!;
    expect(named(doc, target)).toBe(`page 1, ${ATTACHMENT}`);
    expect(String(target.get(N('A')))).toBe('0');
    await expectSound(once, ['FIRSTNOTE']);
  });

  it('follows an attachment written directly in /Annots', async () => {
    const direct = await source(({ ctx, link }) => link.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 }))), { directAttachment: true });
    const once = await commit(direct, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(named(doc, targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict)))).toBe(`page 2, ${ATTACHMENT}`);
    await expectSound(once, ['FIRSTNOTE']);
  });
});

describe('an embedded go-to whose page or annotation is gone', () => {
  const fromFarPage = (extra: Record<string, unknown> = {}) =>
    source(({ ctx, far }) => far.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 }, extra))));

  it('leaves a link of a kept page when the attachment page is deleted', async () => {
    const once = await commit(await fromFarPage(), ([first, , third]) => [first, third]);
    const doc = await PDFDocument.load(once);
    expect(linkAt(doc, 1).has(N('A'))).toBe(false);
    await noMarker(once);
    await expectSound(once, ['BODYOFPAGE2', 'THEATTACHMENT']);
    await expectSound(await commit(once), ['BODYOFPAGE2', 'THEATTACHMENT']);
  });

  it('gives its place to the next action of its chain', async () => {
    const chained = await source(({ ctx, far }) => {
      const next = ctx.obj({ S: 'URI' });
      next.set(N('URI'), PDFString.of('https://example.invalid/next'));
      far.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 }, { Next: ctx.register(next) })));
    });
    const once = await commit(chained, ([first, , third]) => [first, third]);
    const doc = await PDFDocument.load(once);
    expect(String(linkAt(doc, 1).lookup(N('A'), PDFDict).get(N('S')))).toBe('/URI');
    await expectSound(once, ['BODYOFPAGE2']);
  });

  it.each([
    ['a bookmark', (doc: PDFDocument, action: PDFObject) => {
      const ctx = doc.context, rootRef = ctx.nextRef();
      const item = ctx.obj({ Parent: rootRef, A: action });
      item.set(N('Title'), PDFString.of('Chapter'));
      const itemRef = ctx.register(item);
      ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
      doc.catalog.set(N('Outlines'), rootRef);
    }, (doc: PDFDocument) => doc.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict).lookupMaybe(N('A'), PDFDict)],
    ['the opening action', (doc: PDFDocument, action: PDFObject) => doc.catalog.set(N('OpenAction'), action),
      (doc: PDFDocument) => doc.catalog.lookupMaybe(N('OpenAction'), PDFDict)],
  ])('%s follows the attachment, and loses the action with its page', async (_label, wire, actionOf) => {
    const written = await source(({ doc, ctx }) => wire(doc, ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 }))));
    const moved = await commit(written, (pages) => { const [first, second, third] = deleteNote(pages); return [third, second, first]; });
    const movedDoc = await PDFDocument.load(moved);
    expect(named(movedDoc, targetOf(actionOf(movedDoc)))).toBe(`page 2, ${ATTACHMENT}`);
    expect(String(targetOf(actionOf(movedDoc))!.get(N('A')))).toBe('0');
    await noMarker(moved);
    await expectSound(moved, ['FIRSTNOTE']);
    const removed = await commit(written, ([first, , third]) => [first, third]);
    expect(actionOf(await PDFDocument.load(removed))).toBeUndefined();
    await expectSound(removed, ['BODYOFPAGE2']);
  });

  it('an action that names an annotation the user deletes leaves, and one the user edits is followed', async () => {
    const onNote = () => source(({ ctx, link }) => link.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 0 }))));
    const deleted = await PDFDocument.load(await commit(await onNote(), deleteNote));
    expect(linkAt(deleted, 1).has(N('A'))).toBe(false);
    const edited = await PDFDocument.load(await commit(await onNote(), editNote));
    expect(named(edited, targetOf(linkAt(edited, 1).lookup(N('A'), PDFDict)))).toBe('page 2, /Text EDITEDNOTE');
  });
});

describe('the parts of a target dictionary that are not positions in this document', () => {
  const reorder = (pages: PageRef[]): PageRef[] => { const [first, second, third] = deleteNote(pages); return [third, second, first]; };

  it('a nested target dictionary stays as written', async () => {
    const nested = await source(({ ctx, link }) => link.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1, T: { R: 'C', P: 1, A: 1, T: { R: 'P' } } }))));
    const once = await commit(nested, reorder);
    const doc = await PDFDocument.load(once);
    const outer = targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict))!;
    expect(named(doc, outer)).toBe(`page 2, ${ATTACHMENT}`);
    expect(String(outer.get(N('A')))).toBe('0');
    const inner = outer.lookup(N('T'), PDFDict);
    expect([String(inner.get(N('R'))), String(inner.get(N('P'))), String(inner.get(N('A')))]).toEqual(['/C', '1', '1']);
    expect(String(inner.lookup(N('T'), PDFDict).get(N('R')))).toBe('/P');
    await noMarker(once);
  });

  it('an annotation named by /NM keeps its name, and the page number follows the page', async () => {
    const byName = await source(({ ctx, link }) => {
      const action = embedded(ctx, { R: 'C', P: 1 });
      action.lookup(N('T'), PDFDict).set(N('A'), PDFString.of('attachment-name'));
      link.set(N('A'), ctx.register(action));
    });
    const once = await commit(byName, ([, second, third]) => [second, third]);
    const doc = await PDFDocument.load(once);
    const target = targetOf(linkAt(doc, 0).lookup(N('A'), PDFDict))!;
    expect(target.lookup(N('A'), PDFString).decodeText()).toBe('attachment-name');
    expect(String(target.get(N('P')))).toBe('0');
    await noMarker(once);
    await expectSound(once, ['BODYOFPAGE1']);
  });

  it('a page named by a destination is bound to the page that destination names', async () => {
    const byDestination = await source(({ doc, ctx, pages, link }) => {
      doc.catalog.set(N('Dests'), ctx.obj({ attachmentPage: [pages[1].ref, 'Fit'] }));
      const names = ctx.obj({});
      names.set(N('Names'), ctx.obj([PDFString.of('attachment-page'), ctx.obj([pages[1].ref, N('Fit')])]));
      doc.catalog.set(N('Names'), ctx.obj({ Dests: names }));
      const action = embedded(ctx, { R: 'C', A: 1 });
      action.lookup(N('T'), PDFDict).set(N('P'), PDFString.of('attachment-page'));
      link.set(N('A'), ctx.register(action));
    });
    const once = await commit(byDestination, reorder);
    const doc = await PDFDocument.load(once);
    expect(named(doc, targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict)))).toBe(`page 2, ${ATTACHMENT}`);
    await expectSound(once, ['FIRSTNOTE']);
  });

  it.each([
    ['with /F, whose path starts in another file', { R: 'C', P: 1, A: 1 }, true],
    ['whose first element is the parent', { R: 'P', P: 1, A: 1 }, false],
    ['whose page number names no page', { R: 'C', P: 9, A: 1 }, false],
    ['whose index names no annotation', { R: 'C', P: 1, A: 9 }, false],
  ])('an action %s stays as written', async (_label, target, withFile) => {
    const written = await source(({ ctx, link }) => {
      const action = embedded(ctx, target);
      if (withFile) action.set(N('F'), PDFString.of('other.pdf'));
      link.set(N('A'), ctx.register(action));
    });
    const once = await commit(written, reorder);
    const doc = await PDFDocument.load(once);
    const kept = targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict))!;
    expect([String(kept.get(N('R'))), String(kept.get(N('P'))), String(kept.get(N('A')))])
      .toEqual([`/${String(target.R)}`, String(target.P), String(target.A)]);
    await noMarker(once);
    await expectSound(once, ['FIRSTNOTE']);
  });

  it('a marker key the input wrote is not read as a binding', async () => {
    const marked = await source(({ ctx, link }) => {
      const action = embedded(ctx, { R: 'C', P: 9, A: 1, SpectraBoundTarget: true });
      link.set(N('A'), ctx.register(action));
    });
    const doc = await PDFDocument.load(await commit(marked, reorder));
    const kept = targetOf(linkAt(doc, 1).lookup(N('A'), PDFDict))!;
    expect([String(kept.get(N('P'))), String(kept.get(N('A')))]).toEqual(['9', '1']);
  });

  it('two actions share one target dictionary', async () => {
    const shared = await source(({ ctx, link, far }) => {
      const target = ctx.register(ctx.obj({ R: 'C', P: 1, A: 1 }));
      for (const holder of [link, far]) {
        const action = ctx.obj({ S: 'GoToE', T: target });
        action.set(N('D'), PDFString.of('Chapter 1'));
        holder.set(N('A'), ctx.register(action));
      }
    });
    const once = await commit(shared, reorder);
    const doc = await PDFDocument.load(once);
    for (const pageIndex of [0, 1]) {
      expect(named(doc, targetOf(linkAt(doc, pageIndex).lookup(N('A'), PDFDict)))).toBe(`page 2, ${ATTACHMENT}`);
    }
    await noMarker(once);
  });

  it('the /Annots of the page lists each annotation once after the commit', async () => {
    const once = await commit(await source(({ ctx, link }) => link.set(N('A'), ctx.register(embedded(ctx, { R: 'C', P: 1, A: 1 })))), editNote);
    const doc = await PDFDocument.load(once);
    expect(annotsOf(doc, 1).map((a) => subtypeOf(a.dict)).sort()).toEqual(['/FileAttachment', '/Link', '/Text']);
    expect(doc.getPage(1).node.lookup(N('Annots'), PDFArray).size()).toBe(3);
  });
});
