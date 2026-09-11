// copyOutputIntents (lib/output-intents-carry.ts): a document's output
// intents and their ICC profile bytes survive a from-scratch rebuild. The
// rebuild copies page subtrees only, so the catalog's /OutputIntents — and the
// profile defining the production condition the colours were prepared for —
// were gone from the output entirely (BA-38).
//
// Field shapes follow ISO 32000-2 14.11.5, Tables 401 and 402. Fixtures are
// synthetic: an ICC profile is bytes to this copier, so no provisioned
// resource is needed to prove the bytes travel.
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

import { copyOutputIntents } from '../src/renderer/lib/output-intents-carry';

const N = PDFName.of.bind(PDFName);
type Fields = NonNullable<Parameters<PDFDocument['context']['stream']>[1]>;

/** Bytes shaped like an ICC profile header — a size, a CMYK data colour
 * space and the `acsp` signature at their defined offsets — followed by a
 * payload with every byte value in it. Nothing reads these; they exist to be
 * compared after the copy. */
function iccBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 0xff;
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode('CMYK'), 16);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  return bytes;
}

interface Built {
  doc: PDFDocument;
  raw: PDFObject | undefined;
}

/** A source document with two pages and whatever `build` puts in the
 * catalog's /OutputIntents. */
async function source(build?: (doc: PDFDocument) => PDFObject | undefined): Promise<Built> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const width of [300, 400]) doc.addPage([width, 700]);
  const raw = build?.(doc);
  if (raw !== undefined) doc.catalog.set(N('OutputIntents'), raw);
  return { doc, raw };
}

/** The canonical intent: subtype, condition identifier, info and an embedded
 * profile stream, registered so the array holds a reference to it. */
function intentWithProfile(doc: PDFDocument, icc: Uint8Array, extra: Fields = {}): PDFRef {
  const profile = doc.context.register(doc.context.flateStream(icc, { N: 4 }));
  return doc.context.register(
    doc.context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFX',
      OutputCondition: PDFString.of('U.S. Web Coated (SWOP)'),
      OutputConditionIdentifier: PDFString.of('CGATS TR 001'),
      RegistryName: PDFString.of('http://www.color.org'),
      Info: PDFString.of('Preserved output color condition'),
      DestOutputProfile: profile,
      ...extra,
    }),
  );
}

const empty = async () => PDFDocument.create({ updateMetadata: false });

/** Run the copier and reload nothing — the result is inspected in the output
 * context, which is where the caller receives it. */
async function carry(built: Built): Promise<{ output: PDFDocument; copied: PDFArray | undefined }> {
  const output = await empty();
  return { output, copied: copyOutputIntents(output, built.doc, built.raw) };
}

const intentAt = (copied: PDFArray, index: number): PDFDict => copied.lookup(index, PDFDict);
const streamOf = (intent: PDFDict, key = 'DestOutputProfile'): PDFRawStream => {
  const stream = intent.lookup(N(key));
  expect(stream).toBeInstanceOf(PDFRawStream);
  return stream as PDFRawStream;
};

describe('copyOutputIntents — faithful control', () => {
  it('carries the complete intent and the profile bytes unchanged', async () => {
    const icc = iccBytes();
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, icc)]));
    const { copied } = await carry(built);
    expect(copied).toBeInstanceOf(PDFArray);
    const intent = intentAt(copied!, 0);
    expect(intent.lookup(N('Type'))).toBe(N('OutputIntent'));
    expect(intent.lookup(N('S'))).toBe(N('GTS_PDFX'));
    expect(intent.lookup(N('OutputCondition'), PDFString).decodeText()).toBe('U.S. Web Coated (SWOP)');
    expect(intent.lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe('CGATS TR 001');
    expect(intent.lookup(N('RegistryName'), PDFString).decodeText()).toBe('http://www.color.org');
    expect(intent.lookup(N('Info'), PDFString).decodeText()).toBe('Preserved output color condition');
    expect(decodePDFRawStream(streamOf(intent)).decode()).toEqual(icc);
  });

  it('carries the compressed bytes verbatim, without a decode and re-encode', async () => {
    const icc = iccBytes(4096);
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, icc)]));
    const sourceStream = built.doc.context.lookup(
      built.doc.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict).get(N('DestOutputProfile')),
    ) as PDFRawStream;
    const { copied } = await carry(built);
    const carried = streamOf(intentAt(copied!, 0));
    expect(carried.contents).toEqual(sourceStream.contents);
    expect(carried.dict.lookup(N('Filter'))).toBe(N('FlateDecode'));
    expect(carried.dict.lookup(N('N'), PDFNumber).asNumber()).toBe(4);
  });

  it('copies into the output context, not by reference to the source', async () => {
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, iccBytes())]));
    const { output, copied } = await carry(built);
    expect(copied!.lookup(0)).toBe(output.context.lookup(copied!.get(0)));
    expect(intentAt(copied!, 0).context).toBe(output.context);
    expect(streamOf(intentAt(copied!, 0)).dict.context).toBe(output.context);
  });

  it('survives a save and reload of the output once the caller publishes it', async () => {
    const icc = iccBytes();
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, icc)]));
    const { output, copied } = await carry(built);
    output.addPage([300, 700]);
    output.catalog.set(N('OutputIntents'), output.context.register(copied!));
    const reloaded = await PDFDocument.load(await output.save(), { updateMetadata: false });
    const intent = reloaded.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict);
    expect(decodePDFRawStream(streamOf(intent)).decode()).toEqual(icc);
  });
});

