import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject, PDFPage } from 'pdf-lib';
import { commit, deleting } from './support/commit-cycle';
import { annotsOf, brief, expectSound, held, qpdfReading, shown, subtypeOf } from './support/saved-pdf';
import type { PageRef } from '../src/renderer/state/types';

const N = PDFName.of;
const QUAD = [100, 520, 200, 520, 100, 500, 200, 500];

function textNote(ctx: PDFContext, text: string, extra: Record<string, unknown> = {}): PDFDict {
  const note = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4, ...extra });
  note.set(N('Contents'), PDFHexString.fromText(text));
  return note;
}

function formStream(ctx: PDFContext, content: string): PDFRef {
  return ctx.register(ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }));
}

/** A note with an appearance stream, rich text held by reference, and a popup
 *  with an entry of its own. */
async function noteWithParts(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const ctx = doc.context;
  const note = textNote(ctx, 'SECRETNOTE', { AP: { N: formStream(ctx, '% SECRETAPPEARANCE') }, P: page.ref });
  note.set(N('RC'), ctx.register(PDFString.of('<body xmlns="http://www.w3.org/1999/xhtml"><p>SECRETRICH</p></body>')));
  const noteRef = ctx.register(note);
  const popup = ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [40, 300, 200, 390], Parent: noteRef, P: page.ref });
  popup.set(N('T'), PDFString.of('SECRETPOPUP'));
  const popupRef = ctx.register(popup);
  note.set(N('Popup'), popupRef);
  page.node.set(N('Annots'), ctx.obj([noteRef, popupRef]));
  return doc.save();
}

const NOTE_PARTS = ['SECRETNOTE', 'SECRETAPPEARANCE', 'SECRETRICH', 'SECRETPOPUP'];

describe('a deleted annotation leaves nothing in the saved file', () => {
  it('the note, its appearance, its rich text and its popup are gone, through two commits', async () => {
    const source = await noteWithParts();
    expect(await held(source, NOTE_PARTS)).toEqual(NOTE_PARTS);
    const once = await commit(source, ([page]) => [deleting(page, () => true)]);
    expect(await shown(once)).toEqual([]);
    await expectSound(once, NOTE_PARTS);
    const twice = await commit(once);
    expect(await shown(twice)).toEqual([]);
    await expectSound(twice, NOTE_PARTS);
  });

  it('an edited note leaves no copy of its old text, and its popup follows the new note', async () => {
    const source = await noteWithParts();
    const once = await commit(source, ([page]) => [{
      ...page, annotations: page.annotations!.map((a) => ({ ...a, note: 'NEWTEXT' })),
    }]);
    expect(brief(await shown(once))).toEqual(['Popup:NEWTEXT', 'Text:NEWTEXT']);
    await expectSound(once, ['SECRETNOTE', 'SECRETAPPEARANCE', 'SECRETRICH']);
    const linked = async (bytes: Uint8Array) => {
      const doc = await PDFDocument.load(bytes);
      const annots = annotsOf(doc);
      const note = annots.find((a) => subtypeOf(a.dict) === '/Text')!;
      const popup = annots.find((a) => subtypeOf(a.dict) === '/Popup')!;
      return { popupParent: popup.dict.get(N('Parent')) === note.ref, notePopup: note.dict.get(N('Popup')) === popup.ref, count: annots.length };
    };
    expect(await linked(once)).toEqual({ popupParent: true, notePopup: true, count: 2 });
    const twice = await commit(once);
    expect(brief(await shown(twice))).toEqual(['Popup:NEWTEXT', 'Text:NEWTEXT']);
    expect(await linked(twice)).toEqual({ popupParent: true, notePopup: true, count: 2 });
    await expectSound(twice, ['SECRETNOTE', 'SECRETAPPEARANCE', 'SECRETRICH']);
  });

  it('an appearance stream a surviving annotation shares stays, and the deleted one\'s own parts go', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    const ctx = doc.context;
    const shared = formStream(ctx, '% SHAREDAPPEARANCE');
    const square = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [50, 50, 120, 120], C: [1, 0, 0], AP: { N: shared, D: formStream(ctx, '% SQUAREDOWN') } });
    square.set(N('Contents'), PDFHexString.fromText('SQUARENOTE'));
    const caret = ctx.obj({ Type: 'Annot', Subtype: 'Caret', Rect: [150, 50, 170, 70], AP: { N: shared } });
    page.node.set(N('Annots'), ctx.obj([ctx.register(square), ctx.register(caret)]));
    const source = await doc.save();
    const once = await commit(source, ([only]) => [deleting(only, () => true)]);
    expect(brief(await shown(once))).toEqual(['Caret:']);
    await expectSound(once, ['SQUARENOTE', 'SQUAREDOWN']);
    expect(await held(once, ['SHAREDAPPEARANCE'])).toEqual(['SHAREDAPPEARANCE']);
    const saved = await PDFDocument.load(once);
    const normal = annotsOf(saved)[0].dict.lookup(N('AP'), PDFDict).lookup(N('N'));
    expect(normal).toBeInstanceOf(PDFStream);
    const twice = await commit(once);
    expect(await held(twice, ['SHAREDAPPEARANCE'])).toEqual(['SHAREDAPPEARANCE']);
    await expectSound(twice, ['SQUARENOTE', 'SQUAREDOWN']);
  });

  it('a file with form fields keeps them', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 600]);
    doc.getForm().createTextField('name.first').addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
    const annots = page.node.lookup(N('Annots'), PDFArray);
    annots.push(doc.context.register(textNote(doc.context, 'FORMPAGENOTE')));
    const source = await doc.save();
    const once = await commit(source, ([only]) => [deleting(only, () => true)]);
    // The form is pdf-lib's: its field names a font the form's default
    // resources do not hold. The commit keeps the form as written.
    await expectSound(once, ['FORMPAGENOTE'], undefined, source);
    const saved = await PDFDocument.load(once);
    expect(saved.getForm().getFields().map((field) => field.getName())).toEqual(['name.first']);
    expect(annotsOf(saved).map((a) => subtypeOf(a.dict))).toEqual(['/Widget']);
    expect(saved.getForm().getTextField('name.first').acroField.getWidgets()[0].dict).toBe(annotsOf(saved)[0].dict);
  });
});

