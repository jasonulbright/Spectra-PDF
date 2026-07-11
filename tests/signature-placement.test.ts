import { describe, expect, it } from 'vitest';
import { buildSignatureAppearance } from '../src/renderer/lib/signature-placement';
import type { SignaturePlacement } from '../src/renderer/lib/signature-placement';
import { displayRectToPdf } from '../src/renderer/lib/pdfx-build';
import type { PageGeometry } from '../src/renderer/lib/redaction';
import type { OpenDocument, PageRef } from '../src/renderer/state/types';

function pageRef(path: string, index: number, rotation: 0 | 90 | 180 | 270 = 0): PageRef {
  return {
    id: `${path}#p${index}`,
    sourceDocId: path,
    sourcePageIndex: index,
    rotation,
    width: 612,
    height: 792,
  };
}

function makeDoc(id: string, path: string, pages: PageRef[]): OpenDocument {
  return {
    id,
    path,
    workingPath: `${path}.working`,
    name: id,
    pageCount: pages.length,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages,
  };
}

function placement(
  pageId: string,
  path: string,
  rect: { x: number; y: number; w: number; h: number },
  rotationAtDraw: 0 | 90 | 180 | 270 = 0,
): SignaturePlacement {
  return { id: 'sig-1', path, pageId, rect, rotationAtDraw };
}

const GEOMETRY: PageGeometry = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 };
const geometryOf = (g: PageGeometry) => async (): Promise<PageGeometry> => g;

describe('buildSignatureAppearance', () => {
  it('converts the drawn rect exactly like displayRectToPdf and attributes the page', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0), pageRef('C:/a.pdf', 1)]);
    const rect = { x: 0.1, y: 0.8, w: 0.4, h: 0.1 };
    const built = await buildSignatureAppearance(
      [doc],
      placement('C:/a.pdf#p1', 'C:/a.pdf', rect),
      geometryOf(GEOMETRY),
    );
    expect(built).not.toBeNull();
    expect(built!.path).toBe('C:/a.pdf');
    expect(built!.appearance.page).toBe(2); // 1-based within the file
    expect(built!.appearance.rect).toEqual(displayRectToPdf(rect, GEOMETRY.box, 0));
  });

  it('composes bakedRotate with rotationAtDraw (not the current rotation)', async () => {
    // Drawn while the page showed at +90 in-memory on a file baked at 0 —
    // conversion must use 0 + 90; a LATER rotation must not change it.
    const page = pageRef('C:/a.pdf', 0, 180); // current in-memory rotation differs
    const doc = makeDoc('d1', 'C:/a.pdf', [page]);
    const rect = { x: 0.2, y: 0.3, w: 0.25, h: 0.15 };
    const built = await buildSignatureAppearance(
      [doc],
      placement(page.id, 'C:/a.pdf', rect, 90),
      geometryOf(GEOMETRY),
    );
    expect(built!.appearance.rect).toEqual(displayRectToPdf(rect, GEOMETRY.box, 0 + 90));
  });

  it('composes a baked /Rotate from the file too', async () => {
    const page = pageRef('C:/a.pdf', 0);
    const doc = makeDoc('d1', 'C:/a.pdf', [page]);
    const geometry: PageGeometry = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 270 };
    const rect = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
    const built = await buildSignatureAppearance(
      [doc],
      placement(page.id, 'C:/a.pdf', rect, 90),
      geometryOf(geometry),
    );
    expect(built!.appearance.rect).toEqual(displayRectToPdf(rect, geometry.box, 270 + 90));
  });

  it('returns null when the placement page no longer exists', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0)]);
    const built = await buildSignatureAppearance(
      [doc],
      placement('C:/a.pdf#p9', 'C:/a.pdf', { x: 0, y: 0, w: 0.5, h: 0.5 }),
      geometryOf(GEOMETRY),
    );
    expect(built).toBeNull();
  });

  it('numbers the page within its FILE across a moved-page workspace', async () => {
    // Two docs from the same file (pdfx-style partition): the page's engine
    // number is its position in the committed file order, not the doc.
    const p0 = pageRef('C:/a.pdf', 0);
    const p1 = pageRef('C:/a.pdf', 1);
    const p2 = pageRef('C:/a.pdf', 2);
    const docA = makeDoc('d1', 'C:/a.pdf', [p0, p1]);
    const docB = makeDoc('d2', 'C:/a.pdf', [p2]);
    const built = await buildSignatureAppearance(
      [docA, docB],
      placement(p2.id, 'C:/a.pdf', { x: 0, y: 0, w: 0.5, h: 0.5 }),
      geometryOf(GEOMETRY),
    );
    expect(built!.appearance.page).toBe(3);
  });
});