describe('copyOutputIntents — never publishes a root', () => {
  it('leaves the destination catalog untouched on success', async () => {
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, iccBytes())]));
    const { output, copied } = await carry(built);
    expect(copied).toBeInstanceOf(PDFArray);
    expect(output.catalog.get(N('OutputIntents'))).toBeUndefined();
  });

  it('leaves the destination catalog untouched on refusal', async () => {
    const built = await source((doc) => doc.context.obj([doc.context.obj({ S: 'GTS_PDFX' })]));
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
    expect(output.catalog.get(N('OutputIntents'))).toBeUndefined();
  });

  it('leaves no page-level root either, on success or refusal', async () => {
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, iccBytes())]));
    const { output } = await carry(built);
    const page = output.addPage([300, 700]);
    expect(page.node.get(N('OutputIntents'))).toBeUndefined();
  });

  it('does not modify the source document', async () => {
    const icc = iccBytes();
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, icc)]));
    const before = await built.doc.save();
    await carry(built);
    expect(await built.doc.save()).toEqual(before);
  });
});

describe('copyOutputIntents — absence', () => {
  it.each([
    ['an undefined value', undefined],
    ['an explicit null', PDFNull as PDFObject],
  ])('returns undefined for %s', async (_label, raw) => {
    const built = await source();
    const output = await empty();
    expect(copyOutputIntents(output, built.doc, raw)).toBeUndefined();
  });

  it('returns undefined for a reference to a nonexistent object', async () => {
    const built = await source();
    const output = await empty();
    expect(copyOutputIntents(output, built.doc, PDFRef.of(9999))).toBeUndefined();
  });

  it('carries an empty array as an empty array', async () => {
    const built = await source((doc) => doc.context.obj([]));
    const { copied } = await carry(built);
    expect(copied).toBeInstanceOf(PDFArray);
    expect(copied!.size()).toBe(0);
  });

  it('carries an intent that has only its required fields', async () => {
    const built = await source((doc) =>
      doc.context.obj([doc.context.obj({ S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB') })]),
    );
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    expect(intent.lookup(N('S'))).toBe(N('GTS_PDFA1'));
    for (const key of ['Type', 'Info', 'DestOutputProfile', 'OutputCondition', 'RegistryName']) {
      expect(intent.get(N(key))).toBeUndefined();
    }
  });
});

describe('copyOutputIntents — order, sharing and indirection', () => {
  it('preserves the order of several intents', async () => {
    const built = await source((doc) =>
      doc.context.obj(
        ['GTS_PDFX', 'GTS_PDFA1', 'ISO_PDFE1'].map((subtype, i) =>
          doc.context.register(
            doc.context.obj({
              S: subtype,
              OutputConditionIdentifier: PDFString.of(`condition ${i}`),
            }),
          ),
        ),
      ),
    );
    const { copied } = await carry(built);
    expect(copied!.size()).toBe(3);
    expect([0, 1, 2].map((i) => intentAt(copied!, i).lookup(N('S')))).toEqual([
      N('GTS_PDFX'), N('GTS_PDFA1'), N('ISO_PDFE1'),
    ]);
    expect([0, 1, 2].map((i) => intentAt(copied!, i).lookup(N('OutputConditionIdentifier'), PDFString).decodeText()))
      .toEqual(['condition 0', 'condition 1', 'condition 2']);
  });

  it('keeps a profile shared by two intents one object in the output', async () => {
    const icc = iccBytes();
    const built = await source((doc) => {
      const profile = doc.context.register(doc.context.flateStream(icc, { N: 4 }));
      const of = (subtype: string) =>
        doc.context.register(
          doc.context.obj({ S: subtype, OutputConditionIdentifier: PDFString.of(subtype), DestOutputProfile: profile }),
        );
      return doc.context.obj([of('GTS_PDFX'), of('GTS_PDFA1')]);
    });
    const { output, copied } = await carry(built);
    const first = intentAt(copied!, 0).get(N('DestOutputProfile'));
    const second = intentAt(copied!, 1).get(N('DestOutputProfile'));
    expect(first).toBeInstanceOf(PDFRef);
    expect(first).toBe(second);
    const streams = output.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFRawStream);
    expect(streams).toHaveLength(1);
    expect(decodePDFRawStream(streams[0][1] as PDFRawStream).decode()).toEqual(icc);
  });

  it('resolves an indirect array, indirect intent and indirect field values', async () => {
    const built = await source((doc) => {
      const intent = doc.context.obj({
        S: doc.context.register(N('GTS_PDFX')),
        OutputConditionIdentifier: doc.context.register(PDFString.of('indirect condition')),
        Info: doc.context.register(PDFHexString.fromText('indirect info')),
      });
      return doc.context.register(doc.context.obj([doc.context.register(intent)]));
    });
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    expect(intent.lookup(N('S'))).toBe(N('GTS_PDFX'));
    expect(intent.lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe('indirect condition');
    expect(intent.lookup(N('Info'), PDFHexString).decodeText()).toBe('indirect info');
    // The indirection itself survives where the source used it.
    expect(intent.get(N('S'))).toBeInstanceOf(PDFRef);
  });

  it('terminates on a cycle in extension data and keeps it a cycle', async () => {
    const built = await source((doc) => {
      const node = doc.context.obj({ Label: PDFString.of('self') });
      const ref = doc.context.register(node);
      node.set(N('Self'), ref);
      return doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), Vendor: ref }),
      ]);
    });
    const { copied } = await carry(built);
    const vendor = intentAt(copied!, 0).lookup(N('Vendor'), PDFDict);
    expect(vendor.get(N('Self'))).toBe(intentAt(copied!, 0).get(N('Vendor')));
    expect(vendor.lookup(N('Label'), PDFString).decodeText()).toBe('self');
  });

  it('keeps a diamond shared between two extension fields one object', async () => {
    const built = await source((doc) => {
      const shared = doc.context.register(doc.context.obj({ Shared: PDFString.of('once') }));
      return doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          Left: shared,
          Right: shared,
        }),
      ]);
    });
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    expect(intent.get(N('Left'))).toBe(intent.get(N('Right')));
  });
});