/** Page 1 holds a note and a file attachment. Page 2 holds a link, which the
 *  import leaves alone; with `strayPage`, its /P names page 1. */
async function attachmentOnFirstPage(strayPage: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second = doc.addPage([300, 600]);
  const ctx = doc.context;
  const embedded = ctx.register(ctx.stream('ATTACHEDSECRET', { Type: 'EmbeddedFile' }));
  const spec = ctx.obj({ Type: 'Filespec', EF: { F: embedded } });
  spec.set(N('F'), PDFString.of('SECRETNAME.txt'));
  const attachment = ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [50, 50, 70, 70], FS: ctx.register(spec), P: first.ref });
  first.node.set(N('Annots'), ctx.obj([ctx.register(textNote(ctx, 'PAGEONENOTE', { P: first.ref })), ctx.register(attachment)]));
  first.node.set(N('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf 20 300 Td (PAGEONEBODY) Tj ET')));
  const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [98, 498, 202, 522], P: strayPage ? first.ref : second.ref });
  second.node.set(N('Annots'), ctx.obj([ctx.register(link)]));
  return doc.save();
}

const FIRST_PAGE_PARTS = ['PAGEONENOTE', 'ATTACHEDSECRET', 'SECRETNAME', 'PAGEONEBODY'];

describe('a deleted page leaves nothing in the saved file', () => {
  it.each([
    ['whose own objects name it', false],
    ['that an annotation of a kept page names as its /P', true],
  ])('a page %s: its note, its attachment and its content are gone', async (_label, strayPage) => {
    const source = await attachmentOnFirstPage(strayPage);
    expect(await held(source, FIRST_PAGE_PARTS)).toEqual(FIRST_PAGE_PARTS);
    const once = await commit(source, ([, second]) => [second]);
    expect(brief(await shown(once))).toEqual(['Link:']);
    await expectSound(once, FIRST_PAGE_PARTS);
    const twice = await commit(once);
    expect(brief(await shown(twice))).toEqual(['Link:']);
    await expectSound(twice, FIRST_PAGE_PARTS);
  });
});

