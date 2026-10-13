// One action object can have several holders: a link, a catalog trigger, a
// bookmark, the /Next of two other actions. A build settles the holders in
// more than one pass. Every pass gives the same answer for the shared action:
// it leaves each holder, and its surviving /Next actions are spliced once.

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import {
  actionSettler, annotationTargetLoss, anyLoss, bindEmbeddedTargets, embeddedTargetLoss, goToLoss, newActionSettlement,
} from '../src/renderer/lib/catalog-carry';
import { reachableDictionaries } from '../src/renderer/lib/pdf-reachability';
import { commit, deleting } from './support/commit-cycle';
import { annotsOf, expectSound, subtypeOf } from './support/saved-pdf';
import type { PageRef } from '../src/renderer/state/types';

const N = PDFName.of;

interface Parts { doc: PDFDocument; ctx: PDFContext; target: PDFRef; note: PDFRef; links: PDFDict[] }

/** Page 1 holds a target annotation. Page 2 holds a note the import reads and
 *  three links. `wire` adds the actions under test. */
async function twoPages(wire: (parts: Parts) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second = doc.addPage([300, 600]);
  const ctx = doc.context;
  const targetDict = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [50, 50, 90, 90], P: first.ref });
  targetDict.set(N('Contents'), PDFHexString.fromText('PAGEONETARGET'));
  const target = ctx.register(targetDict);
  first.node.set(N('Annots'), ctx.obj([target]));
  const noteDict = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  noteDict.set(N('Contents'), PDFHexString.fromText('PAGETWONOTE'));
  const note = ctx.register(noteDict);
  const links = [0, 1, 2].map((i) => ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 400 + 30 * i, 202, 420 + 30 * i] }));
  second.node.set(N('Annots'), ctx.obj([note, ...links.map((link) => ctx.register(link))]));
  wire({ doc, ctx, target, note, links });
  return doc.save();
}

const uri = (ctx: PDFContext, address: string, extra: Record<string, unknown> = {}): PDFDict => {
  const action = ctx.obj({ S: 'URI', ...extra });
  action.set(N('URI'), PDFString.of(address));
  return action;
};
const hideList = (ctx: PDFContext, targets: PDFObject[], extra: Record<string, unknown> = {}): PDFDict =>
  ctx.obj({ Type: 'Action', S: 'Hide', T: targets, H: true, ...extra });

const dropFirstPage = ([, second]: PageRef[]): PageRef[] => [second];
const deleteNote = ([first, second]: PageRef[]): PageRef[] => [first, deleting(second, () => true)];

/** The kinds of every action the saved file's catalog reaches. */
function actionKinds(doc: PDFDocument): string[] {
  return reachableDictionaries(doc.context, [doc.context.trailerInfo.Root])
    .map((dict) => String(dict.get(N('S'))))
    .filter((kind) => ['/Hide', '/URI', '/GoTo', '/GoToE'].includes(kind))
    .sort();
}

/** The chain an action heads, as the address of each URI action in execution
 *  order; another kind reads as its /S. */
function chain(doc: PDFDocument, head: PDFObject | undefined): string[] {
  const out: string[] = [];
  const walk = (raw: PDFObject | undefined): void => {
    const action = doc.context.lookup(raw);
    if (!(action instanceof PDFDict)) return;
    const address = action.lookup(N('URI'));
    out.push(address instanceof PDFString ? address.decodeText() : String(action.get(N('S'))));
    const next = doc.context.lookup(action.get(N('Next')));
    if (next instanceof PDFArray) next.asArray().forEach(walk);
    else walk(action.get(N('Next')));
  };
  walk(head);
  return out;
}

const links = (doc: PDFDocument, pageIndex = 0): PDFDict[] =>
  annotsOf(doc, pageIndex).filter((a) => subtypeOf(a.dict) === '/Link').map((a) => a.dict);
const triggers = (doc: PDFDocument): PDFDict | undefined => doc.catalog.lookupMaybe(N('AA'), PDFDict);

