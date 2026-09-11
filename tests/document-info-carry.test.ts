// The document Info carry (lib/pdfx-build.ts carryDocumentInfo): the OWN
// document's whole information dictionary survives the from-scratch commit
// rebuild. Before it, only the dates travelled — a same-order rebuild
// published a document whose title, author and private entries were gone
// (BA-36) — and those dates went through pdf-lib's decode/re-encode, which
// flattens a partial date to a full timestamp and rewrites any timezone
// offset as UTC. ISO 32000-2 14.3.3 makes /Info optional, requires every
// entry outside /CreationDate and /ModDate to be a text string, and Table 349
// adds /Trapped as the sole name-valued entry with three conforming names.
import { describe, expect, it } from 'vitest';
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const N = PDFName.of.bind(PDFName);

const pageOf = (bytes: Uint8Array, index: number, sourceKey = 'own'): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex: index,
});

/** A source whose Info entries are written one at a time, so each value's
 * exact object kind is the fixture's choice — pdf-lib's own setters hex-encode
 * every string and re-serialize every date. `build` runs against the live Info
 * dict for the shapes that need a reference or the page tree. */
async function source(
  entries: Record<string, PDFObject> = {},
  build?: (doc: PDFDocument, info: PDFDict) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const width of [300, 400]) doc.addPage([width, 600]);
  if (Object.keys(entries).length > 0 || build) {
    const info = doc.context.obj({});
    doc.context.trailerInfo.Info = doc.context.register(info);
    for (const [key, value] of Object.entries(entries)) info.set(N(key), value);
    build?.(doc, info);
  }
  return doc.save();
}

/** Every ordinary Table 349 text entry, deliberately mixing the two string
 * kinds so the carry cannot be passing through one decode path. */
const ORDINARY: Record<string, PDFObject> = {
  Title: PDFString.of('Original document title'),
  Author: PDFHexString.fromText('Document author'),
  Subject: PDFString.of('The document subject'),
  Keywords: PDFHexString.fromText('alpha beta'),
  Creator: PDFString.of('The originating tool'),
};

const reload = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

const infoOf = (doc: PDFDocument): PDFDict | undefined => {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof PDFDict ? info : undefined;
};
const entry = (doc: PDFDocument, key: string): PDFObject | undefined => infoOf(doc)?.lookup(N(key));
/** The value exactly as the file spells it — the assertion the old
 * decode/re-encode carry could not pass. */
const spelling = (doc: PDFDocument, key: string): string | undefined => {
  const value = entry(doc, key);
  return value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName
    ? value.asString()
    : undefined;
};

const rebuild = async (bytes: Uint8Array, order = [0, 1], own: Uint8Array | undefined = bytes) =>
  reload(await buildPdf(order.map(index => pageOf(bytes, index)), own, 'own'));

describe('document Info carry — ordinary and private entries', () => {
  it('carries every ordinary entry through a same-order rebuild without touching the input', async () => {
    const src = await source({ ...ORDINARY }), before = src.slice();
    const out = await rebuild(src);
    expect({
      title: out.getTitle(),
      author: out.getAuthor(),
      subject: out.getSubject(),
      keywords: out.getKeywords(),
      creator: out.getCreator(),
    }).toEqual({
      title: 'Original document title',
      author: 'Document author',
      subject: 'The document subject',
      keywords: 'alpha beta',
      creator: 'The originating tool',
    });
    expect(src).toEqual(before);
  });

  it('carries an unknown private entry, whose meaning it cannot inspect', async () => {
    const out = await rebuild(await source({
      PrivateField: PDFHexString.fromText('Preserve this document value'),
      'Company:Matter-ID': PDFString.of('2026-0417'),
    }));
    expect((entry(out, 'PrivateField') as PDFHexString).decodeText()).toBe('Preserve this document value');
    expect((entry(out, 'Company:Matter-ID') as PDFString).decodeText()).toBe('2026-0417');
  });

  it('spells every carried value exactly as the source spelled it, kind included', async () => {
    const src = await source({ ...ORDINARY, Private: PDFString.of('kept') });
    const before = await reload(src), out = await rebuild(src);
    for (const key of [...Object.keys(ORDINARY), 'Private']) {
      expect(spelling(out, key)).toBe(spelling(before, key));
      expect(entry(out, key)!.constructor).toBe(entry(before, key)!.constructor);
    }
  });

  it('resolves an indirect value to its leaf instead of losing it', async () => {
    const out = await rebuild(await source({}, (doc, info) => {
      info.set(N('Title'), doc.context.register(PDFString.of('Indirect title')));
      info.set(N('Author'), doc.context.register(PDFHexString.fromText('Indirect author')));
    }));
    expect({ title: out.getTitle(), author: out.getAuthor() })
      .toEqual({ title: 'Indirect title', author: 'Indirect author' });
    expect(entry(out, 'Title')).toBeInstanceOf(PDFString);
  });
});

