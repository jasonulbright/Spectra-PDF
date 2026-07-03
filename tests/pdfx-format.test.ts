import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// The legacy build runs in Node without a browser worker; the app itself uses
// the standard build via src/renderer/lib/pdfRenderer.ts.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  MANIFEST_NAME,
  PDFX_VERSION,
  buildPdf,
  buildPdfx,
  partitionPages,
  readManifest,
  stripExtension,
} from '../src/renderer/lib/pdfx-format';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js may transfer the underlying buffer to its worker — hand it a copy
  return (await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false })
    .promise) as PDFDocumentProxy;
}

type AttachmentMap = Record<string, { filename?: string; content: Uint8Array }> | null;

function stubPdf(attachments: AttachmentMap): PDFDocumentProxy {
  return { getAttachments: async () => attachments } as unknown as PDFDocumentProxy;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function makeSourcePdf(pageCount: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`${label} — page ${i + 1} of ${pageCount}`, { x: 24, y: 200, size: 14 });
  }
  return doc.save();
}

const asExportPages = (bytes: Uint8Array, sourceKey: string, count: number): ExportPage[] =>
  Array.from({ length: count }, (_, pageIndex) => ({ bytes, sourceKey, pageIndex }));

describe('stripExtension', () => {
  it('strips .pdf and .pdfx case-insensitively, leaves other names alone', () => {
    expect(stripExtension('report.pdf')).toBe('report');
    expect(stripExtension('bundle.PDFX')).toBe('bundle');
    expect(stripExtension('notes.txt')).toBe('notes.txt');
  });
});

describe('readManifest', () => {
  const validManifest = {
    pdfx: PDFX_VERSION,
    title: 'Sample',
    documents: [
      { name: 'Cover', pages: 3 },
      { name: 'Appendix', pages: 2 },
    ],
  };

  it('returns null when the PDF has no attachments', async () => {
    expect(await readManifest(stubPdf(null))).toBeNull();
  });

  it('returns null when no attachment is named like the manifest', async () => {
    const attachments = { 'other.json': { content: encode(JSON.stringify(validManifest)) } };
    expect(await readManifest(stubPdf(attachments))).toBeNull();
  });

  it('parses a valid manifest keyed by attachment name', async () => {
    const attachments = { [MANIFEST_NAME]: { content: encode(JSON.stringify(validManifest)) } };
    expect(await readManifest(stubPdf(attachments))).toEqual(validManifest);
  });

  it('parses a valid manifest matched via the filename field', async () => {
    const attachments = {
      arbitraryKey: { filename: MANIFEST_NAME, content: encode(JSON.stringify(validManifest)) },
    };
    expect(await readManifest(stubPdf(attachments))).toEqual(validManifest);
  });

  it('returns null for unparseable JSON', async () => {
    const attachments = { [MANIFEST_NAME]: { content: encode('{not json') } };
    expect(await readManifest(stubPdf(attachments))).toBeNull();
  });

  it('returns null when the documents field is missing or not an array', async () => {
    for (const bad of [{ pdfx: '1.0' }, { pdfx: '1.0', documents: 'nope' }]) {
      const attachments = { [MANIFEST_NAME]: { content: encode(JSON.stringify(bad)) } };
      expect(await readManifest(stubPdf(attachments))).toBeNull();
    }
  });

  it('returns null when a document entry is malformed', async () => {
    for (const docs of [
      [{ name: 'A', pages: 0 }],
      [{ name: 'A', pages: 1.5 }],
      [{ name: 42, pages: 1 }],
    ]) {
      const attachments = {
        [MANIFEST_NAME]: { content: encode(JSON.stringify({ pdfx: '1.0', documents: docs })) },
      };
      expect(await readManifest(stubPdf(attachments))).toBeNull();
    }
  });
});

