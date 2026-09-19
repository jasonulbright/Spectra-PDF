import type { OpenDocument, OpenFile, PdfBuffer } from '../../src/renderer/state/types';
import type { ReadPublishedBytes } from '../../src/renderer/lib/workspace-settle';

let readings = 0;

/** What a reading of `buffer` places for `file`: one document of `pageCount`
 * pages, under ids no earlier reading minted. */
export function documentsRead(file: OpenFile, buffer: PdfBuffer, pageCount: number): OpenDocument[] {
  const reading = ++readings;
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    id: `${file.path}#r${reading}#p${i}`,
    sourceDocId: file.path,
    sourcePageIndex: i,
    rotation: 0 as const,
    width: 1,
    height: 1,
  }));
  return [{ ...file, buffer, pageCount, id: `${file.path}#r${reading}#0`, pages }];
}

/** A publication reader that counts pages with `count`. A count that is no
 * page count places no documents. */
export function readingWith(count: (bytes: Uint8Array) => Promise<number>): ReadPublishedBytes {
  return async (file, buffer) => {
    const pageCount = await count(buffer as Uint8Array);
    return {
      pageCount,
      documents: Number.isSafeInteger(pageCount) && pageCount > 0 ? documentsRead(file, buffer, pageCount) : [],
    };
  };
}
