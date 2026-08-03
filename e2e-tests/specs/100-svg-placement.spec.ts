import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  editImagePageIds,
  editImagePlacements,
  editImageSelect,
  editImageTransformMany,
  editImageAdd,
  editImageAct,
} from '../support/harness.js';

// P7 slice F — SVG placed as REAL vector content against the built binary.
// The harness injects an {svg_path} source (the native picker is undrivable);
// the engine compiles it into a unit-square form, and the placement then
// rides the ENTIRE image machinery: listed kind "vector", group-movable
// beside a raster through the ONE multi op (slice B), deletable, undoable.
//
// Page ids regenerate on every whole-file commit — re-fetch after each.

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <rect width="100" height="50" fill="#3366cc"/>
  <circle cx="25" cy="25" r="15" fill="gold"/>
</svg>`;

function matrixClose(a: number[] | undefined, b: number[], eps = 0.5): boolean {
  return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

async function placements(): Promise<
  { index: number; matrix: number[]; kind: string }[]
> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return [];
  return editImagePlacements(ids[0]);
}

describe('SVG vector placement (P7)', () => {
  let tmp: string;
  let pdfPath: string;
  let svgPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-svg-'));
    pdfPath = resolve(tmp, 'with-image.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 40, y: 60, width: 100, height: 80 });
    writeFileSync(pdfPath, await doc.save());
    svgPath = resolve(tmp, 'logo.svg');
    writeFileSync(svgPath, LOGO_SVG);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('places an SVG (kind vector), group-moves it with a raster, deletes, undoes', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('with-image.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });

    // PLACE: contain-fit into a 200x200 band → the 2:1 graphic lands
    // 200x100 centered → cm [200,0,0,100,150,150] at band [150,100,350,300].
    await editImageAdd(1, [150, 100, 350, 300], { svg_path: svgPath });
    await browser.waitUntil(
      async () => {
        const p = await placements();
        return (
          p.length === 2 &&
          p.some(
            (pl) => pl.kind === 'vector' && matrixClose(pl.matrix, [200, 0, 0, 100, 150, 150]),
          )
        );
      },
      { timeout: 30_000, timeoutMsg: 'the SVG never listed as a vector placement' },
    );

    // GROUP-MOVE raster + vector together via the ONE multi op (slice B).
    let pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 0);
    await editImageSelect(pageId, 1, true);
    await editImageTransformMany(pageId, [
      { index: 0, matrix: [100, 0, 0, 80, 60, 80] },
      { index: 1, matrix: [200, 0, 0, 100, 170, 170] },
    ]);
    await browser.waitUntil(
      async () => {
        const p = await placements();
        return (
          p.length === 2 &&
          matrixClose(p[0]?.matrix, [100, 0, 0, 80, 60, 80]) &&
          matrixClose(p[1]?.matrix, [200, 0, 0, 100, 170, 170]) &&
          p[1]?.kind === 'vector'
        );
      },
      { timeout: 30_000, timeoutMsg: 'the mixed group move never applied' },
    );

    // DELETE the vector; ONE undo brings it back as kind vector.
    pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 1);
    await editImageAct('delete');
    await browser.waitUntil(
      async () => {
        const p = await placements();
        return p.length === 1 && p[0]?.kind === 'xobject';
      },
      { timeout: 30_000, timeoutMsg: 'the vector delete never applied' },
    );
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const p = await placements();
        return p.length === 2 && p.some((pl) => pl.kind === 'vector');
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the vector placement' },
    );
  });
});