describe('a Hide action whose target list a removed page empties', () => {
  it('leaves a link and a catalog trigger that share it', async () => {
    const source = await twoPages(({ doc, ctx, target, links: [link] }) => {
      const shared = ctx.register(hideList(ctx, [target]));
      link.set(N('A'), shared);
      doc.catalog.set(N('AA'), ctx.obj({ WC: shared }));
    });
    const once = await commit(source, dropFirstPage);
    const doc = await PDFDocument.load(once);
    expect(links(doc).map((link) => link.has(N('A')))).toEqual([false, false, false]);
    expect(triggers(doc)?.keys() ?? []).toEqual([]);
    expect(actionKinds(doc)).toEqual([]);
    await expectSound(once, ['PAGEONETARGET']);
    await expectSound(await commit(once), ['PAGEONETARGET']);
  });

  it('leaves three links, a bookmark, the opening action and a catalog trigger that share it', async () => {
    const source = await twoPages(({ doc, ctx, target, links: holders }) => {
      const shared = ctx.register(hideList(ctx, [target]));
      holders.forEach((link) => link.set(N('A'), shared));
      doc.catalog.set(N('AA'), ctx.obj({ WC: shared, DS: shared }));
      doc.catalog.set(N('OpenAction'), shared);
      const rootRef = ctx.nextRef();
      const item = ctx.obj({ Parent: rootRef, A: shared });
      item.set(N('Title'), PDFString.of('Chapter'));
      const itemRef = ctx.register(item);
      ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
      doc.catalog.set(N('Outlines'), rootRef);
    });
    const once = await commit(source, dropFirstPage);
    const doc = await PDFDocument.load(once);
    expect(links(doc).map((link) => link.has(N('A')))).toEqual([false, false, false]);
    expect(triggers(doc)?.keys() ?? []).toEqual([]);
    expect(doc.catalog.has(N('OpenAction'))).toBe(false);
    expect(doc.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict).has(N('A'))).toBe(false);
    expect(actionKinds(doc)).toEqual([]);
    await expectSound(once, ['PAGEONETARGET']);
  });

  it('leaves two chains that reach it through /Next, one on a link and one in the catalog', async () => {
    const source = await twoPages(({ doc, ctx, target, links: [link] }) => {
      const shared = ctx.register(hideList(ctx, [target]));
      link.set(N('A'), ctx.register(uri(ctx, 'https://example.invalid/link', { Next: shared })));
      doc.catalog.set(N('AA'), ctx.obj({ WC: ctx.register(uri(ctx, 'https://example.invalid/catalog', { Next: shared })) }));
    });
    const once = await commit(source, dropFirstPage);
    const doc = await PDFDocument.load(once);
    expect(chain(doc, links(doc)[0].get(N('A')))).toEqual(['https://example.invalid/link']);
    expect(chain(doc, triggers(doc)?.get(N('WC')))).toEqual(['https://example.invalid/catalog']);
    expect(actionKinds(doc)).toEqual(['/URI', '/URI']);
    await expectSound(once, ['PAGEONETARGET']);
  });

  it('leaves a catalog trigger when the user deletes the only listed annotation', async () => {
    const source = await twoPages(({ doc, ctx, note }) => {
      const shared = ctx.register(hideList(ctx, [note]));
      doc.catalog.set(N('AA'), ctx.obj({ WC: shared }));
      doc.catalog.set(N('OpenAction'), shared);
    });
    const once = await commit(source, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(triggers(doc)?.keys() ?? []).toEqual([]);
    expect(doc.catalog.has(N('OpenAction'))).toBe(false);
    expect(actionKinds(doc)).toEqual([]);
    await expectSound(once, ['PAGETWONOTE']);
  });

  it('two Hide actions that share one target list both leave', async () => {
    const source = await twoPages(({ doc, ctx, target, links: [first, second] }) => {
      const list = ctx.register(ctx.obj([target]));
      first.set(N('A'), ctx.register(ctx.obj({ S: 'Hide', T: list })));
      second.set(N('A'), ctx.register(ctx.obj({ S: 'Hide', T: list })));
      doc.catalog.set(N('OpenAction'), ctx.register(ctx.obj({ S: 'Hide', T: list })));
    });
    const once = await commit(source, dropFirstPage);
    const doc = await PDFDocument.load(once);
    expect(links(doc).map((link) => link.has(N('A')))).toEqual([false, false, false]);
    expect(doc.catalog.has(N('OpenAction'))).toBe(false);
    await expectSound(once, ['PAGEONETARGET']);
  });

  it('a Hide action written with an empty list stays', async () => {
    const source = await twoPages(({ ctx, links: [link] }) => link.set(N('A'), ctx.register(hideList(ctx, []))));
    const doc = await PDFDocument.load(await commit(source, dropFirstPage));
    expect(chain(doc, links(doc)[0].get(N('A')))).toEqual(['/Hide']);
  });
});