describe('document Info carry — dates', () => {
  // pdf-lib's setCreationDate writes `D:YYYYMMDDHHmmSSZ` from a parsed JS
  // Date, so both of these lost information on the way through the old carry:
  // the offset became `Z` at a shifted clock time, and the year-only date
  // grew a fabricated month, day and time.
  it('preserves a timezone offset and a partial date byte for byte', async () => {
    const out = await rebuild(await source({
      CreationDate: PDFString.of("D:20200115103000+05'30'"),
      ModDate: PDFString.of('D:2019'),
    }));
    expect(spelling(out, 'CreationDate')).toBe("D:20200115103000+05'30'");
    expect(spelling(out, 'ModDate')).toBe('D:2019');
  });

  it('never stamps the run clock: two builds of one source spell the same dates', async () => {
    const src = await source({ CreationDate: PDFString.of('D:20180301120000-08\'00\'') });
    const [first, second] = [await rebuild(src), await rebuild(src)];
    expect(spelling(first, 'CreationDate')).toBe(spelling(second, 'CreationDate'));
    expect(spelling(first, 'ModDate')).toBeUndefined();
  });

  it('keeps a hex-encoded date hex-encoded', async () => {
    const out = await rebuild(await source({ CreationDate: PDFHexString.fromText('D:20210704080000Z') }));
    expect(entry(out, 'CreationDate')).toBeInstanceOf(PDFHexString);
    expect((entry(out, 'CreationDate') as PDFHexString).decodeText()).toBe('D:20210704080000Z');
  });
});

describe('document Info carry — absence and generated entries', () => {
  it('treats a nonexistent trailer Info reference as absent', async () => {
    const bytes = await source({}, doc => { doc.context.trailerInfo.Info = PDFRef.of(9999); });
    const out = await rebuild(bytes);
    expect(infoOf(out)!.keys().map(key => key.asString())).toEqual(['/Producer']);
  });
  it('invents nothing when the source has no Info dictionary', async () => {
    const out = await rebuild(await source());
    expect(infoOf(out)!.keys().map(key => key.asString())).toEqual(['/Producer']);
  });

  it('leaves an absent entry absent rather than defaulting it', async () => {
    const out = await rebuild(await source({ Title: PDFString.of('Only a title') }));
    for (const key of ['Author', 'Subject', 'Keywords', 'Creator', 'CreationDate', 'ModDate', 'Trapped']) {
      expect(entry(out, key)).toBeUndefined();
    }
  });

  it('generates its own Producer over the source value', async () => {
    const out = await rebuild(await source({ Producer: PDFString.of('Some other writer 3.0') }));
    expect(out.getProducer()).toMatch(/^PDFX /);
  });
});

describe('document Info carry — Trapped', () => {
  it.each(['True', 'False', 'Unknown'])('carries the conforming name /%s', async name => {
    const out = await rebuild(await source({ Trapped: N(name) }));
    expect(spelling(out, 'Trapped')).toBe(`/${name}`);
  });

  it.each([
    ['a boolean spelling the same word', PDFBool.True],
    ['an unlisted name', N('Partly')],
    ['a text string', PDFString.of('True')],
  ])('refuses %s', async (_label, value) => {
    const src = await source({ Trapped: value as PDFObject }), before = src.slice();
    await expect(rebuild(src)).rejects.toThrow();
    expect(src).toEqual(before);
  });
});

describe('document Info carry — ownership', () => {
  it('does not import a donor document metadata', async () => {
    const own = await source({ Title: PDFString.of('Own title') });
    const donor = await source({ ...ORDINARY, Subject: PDFString.of('Donor subject') });
    const out = await reload(await buildPdf([pageOf(own, 0), pageOf(donor, 0, 'donor')], own, 'own'));
    expect({ title: out.getTitle(), subject: out.getSubject() })
      .toEqual({ title: 'Own title', subject: undefined });
  });

  it('carries the own metadata when every retained page is a donor page', async () => {
    const own = await source({ ...ORDINARY, CreationDate: PDFString.of('D:20170101000000Z') });
    const donor = await source({ Title: PDFString.of('Donor title') });
    const out = await reload(await buildPdf([pageOf(donor, 0, 'donor')], own, 'own'));
    expect({ title: out.getTitle(), author: out.getAuthor(), created: spelling(out, 'CreationDate') })
      .toEqual({ title: 'Original document title', author: 'Document author', created: 'D:20170101000000Z' });
    expect(out.getPageCount()).toBe(1);
  });

  it('carries nothing when the rebuild has no own document', async () => {
    const donor = await source({ ...ORDINARY });
    const out = await reload(await buildPdf([pageOf(donor, 0, 'donor')]));
    expect(out.getTitle()).toBeUndefined();
  });
});