/** A tagged page: a highlight and a link, each the object of one structure
 *  element's object reference. */
async function taggedAnnotations(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const ctx = doc.context;
  const note = ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], StructParent: 1 });
  note.set(N('Contents'), PDFHexString.fromText('TAGGEDNOTE'));
  const noteRef = ctx.register(note);
  const linkRef = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 50], StructParent: 2 }));
  page.node.set(N('Annots'), ctx.obj([noteRef, linkRef]));
  const rootRef = ctx.register(ctx.obj({ Type: 'StructTreeRoot' }));
  const root = ctx.lookup(rootRef, PDFDict);
  const documentElem = ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef });
  const documentRef = ctx.register(documentElem);
  const element = (role: string, target: PDFRef): PDFRef => {
    const elem = ctx.obj({ Type: 'StructElem', S: role, P: documentRef, Pg: page.ref, K: { Type: 'OBJR', Obj: target, Pg: page.ref } });
    return ctx.register(elem);
  };
  const noteElem = element('Annot', noteRef), linkElem = element('Link', linkRef);
  documentElem.set(N('K'), ctx.obj([noteElem, linkElem]));
  root.set(N('K'), documentRef);
  root.set(N('ParentTree'), ctx.obj({ Nums: [1, noteElem, 2, linkElem] }));
  root.set(N('ParentTreeNextKey'), PDFNumber.of(3));
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  return doc.save();
}

/** Each structure element that holds an object reference: its role, the
 *  subtype of the referenced annotation, whether a page lists that
 *  annotation, and whether the annotation's /StructParent leads back to the
 *  element through the parent tree. */
async function objectReferences(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const listed = new Set(annotsOf(doc).map((a) => a.dict));
  const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
  const nums = root.lookup(N('ParentTree'), PDFDict).lookup(N('Nums'), PDFArray);
  const parents = new Map<number, PDFObject | undefined>();
  for (let i = 0; i + 1 < nums.size(); i += 2) parents.set(nums.lookup(i, PDFNumber).asNumber(), nums.get(i + 1));
  const out: string[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const kid = obj instanceof PDFDict ? obj.lookup(N('K')) : undefined;
    if (!(obj instanceof PDFDict) || !(kid instanceof PDFDict) || kid.get(N('Type')) !== N('OBJR')) continue;
    const target = kid.lookup(N('Obj'), PDFDict);
    const key = target.lookup(N('StructParent'), PDFNumber).asNumber();
    out.push(`${String(obj.get(N('S')))} -> ${subtypeOf(target)} listed=${listed.has(target)} parent=${parents.get(key) === ref}`);
  }
  return out.sort();
}

describe('a structure element that references a replaced or deleted annotation', () => {
  it('references the re-authored annotation, and the link keeps its own element', async () => {
    const source = await taggedAnnotations();
    const expected = ['/Annot -> /Highlight listed=true parent=true', '/Link -> /Link listed=true parent=true'];
    expect(await objectReferences(source)).toEqual(expected);
    const once = await commit(source);
    expect(await objectReferences(once)).toEqual(expected);
    await expectSound(once, []);
    const twice = await commit(once);
    expect(await objectReferences(twice)).toEqual(expected);
    await expectSound(twice, []);
  });

  it('loses the element of a deleted annotation and keeps the link\'s', async () => {
    const source = await taggedAnnotations();
    const once = await commit(source, ([page]) => [deleting(page, () => true)]);
    expect(brief(await shown(once))).toEqual(['Link:']);
    expect(await objectReferences(once)).toEqual(['/Link -> /Link listed=true parent=true']);
    await expectSound(once, ['TAGGEDNOTE']);
    const twice = await commit(once);
    expect(await objectReferences(twice)).toEqual(['/Link -> /Link listed=true parent=true']);
    await expectSound(twice, ['TAGGEDNOTE']);
  });
});

/** A /Text parent and a /Caret reply the import leaves alone. With
 *  `acrossPages` the reply is on a second page. */