describe('the actions after a shared action that leaves are spliced once', () => {
  it.each([
    ['a Hide of an annotation of a removed page', (ctx: PDFContext, parts: Parts, next: PDFObject) => hideList(ctx, [parts.target], { Next: next })],
    ['a GoTo to a removed page', (ctx: PDFContext, parts: Parts, next: PDFObject) =>
      ctx.obj({ S: 'GoTo', D: [parts.doc.getPage(0).ref, 'Fit'], Next: next })],
  ])('%s, shared by a link, a second link and a catalog trigger', async (_label, lostAction) => {
    const source = await twoPages((parts) => {
      const { doc, ctx, links: [first, second] } = parts;
      const tail = [ctx.register(uri(ctx, 'https://example.invalid/one')), ctx.register(uri(ctx, 'https://example.invalid/two')),
        ctx.register(uri(ctx, 'https://example.invalid/three'))];
      const shared = ctx.register(lostAction(ctx, parts, ctx.obj(tail)));
      first.set(N('A'), shared);
      second.set(N('A'), shared);
      doc.catalog.set(N('AA'), ctx.obj({ WC: shared }));
      doc.catalog.set(N('OpenAction'), shared);
    });
    const expected = ['https://example.invalid/one', 'https://example.invalid/two', 'https://example.invalid/three'];
    const once = await commit(source, dropFirstPage);
    const doc = await PDFDocument.load(once);
    expect(chain(doc, links(doc)[0].get(N('A')))).toEqual(expected);
    expect(chain(doc, links(doc)[1].get(N('A')))).toEqual(expected);
    expect(chain(doc, triggers(doc)?.get(N('WC')))).toEqual(expected);
    expect(chain(doc, doc.catalog.get(N('OpenAction')))).toEqual(expected);
    await expectSound(once, ['PAGEONETARGET']);
    const twice = await PDFDocument.load(await commit(once));
    expect(chain(twice, triggers(twice)?.get(N('WC')))).toEqual(expected);
  });
});

describe('a loss predicate gives the same answer when asked again', () => {
  async function scratch(): Promise<{ doc: PDFDocument; ctx: PDFContext; page: PDFRef; annotation: PDFRef }> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const annotation = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [0, 0, 10, 10] }));
    page.node.set(N('Annots'), doc.context.obj([annotation]));
    return { doc, ctx: doc.context, page: page.ref, annotation };
  }

  it('a Hide list, a single target, a GoTo and an embedded go-to', async () => {
    const { doc, ctx, page, annotation } = await scratch();
    const gone = () => undefined;
    const list = hideList(ctx, [annotation]);
    const single = ctx.obj({ S: 'Hide', T: annotation });
    const jump = ctx.obj({ S: 'GoTo', D: [page, 'Fit'] });
    const embedded = ctx.obj({ S: 'GoToE', D: [0, 'Fit'], T: { R: 'C', P: 0, A: 0 } });
    doc.catalog.set(N('OpenAction'), ctx.register(embedded));
    expect(bindEmbeddedTargets(doc)).toBe(1);
    const lost = anyLoss(goToLoss(() => true), annotationTargetLoss(ctx, gone), embeddedTargetLoss(ctx, () => true, gone));
    for (const action of [list, single, jump, embedded]) {
      expect([lost(action), lost(action), lost(action)]).toEqual([true, true, true]);
    }
  });

  it('a second predicate of the same build reads a list the first emptied as lost', async () => {
    const { ctx, annotation } = await scratch();
    const settlement = newActionSettlement();
    const list = hideList(ctx, [annotation]);
    expect(annotationTargetLoss(ctx, () => undefined, settlement)(list)).toBe(true);
    expect(annotationTargetLoss(ctx, (target) => target, settlement)(list)).toBe(true);
    expect(annotationTargetLoss(ctx, (target) => target)(hideList(ctx, []))).toBe(false);
  });

  it('a second settler of the same build does not splice a chain again', async () => {
    const { ctx, annotation } = await scratch();
    const settlement = newActionSettlement();
    const one = ctx.register(uri(ctx, 'one')), two = ctx.register(uri(ctx, 'two'));
    const head = ctx.register(hideList(ctx, [annotation], { Next: [one, two] }));
    const lost = annotationTargetLoss(ctx, () => undefined, settlement);
    expect(actionSettler(ctx, lost, settlement)(head)).toBe(one);
    expect(actionSettler(ctx, lost, settlement)(head)).toBe(one);
    expect(ctx.lookup(one, PDFDict).lookup(N('Next'), PDFArray).asArray()).toEqual([two]);
  });
});
