import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { METADATA_BYTES, decodeMetadata, decodeXmlBytes, encodeXmlBytes, metadataInput } from '../src/renderer/lib/metadata-stream';

const encoder = new TextEncoder();
const flate = (bytes: Uint8Array, params: Record<string, number> = {}) => decodeMetadata({ bytes: deflateSync(bytes), filters: [{ name: 'FlateDecode', params }] });
type StreamAttributes = NonNullable<Parameters<PDFDocument['context']['stream']>[1]>;
const raw = async (bytes: Uint8Array, dict: StreamAttributes = {}) => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  return PDFRawStream.of(pdf.context.obj(dict), bytes);
};

describe('bounded metadata decoding', () => {
  it('decodes unfiltered and flate streams without changing source bytes', async () => {
    const bytes = encoder.encode('<r>text é</r>'), before = bytes.slice();
    expect(await decodeMetadata({ bytes, filters: [] })).toEqual(bytes);
    expect(await flate(bytes)).toEqual(bytes); expect(bytes).toEqual(before);
  });
  it('applies ordered filters, including abbreviated names', async () => {
    const expected = encoder.encode('<r>metadata</r>');
    const encoded = encoder.encode(Buffer.from(deflateSync(expected)).toString('hex') + '>');
    const source = await raw(encoded, { Filter: ['AHx', 'Fl'], DecodeParms: [null, null] });
    expect(await decodeMetadata(metadataInput(source))).toEqual(expected);
  });
  it('preserves explicit identity crypt filters but never assumes a named filter decrypted', async () => {
    const bytes = encoder.encode('<r/>');
    for (const DecodeParms of [undefined, {}, { Name: 'Identity' }]) expect(await decodeMetadata(metadataInput(await raw(bytes, { Filter: 'Crypt', DecodeParms })))).toEqual(bytes);
    const encrypted = await raw(bytes, { Filter: 'Crypt', DecodeParms: { Name: 'StdCF' } });
    expect(() => metadataInput(encrypted)).toThrow();
  });
  it('decodes ASCII85, run length and LZW through real library decoders', async () => {
    expect(new TextDecoder().decode(await decodeMetadata({ bytes: encoder.encode('87cURD_*#TDfTZ)+T~>'), filters: [{ name: 'ASCII85Decode', params: {} }] }))).toBe('Hello, world!');
    expect(await decodeMetadata({ bytes: new Uint8Array([2, 65, 66, 67, 254, 68, 128]), filters: [{ name: 'RunLengthDecode', params: {} }] })).toEqual(encoder.encode('ABCDDD'));
    // Clear, A, B, C, EOD, all 9-bit codes before a width transition.
    const codes = [256, 65, 66, 67, 257].map(n => n.toString(2).padStart(9, '0')).join('').padEnd(48, '0');
    const bytes = new Uint8Array(codes.match(/.{8}/g)!.map(s => parseInt(s, 2)));
    for (const EarlyChange of [0, 1]) expect(await decodeMetadata({ bytes, filters: [{ name: 'LZWDecode', params: { EarlyChange } }] })).toEqual(encoder.encode('ABC'));
  });
  it('guards buffer growth before a compressed bomb allocates decoded output', async () => {
    const bytes = deflateSync(new Uint8Array(METADATA_BYTES + 1));
    const Original = globalThis.Uint8Array;
    let largest = 0;
    const Wrapped = new Proxy(Original, { construct(target, args) {
      if (typeof args[0] === 'number') largest = Math.max(largest, args[0]);
      return Reflect.construct(target, args);
    } });
    vi.stubGlobal('Uint8Array', Wrapped);
    try { await expect(decodeMetadata({ bytes, filters: [{ name: 'FlateDecode', params: {} }] })).rejects.toThrow(); }
    finally { vi.unstubAllGlobals(); }
    expect(largest).toBeLessThanOrEqual(METADATA_BYTES);
  });
  it.each([0, 1, 2, 3, 4])('reverses PNG row filter %s with previous-row context', async filter => {
    const a = [10, 20, 30], b = [40, 50, 60];
    const encodeRow = (row: number[], prev: number[]) => row.map((n, i) => {
      const left = i ? row[i - 1] : 0, up = prev[i] ?? 0, corner = i ? prev[i - 1] ?? 0 : 0;
      const p = left + up - corner, distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
      const chosen = [left, up, corner][distances.indexOf(Math.min(...distances))];
      return (n - [0, left, up, Math.floor((left + up) / 2), chosen][filter] + 256) % 256;
    });
    expect(await flate(new Uint8Array([filter, ...encodeRow(a, []), filter, ...encodeRow(b, a)]), { Predictor: 15, Columns: 3 })).toEqual(new Uint8Array([...a, ...b]));
  });
  it('reverses packed TIFF prediction at 1, 4, 8 and 16 bits', async () => {
    for (const [bits, encoded, expected] of [
      [1, [0b11100000], [0b10100000]], [4, [0x13, 0x20], [0x14, 0x60]],
      [8, [1, 3, 2], [1, 4, 6]], [16, [0, 1, 0, 3, 0, 2], [0, 1, 0, 4, 0, 6]],
    ] as const) expect(await flate(new Uint8Array(encoded), { Predictor: 2, Columns: 3, BitsPerComponent: bits })).toEqual(new Uint8Array(expected));
  });
  it('refuses invalid predictors, shape/cardinality and external streams', async () => {
    const badParams: Record<string, number>[] = [{ Predictor: 9 }, { Predictor: 15, Columns: 0 }, { Predictor: 2, BitsPerComponent: 3 }, { EarlyChange: 2 }];
    for (const params of badParams) await expect(flate(new Uint8Array([1, 2, 3]), params)).rejects.toThrow();
    for (const dict of [{ Filter: 'DCTDecode' }, { Filter: ['FlateDecode', 'ASCIIHexDecode'], DecodeParms: {} }, { Filter: ['FlateDecode'], DecodeParms: [] }, { F: PDFString.of('https://example.invalid/file') }]) {
      const stream = await raw(new Uint8Array(), dict); expect(() => metadataInput(stream)).toThrow();
    }
    const stream = await raw(new Uint8Array()); stream.dict.set(PDFName.of('Filter'), PDFString.of('FlateDecode'));
    expect(() => metadataInput(stream)).toThrow();
    await expect(decodeMetadata({ bytes: new Uint8Array(METADATA_BYTES + 1), filters: [] })).rejects.toThrow();
  });
});

