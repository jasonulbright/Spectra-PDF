// An action can name an annotation by reference: Hide /T, Rendition /AN,
// Movie /Annotation (ISO 32000-2 12.6.4). When a commit replaces that
// annotation the action names the replacement. When the user deletes it, or
// deletes its page, the action leaves its chain as a jump to a removed page
// does, and the commit succeeds.

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject, PDFPage } from 'pdf-lib';
import { commit, deleting } from './support/commit-cycle';
import { annotsOf, brief, expectSound, shown, subtypeOf } from './support/saved-pdf';
import type { PageRef } from '../src/renderer/state/types';

const N = PDFName.of;

interface Parts { doc: PDFDocument; ctx: PDFContext; page: PDFPage; note: PDFRef; link: PDFDict }

/** One page: a note the import reads and re-authors, and a link it leaves
 *  alone. `wire` adds the action under test. */
async function noteAndLink(wire: (parts: Parts) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const ctx = doc.context;
  const noteDict = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  noteDict.set(N('Contents'), PDFHexString.fromText('TARGETNOTE'));
  const note = ctx.register(noteDict);
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 498, 202, 522] });
  page.node.set(N('Annots'), ctx.obj([note, ctx.register(link)]));
  wire({ doc, ctx, page, note, link });
  return doc.save();
}

const hide = (ctx: PDFContext, target: PDFObject, extra: Record<string, unknown> = {}): PDFDict =>
  ctx.obj({ Type: 'Action', S: 'Hide', T: target, H: true, ...extra });

function outlineWith(doc: PDFDocument, action: PDFObject): void {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const item = ctx.obj({ Parent: rootRef, A: action });
  item.set(N('Title'), PDFString.of('Chapter'));
  const itemRef = ctx.register(item);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  doc.catalog.set(N('Outlines'), rootRef);
}

const editNote = (text: string) => ([page, ...rest]: PageRef[]): PageRef[] => [
  { ...page, annotations: page.annotations!.map((a) => ({ ...a, note: text })) }, ...rest,
];
const deleteNote = ([page, ...rest]: PageRef[]): PageRef[] => [deleting(page, () => true), ...rest];

/** What a Hide action's /T names: each target's subtype, text and whether a
 *  page lists it; a text string target reads as its characters. */
function targetsOf(doc: PDFDocument, action: PDFDict | undefined): string[] | null {
  if (!action) return null;
  const raw = action.get(N('T'));
  const value = doc.context.lookup(raw);
  const entries = value instanceof PDFArray ? value.asArray() : raw === undefined ? [] : [raw];
  const listed = new Set(doc.getPages().flatMap((_, index) => annotsOf(doc, index).map((a) => a.ref)));
  return entries.map((entry) => {
    const target = doc.context.lookup(entry);
    if (target instanceof PDFString || target instanceof PDFHexString) return `name:${target.decodeText()}`;
    if (!(target instanceof PDFDict)) return 'missing';
    const contents = target.lookup(N('Contents'));
    const text = contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : '';
    return `${subtypeOf(target)}:${text}:${listed.has(entry) ? 'listed' : 'unlisted'}`;
  });
}

const linkOf = (doc: PDFDocument, pageIndex = 0): PDFDict => annotsOf(doc, pageIndex).find((a) => subtypeOf(a.dict) === '/Link')!.dict;
const linkAction = (doc: PDFDocument, pageIndex = 0): PDFDict | undefined => linkOf(doc, pageIndex).lookupMaybe(N('A'), PDFDict);
const outlineItem = (doc: PDFDocument): PDFDict => doc.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);

