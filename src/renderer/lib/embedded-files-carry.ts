// Carries document-level embedded files (/Names /EmbeddedFiles) and the
// portfolio marker (/Collection) through the from-scratch rebuild in
// pdfx-build.ts.
//
// pdf-lib's copyPages copies page subtrees only — document-level catalog
// trees are LEFT BEHIND, so before this module any committed page edit (one
// rotation suffices) silently deleted every attachment the document carried,
// and would strip a portfolio to its cover sheet. This is the same loss class
// as the /AcroForm drop handled by acroform-carry.ts and is pinned by
// embedded-files-carry.test.ts plus the portfolio rotate-then-refresh test.
//
// /EmbeddedFiles and /Collection carry from the committed FILE'S OWN prior
// bytes only: inserting one page from another document must not import that
// document's attachment list. Document-level associated files (/AF, ISO
// 32000-2 14.13) are the union of every contributing source's arrays, the
// engine's rule for the same rebuild.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFObjectCopier, PDFRef } from 'pdf-lib';

const NAME_NAMES = PDFName.of('Names');
const NAME_EMBEDDED_FILES = PDFName.of('EmbeddedFiles');
const NAME_COLLECTION = PDFName.of('Collection');
const NAME_AF = PDFName.of('AF');

/** A loaded contributing source and the ONE copier its pages were copied
 * through: a filespec reached from both a page annotation and the catalog
 * copies once only through the same copier cache. */
export interface CarrySource {
  doc: PDFDocument;
  copier: PDFObjectCopier;
}

/**
 * Copy `/Names /EmbeddedFiles` (the whole name tree — filespecs and streams
 * ride the object graph) and `/Collection` from the owner's catalog into
 * `output`'s, and set `/AF` to the union of the owner's and donors'
 * catalog arrays. A source with none of them is a no-op, so a plain
 * document's rebuild stays byte-clean; a malformed entry carries nothing
 * rather than failing the commit.
 */
export function carryEmbeddedFiles(
  output: PDFDocument,
  own: CarrySource | undefined,
  donors: CarrySource[] = [],
): void {
  const associated: PDFObject[] = [];
  const have = new Set<string>();
  if (own) carryOwn(output, own, associated, have);
  for (const donor of donors) carryAssociated(output, donor.doc, donor.copier, associated, have);
  if (associated.length > 0) output.catalog.set(NAME_AF, output.context.obj(associated));
}

/** Append the source catalog's /AF filespecs (ISO 32000-2 14.13.2) through
 * `copier`. The copier's cache maps a filespec also listed in /EmbeddedFiles
 * to the object that tree already carried; an output filespec already listed
 * is not listed twice. Each filespec keeps its /AFRelationship. */
function carryAssociated(
  output: PDFDocument,
  source: PDFDocument,
  copier: PDFObjectCopier,
  associated: PDFObject[],
  have: Set<string>,
): void {
  let af: PDFArray | undefined;
  try {
    af = source.catalog.lookupMaybe(NAME_AF, PDFArray);
  } catch {
    return;
  }
  if (!af) return;
  for (const raw of af.asArray()) {
    if (raw instanceof PDFRef) {
      if (!(source.context.lookup(raw) instanceof PDFDict)) continue;
      const copied = copier.copy(raw);
      if (have.has(copied.tag)) continue;
      have.add(copied.tag);
      associated.push(copied);
    } else if (raw instanceof PDFDict) {
      associated.push(output.context.register(copier.copy(raw)));
    }
  }
}

function carryOwn(output: PDFDocument, { doc: source, copier }: CarrySource, associated: PDFObject[], have: Set<string>): void {
  let embedded: PDFDict | undefined;
  let collection: PDFDict | undefined;
  try {
    const names = source.catalog.lookupMaybe(NAME_NAMES, PDFDict);
    embedded = names?.lookupMaybe(NAME_EMBEDDED_FILES, PDFDict);
    collection = source.catalog.lookupMaybe(NAME_COLLECTION, PDFDict);
  } catch {
    embedded = undefined;
    collection = undefined;
  }
  if (embedded) {
    const copied = copier.copy(embedded);
    let outNames = output.catalog.lookupMaybe(NAME_NAMES, PDFDict);
    if (!outNames) {
      outNames = output.context.obj({});
      output.catalog.set(NAME_NAMES, outNames);
    }
    outNames.set(NAME_EMBEDDED_FILES, output.context.register(copied));
  }
  if (collection) {
    output.catalog.set(
      NAME_COLLECTION,
      output.context.register(copier.copy(collection)),
    );
  }
  carryAssociated(output, source, copier, associated, have);
}