describe('copyOutputIntents — extension and unknown data', () => {
  it('does not restrict the subtype name', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'XX_VendorIntent2030', OutputConditionIdentifier: PDFString.of('vendor condition') }),
      ]),
    );
    const { copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('S'))).toBe(N('XX_VendorIntent2030'));
  });

  it('carries unknown pure-data fields of every scalar kind', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          VendorName: PDFName.of('Anything'),
          VendorFlag: true,
          VendorCount: 42,
          VendorReal: 1.5,
          VendorNull: PDFNull,
          VendorList: [PDFNumber.of(1), PDFString.of('two'), PDFName.of('Three')],
          VendorNested: { Deep: { Deeper: PDFString.of('kept') } },
        }),
      ]),
    );
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    expect(intent.lookup(N('VendorName'))).toBe(N('Anything'));
    expect(intent.lookup(N('VendorFlag'), PDFBool).asBoolean()).toBe(true);
    expect(intent.lookup(N('VendorCount'), PDFNumber).asNumber()).toBe(42);
    expect(intent.lookup(N('VendorReal'), PDFNumber).asNumber()).toBe(1.5);
    // PDFDict.get hides a null value unless asked to preserve it, so the
    // entry is read the way it was written.
    expect(intent.get(N('VendorNull'), true)).toBe(PDFNull);
    expect(intent.lookup(N('VendorList'), PDFArray).size()).toBe(3);
    expect(
      intent.lookup(N('VendorNested'), PDFDict).lookup(N('Deep'), PDFDict).lookup(N('Deeper'), PDFString).decodeText(),
    ).toBe('kept');
  });

  it('carries raw string bytes, literal and hex, including non-ASCII', async () => {
    const hex = PDFHexString.fromText('Épreuve — 校正 🎨');
    const literal = PDFString.of('a \\( b ) c');
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: hex,
          Info: literal,
          VendorHex: PDFHexString.of('00FF10'),
        }),
      ]),
    );
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    const carriedId = intent.lookup(N('OutputConditionIdentifier'));
    expect(carriedId).toBeInstanceOf(PDFHexString);
    expect((carriedId as PDFHexString).asString()).toBe(hex.asString());
    expect((carriedId as PDFHexString).decodeText()).toBe('Épreuve — 校正 🎨');
    const carriedInfo = intent.lookup(N('Info'));
    expect(carriedInfo).toBeInstanceOf(PDFString);
    expect((carriedInfo as PDFString).asString()).toBe(literal.asString());
    expect(intent.lookup(N('VendorHex'), PDFHexString).asString()).toBe('00FF10');
  });

  it('carries a referenced-profile description, its colourants and its file specifications', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('Custom'),
          DestOutputProfileRef: {
            CheckSum: PDFHexString.of('000102030405060708090A0B0C0D0E0F'),
            ColorantTable: [N('Cyan'), N('Magenta'), N('Yellow'), N('Black')],
            ICCVersion: PDFHexString.of('04300000'),
            ProfileCS: PDFString.of('CMYK'),
            ProfileName: PDFString.of('U.S. Web Coated (SWOP) v2'),
            URLs: [
              { Type: 'Filespec', FS: 'URL', F: PDFString.of('https://example.invalid/profile.icc') },
              PDFString.of('local.icc'),
            ],
          },
        }),
      ]),
    );
    const { copied } = await carry(built);
    const ref = intentAt(copied!, 0).lookup(N('DestOutputProfileRef'), PDFDict);
    expect(ref.lookup(N('ProfileName'), PDFString).decodeText()).toBe('U.S. Web Coated (SWOP) v2');
    expect(ref.lookup(N('ColorantTable'), PDFArray).asArray()).toEqual([
      N('Cyan'), N('Magenta'), N('Yellow'), N('Black'),
    ]);
    expect(ref.lookup(N('CheckSum'), PDFHexString).asString()).toBe('000102030405060708090A0B0C0D0E0F');
    const urls = ref.lookup(N('URLs'), PDFArray);
    expect(urls.lookup(0, PDFDict).lookup(N('F'), PDFString).decodeText()).toBe(
      'https://example.invalid/profile.icc',
    );
    expect(urls.lookup(1, PDFString).decodeText()).toBe('local.icc');
  });

  it('carries mixing hints and spectral characterisation streams as data', async () => {
    const spectral = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x3f, 0x3e, 0x00, 0xff]);
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('Custom'),
          MixingHints: { Solidities: { Spot1: 0.8 }, PrintingOrder: [N('Spot1'), N('Cyan')] },
          SpectralData: { Spot1: doc.context.register(doc.context.flateStream(spectral)) },
        }),
      ]),
    );
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    const hints = intent.lookup(N('MixingHints'), PDFDict);
    expect(hints.lookup(N('Solidities'), PDFDict).lookup(N('Spot1'), PDFNumber).asNumber()).toBeCloseTo(0.8);
    expect(hints.lookup(N('PrintingOrder'), PDFArray).asArray()).toEqual([N('Spot1'), N('Cyan')]);
    // The characterisation stream is bytes: nothing parsed it as XML.
    const carried = streamOf(intent.lookup(N('SpectralData'), PDFDict), 'Spot1');
    expect(decodePDFRawStream(carried).decode()).toEqual(spectral);
  });
});

