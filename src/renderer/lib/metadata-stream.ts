import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/** Each encoded/intermediate/decoded stage is capped before allocation. */
export const METADATA_BYTES = 4 * 1024 * 1024;
export interface MetadataFilter { name: string; params: Record<string, number> }
export interface MetadataInput { bytes: Uint8Array; filters: MetadataFilter[] }
const N = PDFName.of.bind(PDFName);
const invalid = (): never => { throw new Error('metadata stream cannot be preserved'); };
const aliases: Record<string, string> = { Fl: 'FlateDecode', LZW: 'LZWDecode', A85: 'ASCII85Decode', AHx: 'ASCIIHexDecode', RL: 'RunLengthDecode' };
const supported = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode', 'Identity']);

export function metadataInput(stream: PDFRawStream): MetadataInput {
  if (stream.getContentsSize() > METADATA_BYTES) invalid();
  for (const key of ['F', 'FFilter', 'FDecodeParms']) {
    const value = stream.dict.lookup(N(key)); if (value !== undefined && value !== PDFNull) invalid();
  }
  const raw = stream.dict.lookup(N('Filter')), parms = stream.dict.lookup(N('DecodeParms'));
  const names = raw === undefined || raw === PDFNull ? [] : raw instanceof PDFArray ? raw.asArray().map(x => stream.dict.context.lookup(x)) : [raw];
  if (names.length > 16) invalid();
  if (parms !== undefined && parms !== PDFNull && !(parms instanceof PDFDict || parms instanceof PDFArray)) invalid();
  if (parms instanceof PDFArray && parms.size() !== names.length) invalid();
  if (names.length > 1 && parms instanceof PDFDict) invalid();
  if (names.length === 0 && parms !== undefined && parms !== PDFNull) invalid();
  const filters = names.map((value, index) => {
    if (!(value instanceof PDFName)) invalid();
    const spelling = (value as PDFName).decodeText(), name = Object.hasOwn(aliases, spelling) ? aliases[spelling] : spelling;
    if (!supported.has(name) && name !== 'Crypt') invalid();
    const dict = parms instanceof PDFArray ? parms.lookup(index) : parms;
    if (dict !== undefined && dict !== PDFNull && !(dict instanceof PDFDict)) invalid();
    // An explicit identity crypt filter is unencrypted by definition. Any
    // named crypt method would require the security handler, never a guess.
    if (name === 'Crypt') {
      const method = dict instanceof PDFDict ? dict.lookup(N('Name')) : undefined;
      if (method !== undefined && method !== PDFNull && method !== N('Identity')) invalid();
      return { name: 'Identity', params: {} };
    }
    if (name === 'Identity') invalid(); // Internal representation, not a PDF filter spelling.
    const params: Record<string, number> = {};
    if (dict instanceof PDFDict) for (const key of ['Predictor', 'Colors', 'Columns', 'BitsPerComponent', 'EarlyChange']) {
      const number = dict.lookup(N(key)); if (number === undefined || number === PDFNull) continue;
      if (!(number instanceof PDFNumber) || !Number.isSafeInteger(number.asNumber())) invalid();
      params[key] = (number as PDFNumber).asNumber();
    }
    return { name, params };
  });
  return { bytes: stream.getContents().slice(), filters };
}

/** Reverse TIFF/PNG prediction at each Flate/LZW layer, not after the chain. */
function unPredict(bytes: Uint8Array, params: Record<string, number>): Uint8Array {
  const predictor = params.Predictor ?? 1;
  if (predictor === 1) return bytes;
  if (predictor !== 2 && (predictor < 10 || predictor > 15)) invalid();
  const colors = params.Colors ?? 1, columns = params.Columns ?? 1, bits = params.BitsPerComponent ?? 8;
  const samples = colors * columns, rowBytes = Math.ceil(samples * bits / 8), pixelBytes = Math.ceil(colors * bits / 8);
  if (colors < 1 || columns < 1 || ![1, 2, 4, 8, 16].includes(bits) || !Number.isSafeInteger(rowBytes) || rowBytes < 1 || rowBytes > METADATA_BYTES) invalid();
  const stride = rowBytes + (predictor === 2 ? 0 : 1);
  if (bytes.length % stride !== 0) invalid();
  const output = new Uint8Array(bytes.length / stride * rowBytes);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let start = 0, dest = 0; start < bytes.length; start += stride, dest += rowBytes) {
    if (predictor === 2) {
      output.set(bytes.subarray(start, start + rowBytes), dest);
      const mask = (1 << bits) - 1;
      const sample = (index: number) => {
        let value = 0;
        for (let b = 0; b < bits; b++) { const pos = index * bits + b; value = (value << 1) | ((output[dest + (pos >> 3)] >> (7 - (pos & 7))) & 1); }
        return value;
      };
      for (let s = colors; s < samples; s++) {
        const value = (sample(s) + sample(s - colors)) & mask;
        for (let b = 0; b < bits; b++) {
          const pos = s * bits + b, i = dest + (pos >> 3), shift = 7 - (pos & 7);
          output[i] = (output[i] & ~(1 << shift)) | (((value >> (bits - b - 1)) & 1) << shift);
        }
      }
    } else {
      const filter = bytes[start]; if (filter > 4) invalid();
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= pixelBytes ? output[dest + i - pixelBytes] : 0;
        const up = dest >= rowBytes ? output[dest + i - rowBytes] : 0;
        const upperLeft = dest >= rowBytes && i >= pixelBytes ? output[dest + i - rowBytes - pixelBytes] : 0;
        const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upperLeft);
        output[dest + i] = (bytes[start + 1 + i] + prediction) & 255;
      }
    }
  }
  return output;
}

