// The page-tier build flushes its embedders, deletes every object the trailer
// does not reach, then saves. Each test here removes an original in the same
// commit that adds an object the build embeds, and requires both outcomes:
// the removed content is gone, and the embedded object is in the file, resolves
// from the content stream that names it, and is drawn by pdf.js.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';

const FONT_DIR = join(__dirname, '..', 'resources', 'fonts');
// Guarded on the face file: an empty resources/fonts directory holds no face.
const HAS_FACES = existsSync(join(FONT_DIR, 'GreatVibes-Regular.ttf'));

vi.mock('../src/renderer/lib/signature-fonts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/lib/signature-fonts')>();
  return {
    ...real,
    loadSignatureFontBytes: async (id: string) => {
      const face = real.signatureFaceById(id);
      if (!face) throw new Error(`unknown signature face: ${id}`);
      return new Uint8Array(readFileSync(join(FONT_DIR, face.file)));
    },
  };
});

const { commit, deleting } = await import('./support/commit-cycle');
const { expectSound, held, loadPdf, shown } = await import('./support/saved-pdf');
const { readManifest } = await import('../src/renderer/lib/pdfx-format');

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** One page with a note the import reads. */
async function pageWithNote(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 600]);
  const note = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 370, 30, 390], F: 4 });
  note.set(PDFName.of('Contents'), PDFHexString.fromText('REMOVEDNOTE'));
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(note)]));
  return doc.save();
}

/** The note deleted and `added` placed, in one commit. */
const replacingNoteWith = (added: Omit<PageAnnotation, 'id'>) => ([page]: PageRef[]): PageRef[] => {
  const cleared = deleting(page, () => true);
  return [{ ...cleared, annotations: [{ id: 'added', ...added }] }];
};

/** The operators pdf.js emits for page 1 with its annotation appearances. */
async function drawnOperators(bytes: Uint8Array): Promise<Set<number>> {
  const pdf = await loadPdf(bytes);
  const list = await (await pdf.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  await pdf.loadingTask.destroy();
  return new Set(list.fnArray);
}

describe('an object the build adds stays in a commit that removes an original', () => {
  it('a text box keeps the font its appearance names', async () => {
    const once = await commit(await pageWithNote(), replacingNoteWith({
      kind: 'freetext', x: 0.2, y: 0.2, w: 0.4, h: 0.1, color: '#14213d', note: 'ADDEDTEXTBOX',
    }));
    const reading = await expectSound(once, ['REMOVEDNOTE']);
    expect(reading.used.fonts).toBeGreaterThan(0);
    expect((await shown(once)).map((a) => a.subtype)).toEqual(['FreeText']);
    expect((await drawnOperators(once)).has(pdfjs.OPS.showText)).toBe(true);
    const twice = await commit(once);
    expect((await expectSound(twice, ['REMOVEDNOTE'])).used.fonts).toBeGreaterThan(0);
    expect(await held(twice, ['ADDEDTEXTBOX'])).toEqual(['ADDEDTEXTBOX']);
  });

  it('an image stamp keeps its embedded image', async () => {
    const once = await commit(await pageWithNote(), replacingNoteWith({
      kind: 'stamp', x: 0.2, y: 0.4, w: 0.3, h: 0.1, color: '#14213d', note: 'Scanned', imageData: PNG_1X1,
    }));
    const reading = await expectSound(once, ['REMOVEDNOTE']);
    expect(reading.used.images).toBe(1);
    expect((await shown(once)).map((a) => a.subtype)).toEqual(['Stamp']);
    expect((await drawnOperators(once)).has(pdfjs.OPS.paintImageXObject)).toBe(true);
    await expectSound(await commit(once), ['REMOVEDNOTE']);
  });

  it.skipIf(!HAS_FACES)('a typed signature keeps its embedded font program', async () => {
    const once = await commit(await pageWithNote(), replacingNoteWith({
      kind: 'stamp', x: 0.2, y: 0.4, w: 0.35, h: 0.08, color: '#14213d', note: 'Ada Lovelace', signatureFont: 'greatvibes',
    }));
    const reading = await expectSound(once, ['REMOVEDNOTE']);
    expect(reading.used.embedded_fonts).toBe(1);
    expect((await drawnOperators(once)).has(pdfjs.OPS.showText)).toBe(true);
    await expectSound(await commit(once), ['REMOVEDNOTE']);
  });

  it('a collection keeps its manifest attachment and the stamp image', async () => {
    const once = await commit(await pageWithNote(), replacingNoteWith({
      kind: 'stamp', x: 0.2, y: 0.4, w: 0.3, h: 0.1, color: '#14213d', note: 'Scanned', imageData: PNG_1X1,
    }), 'a.pdfx');
    const reading = await expectSound(once, ['REMOVEDNOTE']);
    expect(reading.used.images).toBe(1);
    const manifestOf = async (bytes: Uint8Array) => {
      const pdf = await loadPdf(bytes);
      const manifest = await readManifest(pdf);
      await pdf.loadingTask.destroy();
      return manifest;
    };
    expect(await manifestOf(once)).toMatchObject({ documents: [{ pages: 1 }] });
    const twice = await commit(once, (pages) => pages, 'a.pdfx');
    await expectSound(twice, ['REMOVEDNOTE']);
    expect(await manifestOf(twice)).toMatchObject({ documents: [{ pages: 1 }] });
  });
});