describe('copyOutputIntents — malformed values refuse', () => {
  const refusing = async (build: (doc: PDFDocument) => PDFObject | undefined) => {
    const built = await source(build);
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
    expect(output.catalog.get(N('OutputIntents'))).toBeUndefined();
  };

  it.each([
    ['a dictionary', (doc: PDFDocument) => doc.context.obj({ S: 'GTS_PDFX' })],
    ['a string', () => PDFString.of('GTS_PDFX') as PDFObject],
    ['a name', () => N('GTS_PDFX') as PDFObject],
    ['a number', () => PDFNumber.of(1) as PDFObject],
  ])('refuses a root that is %s rather than an array', async (_label, build) => {
    await refusing(build as (doc: PDFDocument) => PDFObject);
  });

  it.each([
    ['a string', () => PDFString.of('not an intent')],
    ['an array', (doc: PDFDocument) => doc.context.obj([PDFNumber.of(1)])],
    ['a name', () => N('GTS_PDFX')],
  ])('refuses an array element that is %s rather than a dictionary', async (_label, make) => {
    await refusing((doc) => doc.context.obj([make(doc) as PDFObject]));
  });

  it('refuses an element that is a reference to a nonexistent object', async () => {
    await refusing((doc) => doc.context.obj([PDFRef.of(9999)]));
  });

  it.each([
    ['no S at all', { OutputConditionIdentifier: PDFString.of('c') }],
    ['S as a string', { S: PDFString.of('GTS_PDFX'), OutputConditionIdentifier: PDFString.of('c') }],
    ['S as a number', { S: PDFNumber.of(1), OutputConditionIdentifier: PDFString.of('c') }],
    ['no OutputConditionIdentifier', { S: 'GTS_PDFX' }],
    ['OutputConditionIdentifier as a name', { S: 'GTS_PDFX', OutputConditionIdentifier: N('c') }],
    ['OutputConditionIdentifier as a number', { S: 'GTS_PDFX', OutputConditionIdentifier: PDFNumber.of(1) }],
    ['a Type that is not OutputIntent', { Type: 'Catalog', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c') }],
    ['a Type that is not a name', { Type: PDFNumber.of(1), S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c') }],
  ])('refuses an intent with %s', async (_label, fields) => {
    await refusing((doc) => doc.context.obj([doc.context.obj(fields as Fields)]));
  });

  it.each([
    ['Info as a number', { Info: PDFNumber.of(1) }],
    ['OutputCondition as a name', { OutputCondition: N('c') }],
    ['RegistryName as an array', { RegistryName: [PDFString.of('c')] }],
    ['DestOutputProfile as a string', { DestOutputProfile: PDFString.of('not a stream') }],
    ['DestOutputProfile as a dictionary', { DestOutputProfile: { N: 4 } }],
    ['DestOutputProfileRef as a string', { DestOutputProfileRef: PDFString.of('no') }],
    ['MixingHints as an array', { MixingHints: [PDFNumber.of(1)] }],
    ['SpectralData as a string', { SpectralData: PDFString.of('no') }],
  ])('refuses a known optional field of the wrong kind: %s', async (_label, extra) => {
    await refusing((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), ...(extra as object) }),
      ]),
    );
  });

  it('refuses a SpectralData entry that is not a stream', async () => {
    await refusing((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          SpectralData: { Spot1: PDFString.of('not a stream') },
        }),
      ]),
    );
  });

  it.each([
    ['CheckSum as a number', { CheckSum: PDFNumber.of(1) }],
    ['ICCVersion as a name', { ICCVersion: N('v4') }],
    ['ProfileCS as an array', { ProfileCS: [PDFString.of('CMYK')] }],
    ['ProfileName as a number', { ProfileName: PDFNumber.of(1) }],
    ['ColorantTable as a dictionary', { ColorantTable: { Cyan: 1 } }],
    ['a ColorantTable entry that is not a name', { ColorantTable: [PDFString.of('Cyan')] }],
    ['URLs as a dictionary', { URLs: { F: PDFString.of('x') } }],
    ['an empty URLs array', { URLs: [] }],
    ['a URLs entry that is a number', { URLs: [PDFNumber.of(1)] }],
  ])('refuses a DestOutputProfileRef with %s', async (_label, fields) => {
    await refusing((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          DestOutputProfileRef: fields as Fields,
        }),
      ]),
    );
  });

  // ISO 32000-2 7.3.9: a null dictionary value is equivalent to omitting the
  // entry, so a null required field is missing and a null optional one is not
  // there at all.
  it.each(['S', 'OutputConditionIdentifier'])('refuses a null %s as a missing required field', async (key) => {
    await refusing((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), [key]: PDFNull }),
      ]),
    );
  });

  it('treats a null optional field as absent rather than malformed', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          Info: PDFNull,
          DestOutputProfile: PDFNull,
        }),
      ]),
    );
    const { copied } = await carry(built);
    const intent = intentAt(copied!, 0);
    expect(intent.get(N('Info'))).toBeUndefined();
    expect(intent.get(N('DestOutputProfile'))).toBeUndefined();
  });

  it('refuses a later malformed intent even though the first one is valid', async () => {
    await refusing((doc) =>
      doc.context.obj([
        intentWithProfile(doc, iccBytes()),
        doc.context.obj({ OutputConditionIdentifier: PDFString.of('no subtype') }),
      ]),
    );
  });
});