describe('a link action that names an annotation of its page', () => {
  const source = () => noteAndLink(({ ctx, note, link }) => link.set(N('A'), ctx.register(hide(ctx, note))));

  it('names the re-authored annotation after a commit with no edit, through two commits', async () => {
    const once = await commit(await source());
    expect(targetsOf(await PDFDocument.load(once), linkAction(await PDFDocument.load(once)))).toBeDefined();
    for (const bytes of [once, await commit(once)]) {
      const doc = await PDFDocument.load(bytes);
      expect(targetsOf(doc, linkAction(doc))).toEqual(['/Text:TARGETNOTE:listed']);
      expect(brief(await shown(bytes))).toEqual(['Link:', 'Text:TARGETNOTE']);
      await expectSound(bytes);
    }
  });

  it('names the edited annotation, and the old text is gone', async () => {
    const once = await commit(await source(), editNote('EDITED'));
    const doc = await PDFDocument.load(once);
    expect(targetsOf(doc, linkAction(doc))).toEqual(['/Text:EDITED:listed']);
    await expectSound(once, ['TARGETNOTE']);
  });

  it('leaves the link when the user deletes the annotation', async () => {
    const once = await commit(await source(), deleteNote);
    const doc = await PDFDocument.load(once);
    expect(linkOf(doc).has(N('A'))).toBe(false);
    expect(brief(await shown(once))).toEqual(['Link:']);
    await expectSound(once, ['TARGETNOTE']);
    await expectSound(await commit(once), ['TARGETNOTE']);
  });

  it('gives its place to the next action of its chain', async () => {
    const chained = await noteAndLink(({ ctx, note, link }) => {
      const uri = ctx.obj({ S: 'URI' });
      uri.set(N('URI'), PDFString.of('https://example.invalid/next'));
      link.set(N('A'), ctx.register(hide(ctx, note, { Next: ctx.register(uri) })));
    });
    const once = await commit(chained, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(String(linkAction(doc)?.get(N('S')))).toBe('/URI');
    await expectSound(once, ['TARGETNOTE']);
  });

  it('keeps the other targets of a list and loses the deleted one', async () => {
    const listed = await noteAndLink(({ ctx, page, note, link }) => {
      const other = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 50] }));
      page.node.lookup(N('Annots'), PDFArray).push(other);
      link.set(N('A'), ctx.register(hide(ctx, ctx.obj([note, other, PDFString.of('field.name')]))));
    });
    const kept = await commit(listed, editNote('EDITED'));
    const keptDoc = await PDFDocument.load(kept);
    expect(targetsOf(keptDoc, linkAction(keptDoc))).toEqual(['/Text:EDITED:listed', '/Link::listed', 'name:field.name']);
    await expectSound(kept, ['TARGETNOTE']);
    const once = await commit(listed, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(targetsOf(doc, linkAction(doc))).toEqual(['/Link::listed', 'name:field.name']);
    await expectSound(once, ['TARGETNOTE']);
  });

  it('a trigger of a widget follows the same rule', async () => {
    const withWidget = await noteAndLink(({ doc, ctx, page, note }) => {
      const field = doc.getForm().createTextField('toggle');
      field.addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
      field.acroField.getWidgets()[0].dict.set(N('AA'), ctx.obj({ U: ctx.register(hide(ctx, note)), D: ctx.register(hide(ctx, note)) }));
    });
    const triggers = (doc: PDFDocument): PDFDict | undefined =>
      annotsOf(doc).find((a) => subtypeOf(a.dict) === '/Widget')!.dict.lookupMaybe(N('AA'), PDFDict);
    const edited = await commit(withWidget, editNote('EDITED'));
    const editedDoc = await PDFDocument.load(edited);
    expect(targetsOf(editedDoc, triggers(editedDoc)?.lookup(N('U'), PDFDict))).toEqual(['/Text:EDITED:listed']);
    // The form is pdf-lib's: its field names a font the form's default
    // resources do not hold. The commit keeps the form as written.
    await expectSound(edited, ['TARGETNOTE'], undefined, withWidget);
    const once = await commit(withWidget, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(triggers(doc)?.keys() ?? []).toEqual([]);
    await expectSound(once, ['TARGETNOTE'], undefined, withWidget);
  });
});

describe('a bookmark or opening action that names an annotation', () => {
  it.each([
    ['a bookmark', (parts: Parts) => outlineWith(parts.doc, parts.ctx.register(hide(parts.ctx, parts.note))),
      (doc: PDFDocument) => outlineItem(doc).lookupMaybe(N('A'), PDFDict)],
    ['the opening action', (parts: Parts) => parts.doc.catalog.set(N('OpenAction'), parts.ctx.register(hide(parts.ctx, parts.note))),
      (doc: PDFDocument) => doc.catalog.lookupMaybe(N('OpenAction'), PDFDict)],
  ])('%s names the replacement of an edited annotation and loses a deleted one', async (_label, wire, actionOf) => {
    const source = await noteAndLink(wire);
    const edited = await commit(source, editNote('EDITED'));
    const editedDoc = await PDFDocument.load(edited);
    expect(targetsOf(editedDoc, actionOf(editedDoc))).toEqual(['/Text:EDITED:listed']);
    await expectSound(edited, ['TARGETNOTE']);
    const again = await commit(edited);
    const againDoc = await PDFDocument.load(again);
    expect(targetsOf(againDoc, actionOf(againDoc))).toEqual(['/Text:EDITED:listed']);
    await expectSound(again, ['TARGETNOTE']);

    const once = await commit(source, deleteNote);
    const doc = await PDFDocument.load(once);
    expect(actionOf(doc)).toBeUndefined();
    expect(brief(await shown(once))).toEqual(['Link:']);
    await expectSound(once, ['TARGETNOTE']);
  });

  it('a bookmark keeps its title when its action leaves', async () => {
    const source = await noteAndLink(({ doc, ctx, note }) => outlineWith(doc, ctx.register(hide(ctx, note))));
    const doc = await PDFDocument.load(await commit(source, deleteNote));
    expect(outlineItem(doc).lookup(N('Title'), PDFString).decodeText()).toBe('Chapter');
  });
});