describe('metadata XML byte encoding', () => {
  it.each(['utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be'])('reads %s and rewrites only its declaration on UTF-8 emission', encoding => {
    const xml = `<?xml version="1.0" encoding="${encoding}"?><r>é𐀀</r>`;
    let bytes: Uint8Array;
    if (encoding === 'utf-8') bytes = encoder.encode(xml);
    else if (encoding.startsWith('utf-16')) {
      bytes = new Uint8Array(Buffer.from(xml, 'utf16le'));
      if (encoding.endsWith('be')) for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
    } else {
      const cps = [...xml].map(c => c.codePointAt(0)!); bytes = new Uint8Array(cps.length * 4);
      const view = new DataView(bytes.buffer); cps.forEach((cp, i) => view.setUint32(i * 4, cp, encoding.endsWith('le')));
    }
    expect(decodeXmlBytes(bytes)).toBe(xml);
    expect(new TextDecoder().decode(encodeXmlBytes(xml))).toBe(xml.replace(encoding, 'UTF-8'));
  });
  it('detects a declaration-less UTF-16 root and refuses wrong declarations and malformed bytes', () => {
    expect(decodeXmlBytes(Buffer.from('<rdf>é</rdf>', 'utf16le'))).toBe('<rdf>é</rdf>');
    expect(() => decodeXmlBytes(encoder.encode('<?xml version="1.0" encoding="UTF-16"?><r/>'))).toThrow();
    expect(() => decodeXmlBytes(new Uint8Array([0xc0, 0xaf]))).toThrow();
    expect(() => decodeXmlBytes(new Uint8Array([0, 0, 254, 255, 0, 17, 0, 0]))).toThrow();
  });
});