describe('copyOutputIntents — refuses document graphs and behaviour', () => {
  const refusingExtra = async (extra: (doc: PDFDocument) => Record<string, unknown>) => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), ...extra(doc) }),
      ]),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
    expect(output.catalog.get(N('OutputIntents'))).toBeUndefined();
  };

  it('refuses a reference to a page', async () => {
    await refusingExtra((doc) => ({ Vendor: doc.getPage(0).ref }));
  });

  it('refuses a reference to the page tree', async () => {
    await refusingExtra((doc) => ({ Vendor: doc.catalog.get(N('Pages'))! }));
  });

  it('refuses a reference to the catalog', async () => {
    await refusingExtra((doc) => ({ Vendor: doc.context.trailerInfo.Root as PDFObject }));
  });

  // Document, structural and action roots are refused by identity; the
  // catalog's other entries are data an intent may legitimately share.
  it.each(['Pages', 'StructTreeRoot', 'AcroForm', 'Outlines', 'Threads', 'Names', 'Dests', 'OpenAction', 'AA'])(
    'refuses a reference to the catalog %s root',
    async (entry) => {
      await refusingExtra((doc) => {
        const existing = doc.catalog.get(N(entry));
        if (existing !== undefined) return { Vendor: existing };
        const root = doc.context.register(doc.context.obj({ Placeholder: PDFString.of('root') }));
        doc.catalog.set(N(entry), root);
        return { Vendor: root };
      });
    },
  );

  it.each(['Metadata', 'ViewerPreferences', 'PageLabels', 'OCProperties', 'PieceInfo'])(
    'carries a catalog %s entry genuinely shared with the intent',
    async (entry) => {
      const built = await source((doc) => {
        const shared = doc.context.register(doc.context.obj({ Shared: PDFString.of(entry) }));
        doc.catalog.set(N(entry), shared);
        return doc.context.obj([
          doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), Vendor: shared }),
        ]);
      });
      const { copied } = await carry(built);
      expect(intentAt(copied!, 0).lookup(N('Vendor'), PDFDict).lookup(N('Shared'), PDFString).decodeText()).toBe(entry);
    },
  );

  it('carries an opaque metadata stream shared with the source catalog', async () => {
    const packet = new TextEncoder().encode('opaque metadata packet');
    const built = await source((doc) => {
      const metadata = doc.context.register(doc.context.stream(packet, { Type: 'Metadata', Subtype: 'XML' }));
      doc.catalog.set(N('Metadata'), metadata);
      return doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          ExtensionMetadata: metadata,
        }),
      ]);
    });
    const { copied } = await carry(built);
    // Carried as bytes: nothing parsed the packet as XML.
    const carried = streamOf(intentAt(copied!, 0), 'ExtensionMetadata');
    expect(carried.contents).toEqual(packet);
    expect(carried.dict.lookup(N('Subtype'))).toBe(N('XML'));
  });

  it('refuses a page reached through a nested array', async () => {
    await refusingExtra((doc) => ({ Vendor: doc.context.obj([doc.context.obj([doc.getPage(1).ref])]) }));
  });

  it.each(['Page', 'Pages', 'Catalog', 'StructTreeRoot', 'StructElem', 'Action', 'OBJR'])(
    'refuses a dictionary typed %s wherever it appears',
    async (type) => {
      await refusingExtra((doc) => ({ Vendor: doc.context.register(doc.context.obj({ Type: type })) }));
    },
  );

  it('refuses a forbidden Type even when the name is indirect', async () => {
    await refusingExtra((doc) => ({
      Vendor: doc.context.register(doc.context.obj({ Type: doc.context.register(N('Page')) })),
    }));
  });

  // ISO 32000-2 Table 201 lists the standard action subtypes. /Type is
  // optional on an action dictionary but /S is required, so the subtype is
  // what proves an action that omitted its type. Key spelling proves nothing.
  it.each([
    'GoTo', 'GoToR', 'GoToE', 'GoToDp', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide',
    'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'SetOCGState', 'Rendition', 'Trans',
    'GoTo3DView', 'JavaScript', 'RichMediaExecute',
  ])('refuses a typeless %s action reached through extension data', async (subtype) => {
    await refusingExtra((doc) => ({
      Vendor: doc.context.register(doc.context.obj({ S: subtype, F: PDFString.of('not-executed') })),
    }));
  });

  it('refuses an action whose subtype name is indirect', async () => {
    await refusingExtra((doc) => ({
      Vendor: doc.context.register(doc.context.obj({ S: doc.context.register(N('Launch')) })),
    }));
  });

  it('refuses an action nested several levels into extension data', async () => {
    await refusingExtra((doc) => ({
      Vendor: doc.context.obj({
        Level: doc.context.obj([
          doc.context.obj({ Deeper: doc.context.register(doc.context.obj({ S: 'JavaScript' })) }),
        ]),
      }),
    }));
  });

  it('refuses an action reached through an additional-actions style field', async () => {
    await refusingExtra((doc) => ({
      Vendor: doc.context.obj({ AA: { O: doc.context.obj({ S: 'Launch' }) } }),
    }));
  });

  it('refuses a root that is itself a catalog entry other than OutputIntents', async () => {
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, iccBytes())]));
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.doc.catalog.get(N('Pages')))).toThrow();
  });

  it('still accepts the catalog OutputIntents reference itself', async () => {
    const built = await source((doc) => doc.context.register(doc.context.obj([intentWithProfile(doc, iccBytes())])));
    const { copied } = await carry(built);
    expect(copied!.size()).toBe(1);
    expect(intentAt(copied!, 0).lookup(N('S'))).toBe(N('GTS_PDFX'));
  });

  it('accepts a page-level value, which is not a catalog root at all', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([300, 700]);
    const raw = doc.context.register(
      doc.context.obj([doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('page condition') })]),
    );
    page.node.set(N('OutputIntents'), raw);
    const output = await empty();
    const copied = copyOutputIntents(output, doc, raw);
    expect(copied!.lookup(0, PDFDict).lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe(
      'page condition',
    );
  });
});