async function caretReply(replyType: string, acrossPages = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second: PDFPage = acrossPages ? doc.addPage([300, 600]) : first;
  const ctx = doc.context;
  const parentRef = ctx.register(textNote(ctx, 'Parent note'));
  const caret = ctx.obj({
    Type: 'Annot', Subtype: 'Caret', Rect: [98, 498, 110, 510], C: [0, 0, 1], IRT: parentRef, RT: replyType,
    AP: { N: formStream(ctx, '') },
  });
  caret.set(N('Contents'), PDFHexString.fromText('Reply text'));
  const caretRef = ctx.register(caret);
  first.node.set(N('Annots'), ctx.obj(acrossPages ? [parentRef] : [parentRef, caretRef]));
  if (acrossPages) second.node.set(N('Annots'), ctx.obj([caretRef]));
  return doc.save();
}

/** The reply's link as the saved file holds it. */
async function replyLink(bytes: Uint8Array, replyPage = 0): Promise<{ target: string; text: string; listed: boolean } | null> {
  const doc = await PDFDocument.load(bytes);
  const caret = annotsOf(doc, replyPage).find((a) => subtypeOf(a.dict) === '/Caret')!;
  const raw = caret.dict.get(N('IRT'));
  if (raw === undefined) return null;
  const target = doc.context.lookup(raw, PDFDict);
  const contents = target.lookup(N('Contents'));
  return {
    target: subtypeOf(target),
    text: contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '',
    listed: annotsOf(doc, 0).some((a) => a.ref === raw),
  };
}

const editParent = (text: string) => ([first, ...rest]: PageRef[]): PageRef[] => [
  { ...first, annotations: first.annotations!.map((a) => ({ ...a, note: text })) }, ...rest,
];

describe('a reply the import leaves alone, after its parent is replaced', () => {
  it.each([
    ['on the parent\'s page', false],
    ['on another page', true],
  ])('%s: /IRT names the re-authored parent with its current text, through two commits', async (_label, acrossPages) => {
    const source = await caretReply('Group', acrossPages);
    const replyPage = acrossPages ? 1 : 0;
    const once = await commit(source, editParent('Edited parent'));
    expect(await replyLink(once, replyPage)).toEqual({ target: '/Text', text: 'Edited parent', listed: true });
    const parent = (await shown(once, 1)).find((a) => a.subtype === 'Text')!;
    const reply = (await shown(once, replyPage + 1)).find((a) => a.subtype === 'Caret')!;
    expect({ text: reply.text, linked: reply.inReplyTo === parent.id }).toEqual({ text: 'Edited parent', linked: true });
    await expectSound(once, ['Parent note']);
    const twice = await commit(once);
    expect(await replyLink(twice, replyPage)).toEqual({ target: '/Text', text: 'Edited parent', listed: true });
    await expectSound(twice, ['Parent note']);
  });

  it('a plain reply keeps its own text and names the re-authored parent', async () => {
    const source = await caretReply('R');
    const once = await commit(source, editParent('Edited parent'));
    expect(await replyLink(once)).toEqual({ target: '/Text', text: 'Edited parent', listed: true });
    expect(brief(await shown(once))).toEqual(['Caret:Reply text', 'Text:Edited parent']);
    await expectSound(once, ['Parent note']);
  });
});