describe('document Info carry — collection overrides', () => {
  it('names the collection in Title and Keywords while carrying the rest', async () => {
    const own = await source({ ...ORDINARY, CreationDate: PDFString.of("D:20160229235959-03'00'") });
    const out = await reload(await buildPdfx(
      [{ name: 'Member', pages: [pageOf(own, 0)] }], 'Collection name', own, 'own',
    ));
    expect({
      title: out.getTitle(),
      keywords: out.getKeywords(),
      author: out.getAuthor(),
      subject: out.getSubject(),
      creator: out.getCreator(),
      created: spelling(out, 'CreationDate'),
    }).toEqual({
      title: 'Collection name',
      keywords: 'PDFX',
      author: 'Document author',
      subject: 'The document subject',
      creator: 'The originating tool',
      created: "D:20160229235959-03'00'",
    });
    expect(out.getProducer()).toMatch(/^PDFX /);
  });

  it('refuses a malformed Info on the collection path too', async () => {
    const own = await source({ Title: PDFNumber.of(7) }), before = own.slice();
    await expect(buildPdfx([{ name: 'Member', pages: [pageOf(own, 0)] }], 'Collection', own, 'own'))
      .rejects.toThrow();
    expect(own).toEqual(before);
  });
});

describe('document Info carry — refusals', () => {
  it('refuses a trailer Info that is not a dictionary', async () => {
    const src = await source({}, (doc) => {
      doc.context.trailerInfo.Info = doc.context.register(doc.context.obj([PDFNumber.of(1)]));
    });
    const before = src.slice();
    await expect(rebuild(src)).rejects.toThrow();
    expect(src).toEqual(before);
  });

  it.each([
    ['a number', PDFNumber.of(42)],
    ['a boolean', PDFBool.True],
    ['a name where a text string is required', N('Title')],
  ])('refuses an ordinary entry that is %s', async (_label, value) => {
    const src = await source({ Title: value as PDFObject }), before = src.slice();
    await expect(rebuild(src)).rejects.toThrow();
    expect(src).toEqual(before);
  });

  it.each(['CreationDate', 'ModDate'])('refuses a %s that is not a string', async key => {
    const src = await source({ [key]: PDFNumber.of(20200101) }), before = src.slice();
    await expect(rebuild(src)).rejects.toThrow();
    expect(src).toEqual(before);
  });

  // Each of these is an object graph. The carry refuses on the value's kind,
  // so it never follows one — no page tree is cloned and no cycle is walked.
  it.each(['dict', 'array', 'cycle', 'page-tree'])('refuses a %s value', async shape => {
    const src = await source({}, (doc, info) => {
      if (shape === 'dict') info.set(N('Private'), doc.context.obj({ Nested: PDFString.of('x') }));
      else if (shape === 'array') info.set(N('Private'), doc.context.obj([PDFString.of('x')]));
      else if (shape === 'cycle') {
        const dict = doc.context.obj({}), ref = doc.context.register(dict);
        dict.set(N('Self'), ref);
        info.set(N('Private'), ref);
      } else info.set(N('Private'), doc.catalog.get(N('Pages'))!);
    });
    const before = src.slice();
    await expect(rebuild(src)).rejects.toThrow();
    expect(src).toEqual(before);
  });

  // ISO 32000-2 7.3.9: a null value, and a reference to a nonexistent object,
  // are both equivalent to omitting the entry. Neither is a malformed value,
  // so neither may refuse the rebuild — the entry is simply not there.
  it.each(['null', 'nonexistent-reference'])('treats a %s value as an absent entry', async shape => {
    const out = await rebuild(await source({ Title: PDFString.of('Kept') }, (_doc, info) => {
      info.set(N('Author'), shape === 'null' ? PDFNull : PDFRef.of(9999));
    }));
    expect(out.getTitle()).toBe('Kept');
    expect(entry(out, 'Author')).toBeUndefined();
  });

  it('carries the same private key when its value is a text string', async () => {
    // The control for the five refusals above: the key is not the objection,
    // the value's kind is.
    const out = await rebuild(await source({ Private: PDFString.of('x') }));
    expect((entry(out, 'Private') as PDFString).decodeText()).toBe('x');
  });

  it('refuses the whole rebuild for a late malformed entry, not just that entry', async () => {
    // Title validates and is reached first; the malformed entry after it must
    // still refuse, rather than publishing an output carrying a partial
    // identity. Dropping the same entry from the fixture builds normally, so
    // the refusal is the malformed value and nothing else about the document.
    const src = await source({ Title: PDFString.of('Valid title'), Zeta: PDFNumber.of(1) });
    await expect(rebuild(src)).rejects.toThrow();
    const out = await rebuild(await source({ Title: PDFString.of('Valid title') }));
    expect(out.getTitle()).toBe('Valid title');
  });

  it('refuses a reordering rebuild the same way it refuses a same-order one', async () => {
    const src = await source({}, (doc, info) => info.set(N('Title'), doc.context.obj([])));
    await expect(rebuild(src, [1, 0])).rejects.toThrow();
    await expect(rebuild(src, [0, 1])).rejects.toThrow();
  });
});