describe('copyOutputIntents — key spelling carries no meaning', () => {
  // A spectral dictionary's keys are colourant names, and a colourant may be
  // called anything. An extension scalar is a scalar whatever its key says.
  const ACTIONISH = ['A', 'AA', 'OpenAction', 'JS', 'Next', 'Kids', 'Parent', 'Launch', 'S', 'Type'];

  it('carries spectral colourants whose names look like action keys', async () => {
    const bytes = new TextEncoder().encode('opaque spectral bytes');
    const built = await source((doc) => {
      const spectral = doc.context.obj({});
      for (const name of ACTIONISH) spectral.set(N(name), doc.context.register(doc.context.stream(bytes)));
      return doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          SpectralData: spectral,
        }),
      ]);
    });
    const { copied } = await carry(built);
    const spectral = intentAt(copied!, 0).lookup(N('SpectralData'), PDFDict);
    for (const name of ACTIONISH) {
      expect(spectral.lookup(N(name))).toBeInstanceOf(PDFRawStream);
      expect((spectral.lookup(N(name)) as PDFRawStream).contents).toEqual(bytes);
    }
  });

  // S and Type are the intent's own validated fields, so they are excluded
  // here: at the intent root their shape is checked, not carried blindly.
  it.each(ACTIONISH.filter((key) => key !== 'S' && key !== 'Type'))(
    'carries a scalar extension field named %s',
    async (key) => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), [key]: PDFNumber.of(7) }),
      ]),
    );
      const { copied } = await carry(built);
      expect(intentAt(copied!, 0).lookup(N(key), PDFNumber).asNumber()).toBe(7);
    },
  );

  it.each(['S', 'Type'])('still validates the intent root own %s field', async (key) => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), [key]: PDFNumber.of(7) }),
      ]),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('carries an extension dictionary whose keys look executable but hold data', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          Vendor: {
            A: PDFNumber.of(7),
            JS: PDFString.of('a colourant note, not a script'),
            Next: PDFName.of('SpotTwo'),
            Parent: PDFString.of('a label'),
            Kids: [PDFNumber.of(1), PDFNumber.of(2)],
          },
        }),
      ]),
    );
    const { copied } = await carry(built);
    const vendor = intentAt(copied!, 0).lookup(N('Vendor'), PDFDict);
    expect(vendor.lookup(N('A'), PDFNumber).asNumber()).toBe(7);
    expect(vendor.lookup(N('JS'), PDFString).decodeText()).toBe('a colourant note, not a script');
    expect(vendor.lookup(N('Next'))).toBe(N('SpotTwo'));
    expect(vendor.lookup(N('Kids'), PDFArray).size()).toBe(2);
  });

  it('carries an extension dictionary whose subtype is not an action subtype', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          Vendor: doc.context.register(doc.context.obj({ S: 'VendorRole', Payload: PDFString.of('data') })),
        }),
      ]),
    );
    const { copied } = await carry(built);
    const vendor = intentAt(copied!, 0).lookup(N('Vendor'), PDFDict);
    expect(vendor.lookup(N('S'))).toBe(N('VendorRole'));
    expect(vendor.lookup(N('Payload'), PDFString).decodeText()).toBe('data');
  });

  it('preserves an unknown intent subtype that collides with an action subtype name', async () => {
    // The intent root's own /S is the output intent subtype. It is never read
    // as an action, even when it spells one.
    const built = await source((doc) =>
      doc.context.obj([doc.context.obj({ S: 'Launch', OutputConditionIdentifier: PDFString.of('c') })]),
    );
    const { copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('S'))).toBe(N('Launch'));
  });
});