/** Page 1 holds the target annotation and body text. Page 2 holds a link.
 *  `wire` adds the action that names the target. */
async function targetOnFirstPage(
  target: Record<string, unknown>,
  wire: (parts: { doc: PDFDocument; ctx: PDFContext; target: PDFRef; link: PDFDict }) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second = doc.addPage([300, 600]);
  const ctx = doc.context;
  const dict = ctx.obj({ Type: 'Annot', Rect: [50, 50, 90, 90], P: first.ref, ...target });
  dict.set(N('Contents'), PDFHexString.fromText('PAGEONETARGET'));
  const targetRef = ctx.register(dict);
  first.node.set(N('Annots'), ctx.obj([targetRef]));
  first.node.set(N('Contents'), ctx.register(ctx.stream('BT 20 300 Td ET % PAGEONEBODY')));
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 498, 202, 522] });
  second.node.set(N('Annots'), ctx.obj([ctx.register(link)]));
  wire({ doc, ctx, target: targetRef, link });
  return doc.save();
}

const REMOVED_PAGE = ['PAGEONETARGET', 'PAGEONEBODY'];

describe('an action that names an annotation of a removed page', () => {
  it.each([
    ['Hide /T', { Subtype: 'Square' }, (ctx: PDFContext, target: PDFRef) => hide(ctx, target)],
    ['Rendition /AN', { Subtype: 'Screen' }, (ctx: PDFContext, target: PDFRef) => ctx.obj({ S: 'Rendition', AN: target, OP: 4 })],
    ['Movie /Annotation', { Subtype: 'Movie' }, (ctx: PDFContext, target: PDFRef) => ctx.obj({ S: 'Movie', Annotation: target })],
    ['GoTo3DView /TA', { Subtype: '3D' }, (ctx: PDFContext, target: PDFRef) => ctx.obj({ S: 'GoTo3DView', TA: target, V: 'F' })],
    ['RichMediaExecute /TA', { Subtype: 'RichMedia' }, (ctx: PDFContext, target: PDFRef) => ctx.obj({ S: 'RichMediaExecute', TA: target })],
  ])('%s on a link of a kept page leaves the link, and the removed page is not in the file', async (_label, target, action) => {
    const source = await targetOnFirstPage(target, ({ ctx, target: ref, link }) => link.set(N('A'), ctx.register(action(ctx, ref))));
    const once = await commit(source, ([, second]) => [second]);
    const doc = await PDFDocument.load(once);
    expect(doc.getPageCount()).toBe(1);
    expect(linkOf(doc).has(N('A'))).toBe(false);
    await expectSound(once, REMOVED_PAGE);
    await expectSound(await commit(once), REMOVED_PAGE);
  });

  it.each([
    ['a bookmark', (doc: PDFDocument, action: PDFRef) => outlineWith(doc, action), (doc: PDFDocument) => outlineItem(doc).has(N('A'))],
    ['the opening action', (doc: PDFDocument, action: PDFRef) => doc.catalog.set(N('OpenAction'), action), (doc: PDFDocument) => doc.catalog.has(N('OpenAction'))],
  ])('%s loses the action, and the commit succeeds', async (_label, wire, hasAction) => {
    const source = await targetOnFirstPage({ Subtype: 'Square' }, ({ doc, ctx, target }) => wire(doc, ctx.register(hide(ctx, target))));
    const once = await commit(source, ([, second]) => [second]);
    const doc = await PDFDocument.load(once);
    expect(doc.getPageCount()).toBe(1);
    expect(hasAction(doc)).toBe(false);
    await expectSound(once, REMOVED_PAGE);
  });

  it('an action that names an annotation of a kept page stays as written', async () => {
    const source = await targetOnFirstPage({ Subtype: 'Screen' }, ({ ctx, target, link }) => link.set(N('A'), ctx.register(ctx.obj({ S: 'Rendition', AN: target, OP: 4 }))));
    const once = await commit(source);
    const doc = await PDFDocument.load(once);
    const named = linkAction(doc, 1)?.get(N('AN'));
    expect(named).toBe(annotsOf(doc, 0)[0].ref);
    await expectSound(once);
  });
});
