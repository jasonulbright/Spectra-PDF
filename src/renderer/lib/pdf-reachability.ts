import { PDFArray, PDFDict, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';

/** Walks everything `roots` reach through dictionary values, array entries
 *  and stream dictionaries. The walk is iterative and enters each reference
 *  and each container once. */
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
 */
export function dropUnreachableObjects(doc: PDFDocument): void {
  const context = doc.context;
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  const live = reachableTags(context, [Root, Info, Encrypt, ID]);
  for (const [ref] of context.enumerateIndirectObjects()) {
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
