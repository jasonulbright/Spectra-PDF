import {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull,
  PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFString,
} from 'pdf-lib';
import { tChrome } from '../i18n';
import { metadataInput, METADATA_BYTES } from './metadata-stream';
import { transformMetadata } from './metadata-host';
import type { MetadataOverrides } from './metadata-process';

const N = PDFName.of.bind(PDFName);
const invalid = (): never => { throw new Error(tChrome('app.operation.unverified')); };

/** Stream extension attributes may contain bounded pure data, never a copied
 * document/page graph or another executable/externally sourced stream. Preserve
 * sharing/cycles through a single map; refuse unknown graph semantics. */
function copyAttributes(source: PDFDocument, output: PDFDocument, dict: PDFDict): PDFDict {
  const map = new Map<PDFObject, PDFObject>();
  const pageNodes = new Set<PDFDict>(source.getPages().map(page => page.node));
  let nodes = 0, bytes = 0;
  const copy = (raw: PDFObject, depth: number): PDFObject => {
    if (depth > 128 || ++nodes > 10000) invalid();
    const prior = map.get(raw); if (prior) return prior;
    const value = raw instanceof PDFRef ? source.context.lookup(raw) : raw;
    if (!value || value === PDFNull) return PDFNull;
    if (raw instanceof PDFRef) {
      const ref = output.context.nextRef(); map.set(raw, ref);
      output.context.assign(ref, copy(value, depth + 1)); return ref;
    }
    if (value instanceof PDFArray) {
      const array = output.context.obj([]); map.set(value, array);
      for (const item of value.asArray()) array.push(copy(item, depth + 1));
      return array;
    }
    if (value instanceof PDFDict) {
      const type = value.lookup(N('Type'));
      if (type instanceof PDFName && ['Catalog', 'Page', 'Pages', 'StructElem', 'StructTreeRoot', 'Annot', 'Action'].includes(type.decodeText())) invalid();
      if (value === source.catalog || pageNodes.has(value)) invalid();
      const result = output.context.obj({}); map.set(value, result);
      for (const [key, item] of value.entries()) {
        bytes += key.sizeInBytes(); if (bytes > METADATA_BYTES) invalid();
        result.set(key, copy(item, depth + 1));
      }
      return result;
    }
    if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) {
      bytes += value.sizeInBytes(); if (bytes > METADATA_BYTES) invalid();
      return value.clone();
    }
    if (value instanceof PDFNumber) { if (!Number.isFinite(value.asNumber())) invalid(); return value.clone(); }
    if (value instanceof PDFBool) return value;
    return invalid();
  };
  const result = output.context.obj({});
  for (const [key, value] of dict.entries()) if (key !== N('Length')) result.set(key, copy(value, 0));
  return result;
}

/** Document metadata belongs to the owner even when none of its pages remain.
 * No packet is synthesized for an absent entry, and donor packets never enter
 * this boundary. Publish the stream only after the entire transform succeeds. */
export async function carryDocumentMetadata(output: PDFDocument, source: PDFDocument, overrides: MetadataOverrides): Promise<void> {
  try {
    const stream = source.catalog.lookup(N('Metadata'));
    if (stream === undefined || stream === PDFNull) return;
    if (!(stream instanceof PDFRawStream) || stream.dict.lookup(N('Type')) !== N('Metadata') || stream.dict.lookup(N('Subtype')) !== N('XML')) invalid();
    const input = metadataInput(stream as PDFRawStream);
    const attributes = copyAttributes(source, output, (stream as PDFRawStream).dict);
    const result = await transformMetadata({ input, overrides });
    if (result.changed) {
      attributes.delete(N('Filter')); attributes.delete(N('DecodeParms'));
      // /DL is an optional decoded length hint, not the encoded /Length.
      if (attributes.has(N('DL'))) attributes.set(N('DL'), PDFNumber.of(result.bytes.length));
    }
    const bytes = result.changed ? result.bytes : input.bytes;
    const carried = PDFRawStream.of(attributes, bytes);
    output.catalog.set(N('Metadata'), output.context.register(carried));
  } catch { invalid(); }
}