export async function decodeMetadata(input: MetadataInput): Promise<Uint8Array> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > METADATA_BYTES || input.filters.length > 16) invalid();
  let bytes = input.bytes;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (const { name, params } of input.filters) {
    if (!supported.has(name) || Object.values(params).some(n => !Number.isSafeInteger(n))) invalid();
    if (name === 'Identity') continue;
    if (params.EarlyChange !== undefined && ![0, 1].includes(params.EarlyChange)) invalid();
    const raw = PDFRawStream.of(pdf.context.obj({ Filter: name, DecodeParms: params }), bytes);
    const decoded = decodePDFRawStream(raw) as unknown as {
      ensureBuffer: (size: number) => Uint8Array; decode: () => Uint8Array;
    };
    // pdf-lib 1.17.1 decoders grow exclusively through this per-instance
    // method. Guard the allocation itself; checking decoded size afterwards
    // does not constrain a one-block compression bomb. No prototype changes.
    if (typeof decoded.ensureBuffer !== 'function') invalid();
    const allocate = decoded.ensureBuffer.bind(decoded);
    decoded.ensureBuffer = size => { if (!Number.isSafeInteger(size) || size < 0 || size > METADATA_BYTES) invalid(); return allocate(size); };
    bytes = decoded.decode();
    if (bytes.length > METADATA_BYTES) invalid();
    if (name === 'FlateDecode' || name === 'LZWDecode') bytes = unPredict(bytes, params);
  }
  return bytes;
}

export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length > METADATA_BYTES) invalid();
  // XML's byte signature determines Unicode encoding before parsing its
  // declaration. UTF-32 needs a small explicit decoder (TextDecoder lacks it).
  let encoding = 'utf-8', offset = 0, utf32 = false, little = false;
  const prefix = (...v: number[]) => v.every((value, i) => bytes[i] === value);
  if (prefix(0, 0, 254, 255) || prefix(0, 0, 0, 60)) { utf32 = true; offset = bytes[2] === 254 ? 4 : 0; }
  else if (prefix(255, 254, 0, 0) || prefix(60, 0, 0, 0)) { utf32 = true; little = true; offset = bytes[0] === 255 ? 4 : 0; }
  else if (prefix(255, 254) || prefix(60, 0) && bytes[3] === 0) encoding = 'utf-16le';
  else if (prefix(254, 255) || prefix(0, 60, 0)) encoding = 'utf-16be';
  let xml: string;
  if (utf32) {
    if ((bytes.length - offset) % 4) invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts: string[] = [];
    for (let i = offset; i < bytes.length; i += 4) {
      const cp = view.getUint32(i, little);
      if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) invalid();
      parts.push(String.fromCodePoint(cp));
    }
    xml = parts.join('');
  } else xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1[^?]*\?>/.exec(xml)?.[2].toLowerCase();
  const actual = utf32 ? little ? 'utf-32le' : 'utf-32be' : encoding;
  if (declared && declared !== actual && !(declared === 'utf-16' && actual.startsWith('utf-16')) && !(declared === 'utf-32' && utf32)) invalid();
  return xml;
}

/** Only the XML declaration is rewritten when transformed text becomes UTF-8;
 * element/attribute/property manipulation belongs to the namespace parser. */
export function encodeXmlBytes(xml: string): Uint8Array {
  const normalized = xml.replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)(['"])[^'"]+\2/, '$1"UTF-8"');
  const bytes = new TextEncoder().encode(normalized); if (bytes.length > METADATA_BYTES) invalid(); return bytes;
}
