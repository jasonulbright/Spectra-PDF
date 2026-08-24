// Placing a personal signature onto a page, through the commit that already
// exists.
//
// F31 adds no new door: a drawn signature commits as an ordinary /Ink
// annotation (vector paths, the route a freehand drawing already takes), an
// imported one as an image /Stamp, and a typed one as a /Stamp whose
// appearance draws the name in an EMBEDDED subset of an app-bundled script
// face. What this file pins is that each of the three really lands that way —
// in particular that nothing rasterizes ink and nothing draws a typed
// signature in a substituted font.
//
// The typed leg needs the shipped faces. A clean checkout has no
// `resources/fonts` (it is assembled by scripts/sync-signature-fonts.ps1 and
// gitignored), so that leg is guarded ON THE FACE FILE, never on the
// directory — the release workflow's Verify job creates an empty
// `resources/fonts` stub, and an isdir check passes on a tree with no fonts
// in it at all.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';

const FONT_DIR = join(__dirname, '..', 'resources', 'fonts');
const FACE = join(FONT_DIR, 'GreatVibes-Regular.ttf');
const HAS_FACES = existsSync(FACE);

// The real registry, with only the Tauri-side byte read replaced: the face
// files are the shipped ones, read off the same tree the app reads at run
// time. Mocking the loader rather than `tauri-bridge` keeps the module's own
// id→file mapping under test.
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

const { buildPdf } = await import('../src/renderer/lib/pdfx-build');
type ExportAnnotation = import('../src/renderer/lib/pdfx-format').ExportAnnotation;

async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return doc.save();
}

async function commitWith(annotations: ExportAnnotation[]): Promise<PDFDocument> {
  const bytes = await blankPage();
  const out = await buildPdf([
    { bytes, sourceKey: 's', pageIndex: 0, annotations },
  ]);
  return PDFDocument.load(out);
}

function onlyAnnot(doc: PDFDocument): PDFDict {
  const annots = doc.getPage(0).node.get(PDFName.of('Annots')) as PDFArray;
  expect(annots.size()).toBe(1);
  return annots.lookup(0, PDFDict);
}

/** The normal appearance stream's decoded content. */
function apContent(doc: PDFDocument, annot: PDFDict): string {
  const ap = annot.lookup(PDFName.of('AP'), PDFDict);
  const n = ap.get(PDFName.of('N'));
  const stream = doc.context.lookup(n, PDFRawStream);
  return new TextDecoder().decode(stream.getContents());
}

describe('a DRAWN signature commits as vector ink', () => {
  it('lands as /Ink with one InkList path per pen lift and a stroked appearance', async () => {
    const strokes = [
      [0.2, 0.5, 0.3, 0.4, 0.4, 0.55],
      [0.45, 0.45, 0.55, 0.5],
    ];
    const doc = await commitWith([
      {
        kind: 'ink',
        x: 0.2, y: 0.4, w: 0.35, h: 0.15,
        color: '#14213d',
        note: 'My signature',
        strokes,
      },
    ]);
    const annot = onlyAnnot(doc);
    expect(annot.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Ink');
    const inkList = annot.lookup(PDFName.of('InkList'), PDFArray);
    expect(inkList.size()).toBe(2);
    const content = apContent(doc, annot);
    // Stroked path operators, and no image XObject anywhere — a signature
    // that rasterized would print at the raster's resolution.
    expect(content).toMatch(/\bS\b/);
    expect(content).toMatch(/\bm\b/);
    expect(content).not.toMatch(/\/Im0 Do/);
  });
});

describe('an IMPORTED signature commits as an image stamp', () => {
  it('draws the embedded raster with no box chrome', async () => {
    // A 1x1 opaque PNG.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const doc = await commitWith([
      {
        kind: 'stamp',
        x: 0.2, y: 0.4, w: 0.3, h: 0.1,
        color: '#14213d',
        note: 'Scanned',
        imageData: png,
      },
    ]);
    const annot = onlyAnnot(doc);
    expect(annot.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Stamp');
    const content = apContent(doc, annot);
    expect(content).toMatch(/\/Im0 Do/);
    // No filled background rect and no stroked border: the bordered-label
    // stamp look must not come back for a signature.
    expect(content).not.toMatch(/re f/);
    expect(content).not.toMatch(/re S/);
  });
});

