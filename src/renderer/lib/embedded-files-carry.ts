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
// Carried from the committed FILE'S OWN prior bytes only — never from the
// other contributing sources: embedded files are document-level property,
// and inserting one page from another document must not import that
// document's attachments.
import { PDFDict, PDFDocument, PDFName, PDFObjectCopier } from 'pdf-lib';

const NAME_NAMES = PDFName.of('Names');
const NAME_EMBEDDED_FILES = PDFName.of('EmbeddedFiles');
const NAME_COLLECTION = PDFName.of('Collection');

/**
 * Copy `/Names /EmbeddedFiles` (the whole name tree — filespecs and streams
 * ride the object graph) and `/Collection` from `ownBytes`' catalog into
 * `output`'s. A source with neither is a no-op, so a plain document's
 * rebuild stays byte-clean; unreadable prior bytes carry nothing rather
 * than failing the commit.
 */
export async function carryEmbeddedFiles(
  output: PDFDocument,
  ownBytes: Uint8Array,
): Promise<void> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(ownBytes, { ignoreEncryption: true });
  } catch {
    return;
  }
  let embedded: PDFDict | undefined;
  let collection: PDFDict | undefined;
  try {
    const names = source.catalog.lookupMaybe(NAME_NAMES, PDFDict);
    embedded = names?.lookupMaybe(NAME_EMBEDDED_FILES, PDFDict);
    collection = source.catalog.lookupMaybe(NAME_COLLECTION, PDFDict);
  } catch {
    return; // a malformed catalog entry carries nothing, never fails a commit
  }
  if (!embedded && !collection) return;

  const copier = PDFObjectCopier.for(source.context, output.context);
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
}