describe('a reply the import leaves alone, after the user deletes its parent', () => {
  const deleteParent = ([first, ...rest]: PageRef[]): PageRef[] => [deleting(first, () => true), ...rest];

  it('a plain reply stands alone with its own text, and the parent text is gone', async () => {
    const source = await caretReply('R');
    const once = await commit(source, deleteParent);
    expect(await replyLink(once)).toBeNull();
    expect((await shown(once)).map(({ subtype, text, inReplyTo }) => ({ subtype, text, inReplyTo })))
      .toEqual([{ subtype: 'Caret', text: 'Reply text', inReplyTo: null }]);
    await expectSound(once, ['Parent note']);
    const saved = await PDFDocument.load(once);
    expect(annotsOf(saved)[0].dict.has(N('RT'))).toBe(false);
    await expectSound(await commit(once), ['Parent note']);
  });

  it('a group member stands alone and keeps the text the group showed', async () => {
    const source = await caretReply('Group');
    expect(brief(await shown(source))).toEqual(['Caret:Parent note', 'Text:Parent note']);
    const once = await commit(source, deleteParent);
    expect(await replyLink(once)).toBeNull();
    expect((await shown(once)).map(({ subtype, text, inReplyTo }) => ({ subtype, text, inReplyTo })))
      .toEqual([{ subtype: 'Caret', text: 'Parent note', inReplyTo: null }]);
    await expectSound(once, ['Reply text']);
    const doc = await PDFDocument.load(once);
    expect([...doc.context.enumerateIndirectObjects()].filter(([, obj]) => obj instanceof PDFDict && obj.get(N('Subtype')) === N('Text'))).toEqual([]);
  });
});

/** `bytes` with each placeholder key replaced by a spelling of equal length. */
function withKeys(bytes: Uint8Array, keys: [string, string][]): Uint8Array {
  let text = Buffer.from(bytes).toString('latin1');
  for (const [placeholder, escaped] of keys) {
    expect(placeholder.length).toBe(escaped.length);
    expect(text).toContain(placeholder);
    text = text.split(placeholder).join(escaped);
  }
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

/** Page 1 holds a /Text parent. Page 2 holds its Highlight group reply. The
 *  dictionary `ambiguous` selects writes /Contents and /C#6fntents, two keys
 *  that read as one name. */
async function ambiguousReplyAcrossPages(ambiguous: 'parent' | 'reply'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 600]);
  const second = doc.addPage([300, 600]);
  const ctx = doc.context;
  const twice = (dict: PDFDict, one: string, two: string) => {
    dict.set(N('QQQQQQQQ'), PDFString.of(one));
    dict.set(N('CZZZntents'), PDFString.of(two));
  };
  const parent = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  if (ambiguous === 'parent') twice(parent, 'PARENTONE', 'PARENTTWO');
  else parent.set(N('Contents'), PDFString.of('PARENTONE'));
  const parentRef = ctx.register(parent);
  const reply = ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [98, 498, 202, 522], QuadPoints: QUAD, C: [1, 1, 0], IRT: parentRef, RT: 'Group' });
  if (ambiguous === 'reply') twice(reply, 'REPLYONE', 'REPLYTWO');
  first.node.set(N('Annots'), ctx.obj([parentRef]));
  second.node.set(N('Annots'), ctx.obj([ctx.register(reply)]));
  return withKeys(await doc.save({ useObjectStreams: false }), [['/QQQQQQQQ', '/Contents'], ['/CZZZntents', '/C#6fntents']]);
}

describe('a group reply the parse cannot read faithfully, whose parent is on a removed page', () => {
  it.each([
    ['the parent holds the ambiguous keys', 'parent' as const, ['PARENTONE', 'PARENTTWO']],
    ['the reply holds the ambiguous keys', 'reply' as const, ['PARENTONE']],
  ])('%s: the commit succeeds with one reply, no link and nothing of the parent', async (_label, ambiguous, parentTexts) => {
    const source = await ambiguousReplyAcrossPages(ambiguous);
    expect(await held(source, parentTexts)).toEqual(parentTexts);
    // The reply is kept as written, so the two spellings of its key stay.
    const inherited = /duplicated key \/Contents/;
    expect(qpdfReading(source).problems.some((problem) => inherited.test(problem))).toBe(true);
    let bytes = source;
    for (let round = 0; round < 2; round++) {
      bytes = await commit(bytes, (pages) => pages.slice(-1));
      expect(brief(await shown(bytes)).map((entry) => entry.split(':')[0])).toEqual(['Highlight']);
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const linked = [...doc.context.enumerateIndirectObjects()]
        .filter(([, obj]) => obj instanceof PDFDict && (obj.has(N('IRT')) || obj.has(N('RT'))));
      expect(linked).toEqual([]);
      await expectSound(bytes, parentTexts, ambiguous === 'reply' ? inherited : undefined);
    }
  });
});
