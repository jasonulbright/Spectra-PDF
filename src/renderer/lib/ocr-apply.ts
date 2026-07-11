// Conversion of OCR word boxes into the engine's `apply_ocr_layer` payload.
// Same contract as buildRedactionRegions/buildSignatureAppearance: word boxes
// are display-normalized at the page's BAKED orientation (the OCR rasterizer
// renders source pages with /Rotate applied, never the in-memory delta), so
// displayRectToPdf(box, bakedRotate) yields user-space rects that stay valid
// no matter how /Rotate changes later (rotation never moves user space).
// Page numbers are committed-order workspace numbers — the engine gate
// flushes pending page edits before the engine reads the file, so they line
// up with what lands on disk. Design: 15-phase2m-ocr-find.md.
import { displayRectToPdf } from './pdfx-build';
import { workspacePageNumber } from './workspace-commit';
import type { PageGeometry } from './redaction';
import type { OcrWord } from '../ocr/types';
import type { OpenDocument, PageRef } from '../state/types';

export interface OcrApplyWord {
  text: string;
  rect: [number, number, number, number];
}

export interface OcrApplyPage {
  page: number; // 1-based committed position within the file
  words: OcrApplyWord[];
}

export interface OcrApplyFilePayload {
  path: string;
  pages: OcrApplyPage[];
}

/** Resolve OCR-ready source pages against the current workspace into one
 * engine payload per file. A source page shown multiple times (duplicated
 * PageRefs) is applied once per committed position it occupies. Sources
 * whose page no longer exists in the workspace are skipped and reported. */
export async function buildOcrApplyPayload(
  docs: OpenDocument[],
  sourceKeys: string[],
  getWords: (sourceKey: string) => OcrWord[] | undefined,
  getGeometry: (page: PageRef, path: string) => Promise<PageGeometry>,
): Promise<{ files: OcrApplyFilePayload[]; skippedSources: string[] }> {
  const byPath = new Map<string, Map<number, OcrApplyPage>>();
  const skippedSources: string[] = [];

  for (const key of sourceKeys) {
    const sep = key.lastIndexOf(':');
    const path = key.slice(0, sep);
    const sourcePageIndex = Number(key.slice(sep + 1));
    const words = getWords(key);
    if (!words || words.length === 0) {
      skippedSources.push(key);
      continue;
    }

    // Every PageRef currently showing this source page.
    const holders: { doc: OpenDocument; page: PageRef }[] = [];
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (page.sourceDocId === path && page.sourcePageIndex === sourcePageIndex) {
          holders.push({ doc, page });
        }
      }
    }
    if (holders.length === 0) {
      skippedSources.push(key);
      continue;
    }

    const geometry = await getGeometry(holders[0].page, path);
    const converted: OcrApplyWord[] = words
      .filter((w) => w.text.trim().length > 0)
      .map((w) => ({
        text: w.text,
        rect: displayRectToPdf(w, geometry.box, geometry.bakedRotate),
      }));
    if (converted.length === 0) {
      skippedSources.push(key);
      continue;
    }

    let filePages = byPath.get(path);
    if (!filePages) byPath.set(path, (filePages = new Map()));
    for (const holder of holders) {
      const pageNumber = workspacePageNumber(docs, holder.doc, holder.page.id);
      if (pageNumber == null || filePages.has(pageNumber)) continue;
      filePages.set(pageNumber, { page: pageNumber, words: converted });
    }
  }

  const files: OcrApplyFilePayload[] = [];
  for (const [path, pagesMap] of byPath) {
    const pages = [...pagesMap.values()].sort((a, b) => a.page - b.page);
    if (pages.length > 0) files.push({ path, pages });
  }
  return { files, skippedSources };
}