describe('copyOutputIntents — indirect null is absence', () => {
  it.each(['Type', 'Info', 'OutputCondition', 'RegistryName', 'DestOutputProfile', 'MixingHints', 'SpectralData', 'DestOutputProfileRef'])(
    'treats an indirect null %s as absent',
    async (key) => {
      const built = await source((doc) =>
        doc.context.obj([
          doc.context.obj({
            S: 'GTS_PDFX',
            OutputConditionIdentifier: PDFString.of('c'),
            [key]: doc.context.register(PDFNull),
          }),
        ]),
      );
      const { copied, output } = await carry(built);
      expect(copied).toBeInstanceOf(PDFArray);
      // Validation read it as absent; the copy still carries what was
      // written, so the entry arrives as an indirect null rather than being
      // invented away.
      const carried = intentAt(copied!, 0).get(N(key));
      expect(carried).toBeInstanceOf(PDFRef);
      expect(output.context.lookup(carried)).toBe(PDFNull);
    },
  );

  it('treats every optional field being indirect null as a bare valid intent', async () => {
    const built = await source((doc) => {
      const intent = doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c') });
      for (const key of ['Type', 'Info', 'DestOutputProfile', 'MixingHints', 'SpectralData', 'DestOutputProfileRef']) {
        intent.set(N(key), doc.context.register(PDFNull));
      }
      return doc.context.obj([doc.context.register(intent)]);
    });
    const { copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe('c');
  });

  it.each(['S', 'OutputConditionIdentifier'])('still refuses an indirect null %s', async (key) => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          [key]: doc.context.register(PDFNull),
        }),
      ]),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });
});

describe('copyOutputIntents — the supplied root keeps its identity', () => {
  it('resolves a cycle back to the root array to the array returned', async () => {
    const built = await source((doc) => {
      const intent = doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c') });
      const root = doc.context.obj([doc.context.register(intent)]);
      const ref = doc.context.register(root);
      intent.set(N('IntentSet'), ref);
      return ref;
    });
    const { output, copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('IntentSet'))).toBe(copied);
    // The caller can find the reference already allocated for it.
    const ref = intentAt(copied!, 0).get(N('IntentSet'));
    expect(ref).toBeInstanceOf(PDFRef);
    expect(output.context.getObjectRef(copied!)).toBe(ref);
  });

  it('keeps one copy of the root when two intents both cycle back to it', async () => {
    const built = await source((doc) => {
      const first = doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('one') });
      const second = doc.context.obj({ S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('two') });
      const ref = doc.context.register(doc.context.obj([doc.context.register(first), doc.context.register(second)]));
      first.set(N('IntentSet'), ref);
      second.set(N('IntentSet'), ref);
      return ref;
    });
    const { output, copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('IntentSet'))).toBe(copied);
    expect(intentAt(copied!, 1).lookup(N('IntentSet'))).toBe(copied);
    const arrays = output.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFArray);
    expect(arrays).toHaveLength(1);
  });

  it('has no root reference to map when the supplied value is a direct array', async () => {
    const built = await source((doc) =>
      doc.context.obj([doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c') })]),
    );
    const { output, copied } = await carry(built);
    expect(copied).toBeInstanceOf(PDFArray);
    expect(output.context.getObjectRef(copied!)).toBeUndefined();
  });
});

