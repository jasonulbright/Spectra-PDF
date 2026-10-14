import { importPage } from '../../src/renderer/lib/annotation-import';
import { readRawAnnotationStyles } from '../../src/renderer/lib/annotation-raw-style';
import { planCommit, buildCommitBytes } from '../../src/renderer/lib/workspace-commit';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef } from '../../src/renderer/state/types';
import type { BuildServices } from '../../src/renderer/lib/pdfx-build';
import { loadPdf } from './saved-pdf';
import { pythonTextEngine } from './text-engine';

/** Every page as the workspace index records it after an import. */
export async function importedPages(bytes: Uint8Array): Promise<PageRef[]> {
  const pdf = await loadPdf(bytes);
  const styles = await readRawAnnotationStyles(bytes);
  const pages: PageRef[] = [];
  for (let index = 0; index < pdf.numPages; index++) {
    const { annotations, untouchedSlots } = await importPage(await pdf.getPage(index + 1), styles?.[index]);
    pages.push({
      id: `a.pdf#p${index}`, sourceDocId: 'a.pdf', sourcePageIndex: index, rotation: 0, width: 0, height: 0, annotations,
      ...(untouchedSlots.length ? { untouchedAnnotationSlots: untouchedSlots } : {}),
    });
  }
  await pdf.loadingTask.destroy();
  return pages;
}

/** One import + commit cycle; `edit` changes the pages the index recorded.
 *  A `name` that ends in .pdfx commits through the collection build. */
export async function commit(
  bytes: Uint8Array,
  edit: (pages: PageRef[]) => PageRef[] = (pages) => pages,
  name = 'a.pdf',
  services: BuildServices = { textBoxes: pythonTextEngine },
): Promise<Uint8Array> {
  const pages = edit(await importedPages(bytes));
  const file: OpenFile = {
    path: 'a.pdf', workingPath: 'a.pdf.working', name, pageCount: pages.length, buffer: bytes, dirty: false, undoStack: [], redoStack: [],
  };
  const doc: OpenDocument = { ...file, id: 'a.pdf#0', name: file.name, pages, pageCount: pages.length };
  const [plan] = planCommit({ documents: [doc] }, new Map([['a.pdf', file]]), ['a.pdf']);
  return buildCommitBytes(plan, services);
}

/** The page with each annotation `gone` selects deleted by the user. */
export function deleting(page: PageRef, gone: (a: PageAnnotation) => boolean): PageRef {
  const all = page.annotations ?? [];
  return {
    ...page,
    annotations: all.filter((a) => !gone(a)),
    removedImportedOriginals: all.filter(gone).map((a) => a.importedOriginal!),
  };
}