describe('partitionPages', () => {
  it('falls back to a single partition covering all pages without a manifest', () => {
    expect(partitionPages(null, 3, 'fallback')).toEqual([
      { name: 'fallback', indices: [0, 1, 2] },
    ]);
  });

  it('yields an empty single partition for an empty document without a manifest', () => {
    expect(partitionPages(null, 0, 'fallback')).toEqual([{ name: 'fallback', indices: [] }]);
  });

  it('splits pages cumulatively per manifest entry', () => {
    const manifest = {
      pdfx: '1.0',
      documents: [
        { name: 'Cover', pages: 3 },
        { name: 'Appendix', pages: 2 },
      ],
    };
    expect(partitionPages(manifest, 5, 'x')).toEqual([
      { name: 'Cover', indices: [0, 1, 2] },
      { name: 'Appendix', indices: [3, 4] },
    ]);
  });

  it('truncates an entry that overshoots the actual page count', () => {
    const manifest = {
      pdfx: '1.0',
      documents: [
        { name: 'Cover', pages: 3 },
        { name: 'Appendix', pages: 5 },
      ],
    };
    expect(partitionPages(manifest, 5, 'x')).toEqual([
      { name: 'Cover', indices: [0, 1, 2] },
      { name: 'Appendix', indices: [3, 4] },
    ]);
  });

  it('drops entries once the pages are exhausted', () => {
    const manifest = {
      pdfx: '1.0',
      documents: [
        { name: 'Cover', pages: 5 },
        { name: 'Appendix', pages: 2 },
      ],
    };
    expect(partitionPages(manifest, 5, 'x')).toEqual([{ name: 'Cover', indices: [0, 1, 2, 3, 4] }]);
  });

  it('adds a trailing Untitled partition when the manifest undershoots', () => {
    const manifest = {
      pdfx: '1.0',
      documents: [
        { name: 'Cover', pages: 2 },
        { name: 'Appendix', pages: 1 },
      ],
    };
    expect(partitionPages(manifest, 5, 'x')).toEqual([
      { name: 'Cover', indices: [0, 1] },
      { name: 'Appendix', indices: [2] },
      { name: 'Untitled', indices: [3, 4] },
    ]);
  });
});

describe('buildPdf / buildPdfx round-trip', () => {
  it('buildPdf refuses to build a zero-page PDF', async () => {
    await expect(buildPdf([])).rejects.toThrow(/no pages/);
  });

  it('buildPdf assembles pages from multiple sources without a manifest', async () => {
    const cover = await makeSourcePdf(3, 'Cover');
    const appendix = await makeSourcePdf(2, 'Appendix');
    const bytes = await buildPdf([
      { bytes: cover, sourceKey: 'cover.pdf', pageIndex: 2 },
      { bytes: appendix, sourceKey: 'appendix.pdf', pageIndex: 0 },
      { bytes: cover, sourceKey: 'cover.pdf', pageIndex: 0 },
    ]);
    const pdf = await loadPdf(bytes);
    expect(pdf.numPages).toBe(3);
    expect(await readManifest(pdf)).toBeNull();
    await pdf.loadingTask.destroy();
  });

  it('buildPdfx attaches a manifest that readManifest/partitionPages recover', async () => {
    const cover = await makeSourcePdf(3, 'Cover');
    const appendix = await makeSourcePdf(2, 'Appendix');
    const bytes = await buildPdfx(
      [
        { name: 'Cover', pages: asExportPages(cover, 'cover.pdf', 3) },
        { name: 'Empty', pages: [] }, // skipped — contributes no pages or manifest entry
        { name: 'Appendix', pages: asExportPages(appendix, 'appendix.pdf', 2) },
      ],
      'Sample',
    );
    const pdf = await loadPdf(bytes);
    expect(pdf.numPages).toBe(5);
    const manifest = await readManifest(pdf);
    expect(manifest).toEqual({
      pdfx: PDFX_VERSION,
      title: 'Sample',
      documents: [
        { name: 'Cover', pages: 3 },
        { name: 'Appendix', pages: 2 },
      ],
    });
    expect(partitionPages(manifest, pdf.numPages, 'x')).toEqual([
      { name: 'Cover', indices: [0, 1, 2] },
      { name: 'Appendix', indices: [3, 4] },
    ]);
    await pdf.loadingTask.destroy();
  });
});

describe('sample.pdfx fixture', () => {
  it('parses into the expected two-document workspace partition', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/sample.pdfx', import.meta.url)));
    const pdf = await loadPdf(bytes);
    expect(pdf.numPages).toBe(5);
    const manifest = await readManifest(pdf);
    expect(manifest).toEqual({
      pdfx: PDFX_VERSION,
      title: 'Sample',
      documents: [
        { name: 'Cover', pages: 3 },
        { name: 'Appendix', pages: 2 },
      ],
    });
    expect(partitionPages(manifest, pdf.numPages, 'sample')).toEqual([
      { name: 'Cover', indices: [0, 1, 2] },
      { name: 'Appendix', indices: [3, 4] },
    ]);
    await pdf.loadingTask.destroy();
  });
});