describe('copyOutputIntents — budgets', () => {
  const build = async (extra: (doc: PDFDocument) => Fields) =>
    source((doc) =>
      doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), ...extra(doc) }),
      ]),
    );

  it('refuses a graph deeper than the depth bound', async () => {
    const built = await build((doc) => {
      let node = doc.context.obj({ Leaf: PDFString.of('deep') });
      for (let i = 0; i < 80; i++) node = doc.context.obj({ Down: node });
      return { Vendor: node };
    });
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('accepts a graph inside the depth bound', async () => {
    const built = await build((doc) => {
      let node = doc.context.obj({ Leaf: PDFString.of('deep') });
      for (let i = 0; i < 20; i++) node = doc.context.obj({ Down: node });
      return { Vendor: node };
    });
    const { copied } = await carry(built);
    expect(copied!.size()).toBe(1);
  });

  it('refuses a graph wider than the object bound', async () => {
    const built = await build((doc) => ({
      Vendor: doc.context.obj(Array.from({ length: 6_000 }, (_, i) => PDFNumber.of(i))),
    }));
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('accepts a graph inside the object bound', async () => {
    const built = await build((doc) => ({
      Vendor: doc.context.obj(Array.from({ length: 500 }, (_, i) => PDFNumber.of(i))),
    }));
    const { copied } = await carry(built);
    expect(intentAt(copied!, 0).lookup(N('Vendor'), PDFArray).size()).toBe(500);
  });

  it('refuses when the aggregate stream bytes pass the byte bound', async () => {
    // Incompressible bytes, so the stored length is the length that counts.
    const chunk = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761) & 0xff;
    const built = await source((doc) =>
      doc.context.obj(
        Array.from({ length: 4 }, (_, i) =>
          doc.context.obj({
            S: 'GTS_PDFX',
            OutputConditionIdentifier: PDFString.of(`c${i}`),
            DestOutputProfile: doc.context.register(doc.context.stream(chunk, { N: 4 })),
          }),
        ),
      ),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('counts string bytes toward the same aggregate bound as streams', async () => {
    const built = await build(() => ({ Extension: PDFString.of('x'.repeat(33 * 1024 * 1024)) }));
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('counts hex string bytes toward the bound', async () => {
    const built = await build(() => ({ Extension: PDFHexString.of('ab'.repeat(17 * 1024 * 1024)) }));
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('counts a profile stream and a large string together', async () => {
    // Neither alone exceeds the bound; together they do.
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          DestOutputProfile: doc.context.register(doc.context.stream(new Uint8Array(20 * 1024 * 1024), { N: 4 })),
          Extension: PDFString.of('x'.repeat(20 * 1024 * 1024)),
        }),
      ]),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('counts name spellings and dictionary keys toward the bound', async () => {
    const long = 'k'.repeat(200_000);
    const built = await build((doc) => {
      const vendor = doc.context.obj({});
      for (let i = 0; i < 200; i++) vendor.set(N(`${long}${i}`), N(`${long}${i}`));
      return { Extension: vendor };
    });
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('bounds a wide SpectralData dictionary during validation, before any copy', async () => {
    const built = await source((doc) => {
      const spectral = doc.context.obj({});
      const stream = doc.context.register(doc.context.stream('x'));
      for (let i = 0; i < 6_000; i++) spectral.set(N(`Spot${i}`), stream);
      return doc.context.obj([
        doc.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('c'), SpectralData: spectral }),
      ]);
    });
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
    expect(output.catalog.get(N('OutputIntents'))).toBeUndefined();
  });

  it('bounds a wide ColorantTable during validation', async () => {
    const built = await source((doc) =>
      doc.context.obj([
        doc.context.obj({
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('c'),
          DestOutputProfileRef: { ColorantTable: Array.from({ length: 6_000 }, (_, i) => N(`Spot${i}`)) },
        }),
      ]),
    );
    const output = await empty();
    expect(() => copyOutputIntents(output, built.doc, built.raw)).toThrow();
  });

  it('accepts a profile comfortably inside the byte bound', async () => {
    const icc = iccBytes(512 * 1024);
    const built = await source((doc) => doc.context.obj([intentWithProfile(doc, icc)]));
    const { copied } = await carry(built);
    expect(decodePDFRawStream(streamOf(intentAt(copied!, 0))).decode()).toEqual(icc);
  });
});