describe.skipIf(!HAS_FACES)('a TYPED signature embeds its own face', () => {
  it('draws the name from an embedded subset, with no border and no fill', async () => {
    const doc = await commitWith([
      {
        kind: 'stamp',
        x: 0.2, y: 0.4, w: 0.35, h: 0.08,
        color: '#14213d',
        note: 'Ada Lovelace',
        signatureFont: 'greatvibes',
      },
    ]);
    const annot = onlyAnnot(doc);
    expect(annot.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Stamp');
    const content = apContent(doc, annot);
    expect(content).toMatch(/BT \/F0 /);
    expect(content).toMatch(/Tj ET$/);
    expect(content).not.toMatch(/re f/);
    expect(content).not.toMatch(/re S/);

    // The appearance's own font resource, walked to its embedded program: a
    // /FontFile2 is the proof the face travels with the document rather than
    // being resolved on the reader's machine.
    const ap = doc.context.lookup(
      annot.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')),
      PDFRawStream,
    );
    const font = ap.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('Font'), PDFDict)
      .lookup(PDFName.of('F0'), PDFDict);
    const descendants = font.lookup(PDFName.of('DescendantFonts'), PDFArray);
    const descriptor = descendants
      .lookup(0, PDFDict)
      .lookup(PDFName.of('FontDescriptor'), PDFDict);
    const program = doc.context.lookup(descriptor.get(PDFName.of('FontFile2')), PDFRawStream);
    expect(program.getContents().length).toBeGreaterThan(0);
    // Subset, not the whole face: the shipped Great Vibes is ~450 KB and a
    // dozen glyphs is a small fraction of it.
    expect(program.getContents().length).toBeLessThan(readFileSync(FACE).length / 2);
    // A subset tag, so the embedded program cannot be mistaken for the whole
    // face — and a FIXED one, because a random tag would put six different
    // bytes in the file on every commit of the same document.
    expect(
      font.lookup(PDFName.of('BaseFont'), PDFName).asString(),
    ).toBe('/GVIBES+GreatVibes-Regular');
    // /ToUnicode, so the name is still extractable text.
    expect(font.get(PDFName.of('ToUnicode'))).toBeDefined();
  });

  it('commits the same document to the same bytes twice', async () => {
    const annots: ExportAnnotation[] = [
      {
        kind: 'stamp',
        x: 0.2, y: 0.4, w: 0.35, h: 0.08,
        color: '#14213d',
        note: 'Ada Lovelace',
        signatureFont: 'greatvibes',
      },
    ];
    const bytes = await blankPage();
    const one = await buildPdf([{ bytes, sourceKey: 's', pageIndex: 0, annotations: annots }]);
    const two = await buildPdf([{ bytes, sourceKey: 's', pageIndex: 0, annotations: annots }]);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
  });

  it('refuses rather than substituting when the named face is not one we ship', async () => {
    await expect(
      commitWith([
        {
          kind: 'stamp',
          x: 0.2, y: 0.4, w: 0.3, h: 0.08,
          color: '#14213d',
          note: 'Ada Lovelace',
          signatureFont: 'segoe-script',
        },
      ]),
    ).rejects.toThrow(/unknown signature face/);
  });

  it('a page with no typed signature embeds no face at all', async () => {
    const doc = await commitWith([
      {
        kind: 'ink',
        x: 0.2, y: 0.4, w: 0.2, h: 0.1,
        color: '#14213d',
        strokes: [[0.2, 0.4, 0.4, 0.5]],
      },
    ]);
    const saved = new TextDecoder('latin1').decode(await doc.save());
    expect(saved).not.toMatch(/FontFile2/);
  });
});
