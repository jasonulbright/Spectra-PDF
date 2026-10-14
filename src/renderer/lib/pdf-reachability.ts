import { PDFArray, PDFDict, PDFInvalidObject, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';

const latin1 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return parts.join('');
};

/** The bytes of an unparsed object, as the writer emits them. */
function rawBytes(object: PDFInvalidObject): Uint8Array {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  return bytes;
}

const TOKEN_BREAK = /[\0\t\n\f\r ()<>[\]{}/%]+/;
const WHOLE_NUMBER = /^\+?0*(\d{1,15})(?:\.0*)?$/;

function referencesAmongTokens(context: PDFContext, text: string, found: Map<string, PDFRef>): void {
  const tokens = text.split(TOKEN_BREAK);
  for (let i = 2; i < tokens.length; i += 1) {
    if (tokens[i] !== 'R') continue;
    const object = WHOLE_NUMBER.exec(tokens[i - 2]);
    const generation = WHOLE_NUMBER.exec(tokens[i - 1]);
    if (!object || !generation) continue;
    const objectNumber = Number(object[1]);
    const generationNumber = Number(generation[1]);
    if (objectNumber > context.largestObjectNumber || generationNumber > 65535) continue;
    const ref = PDFRef.of(objectNumber, generationNumber);
    found.set(ref.tag, ref);
  }
}

/**
 * Every reference the bytes of an unparsed object can hold. The parser keeps
 * an object it cannot read as its bytes and the writer emits them verbatim, so
 * each `N G R` in them names an object of this context.
 *
 * The reading is a superset of any reader's: three consecutive tokens count
 * wherever they stand (inside a string, in stream data), a number may carry a
 * plus sign, leading zeros or a zero fraction, and the bytes are read twice,
 * with comments removed and with `%` as a plain delimiter, because a `%`
 * inside a string starts no comment.
 */
function referencesInRawBytes(context: PDFContext, data: Uint8Array): PDFRef[] {
  const text = latin1(data);
  const found = new Map<string, PDFRef>();
  referencesAmongTokens(context, text, found);
  if (text.includes('%')) referencesAmongTokens(context, text.replace(/%[^\r\n]*/g, ' '), found);
  return [...found.values()];
}

/** Walks everything `roots` reach through dictionary values, array entries,
 *  stream dictionaries and the bytes of unparsed objects. The walk is
 *  iterative and enters each reference and each container once. A dictionary
 *  inside an unparsed object is not visited: it exists only as bytes. */
function walkReachable(
  context: PDFContext,
  roots: Iterable<PDFObject | undefined>,
  visit: { reference?: (ref: PDFRef) => void; dictionary?: (dict: PDFDict) => void },
): void {
  const tags = new Set<string>();
  const entered = new Set<PDFObject>();
  const stack: PDFObject[] = [];
  for (const root of roots) if (root) stack.push(root);
  for (let value = stack.pop(); value; value = stack.pop()) {
    if (value instanceof PDFRef) {
      if (tags.has(value.tag)) continue;
      tags.add(value.tag);
      visit.reference?.(value);
      const target = context.lookup(value);
      if (target) stack.push(target);
      continue;
    }
    if (value instanceof PDFInvalidObject) {
      if (entered.has(value)) continue;
      entered.add(value);
      for (const ref of referencesInRawBytes(context, rawBytes(value))) stack.push(ref);
      continue;
    }
    const held = value instanceof PDFStream ? value.dict : value;
    if (entered.has(held)) continue;
    if (held instanceof PDFDict) {
      entered.add(held);
      visit.dictionary?.(held);
      for (const [, entry] of held.entries()) stack.push(entry);
    } else if (held instanceof PDFArray) {
      entered.add(held);
      for (const entry of held.asArray()) stack.push(entry);
    }
  }
}

/** The tag of every indirect object that `roots` reach. */
export function reachableTags(context: PDFContext, roots: Iterable<PDFObject | undefined>): Set<string> {
  const tags = new Set<string>();
  walkReachable(context, roots, { reference: (ref) => tags.add(ref.tag) });
  return tags;
}

/** Every dictionary that `roots` reach, direct or indirect, stream
 *  dictionaries included. The list is complete before the caller edits any
 *  of them. */
export function reachableDictionaries(context: PDFContext, roots: Iterable<PDFObject | undefined>): PDFDict[] {
  const dictionaries: PDFDict[] = [];
  walkReachable(context, roots, { dictionary: (dict) => dictionaries.push(dict) });
  return dictionaries;
}

/**
 * Deletes every indirect object the trailer does not reach. pdf-lib writes
 * each object its context holds, so an object taken out of the graph (a
 * removed annotation, a replaced stream) is otherwise saved with its content.
 *
 * The roots are the four trailer entries the writer emits. A loaded document
 * holds no other trailer key, no object-stream container and no
 * cross-reference stream: the parser keeps none of them. An object the loaded
 * file held outside this graph (an object a later revision freed, a
 * linearization dictionary, a hint stream) is deleted with the rest.
 *
 * Fonts, images and attachments reserve a reference when they are embedded
 * and assign its object in `PDFDocument.flush()`: the caller flushes first, or
 * their objects are not yet linked. Object numbers are not reused or
 * renumbered.
 *
 * Nothing is deleted unless every reference of the graph can be listed. An
 * unparsed object the trailer reaches gives its references from its bytes. An
 * unparsed object that holds a stream and that the trailer does not reach can
 * be an object stream or a cross-reference stream the parser failed to expand:
 * its members are then missing from the context and the graph is not known,
 * so the document is saved with every object it holds.
 */
export function dropUnreachableObjects(doc: PDFDocument): void {
  const context = doc.context;
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  const live = reachableTags(context, [Root, Info, Encrypt, ID]);
  const objects = context.enumerateIndirectObjects();
  for (const [ref, object] of objects) {
    if (object instanceof PDFInvalidObject && !live.has(ref.tag) && latin1(rawBytes(object)).includes('stream')) return;
  }
  for (const [ref] of objects) {
    if (!live.has(ref.tag)) context.delete(ref);
  }
}

/** Links every embedded font, image, page and file, then deletes the objects
 *  the trailer does not reach. Each embedder is idempotent, so the flush a
 *  later `save()` runs assigns nothing new. A document with a form cache
 *  updates its field appearances before this call and saves with
 *  `updateFieldAppearances: false`: an appearance the save redraws leaves the
 *  stream it replaces in the context. */
export async function flushAndDropUnreachable(doc: PDFDocument): Promise<void> {
  await doc.flush();
  dropUnreachableObjects(doc);
}
