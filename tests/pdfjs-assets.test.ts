// The staged pdf.js runtime assets.
//
// pdf.js 6 fetches its image decoders (jbig2.wasm for /JBIG2Decode AND
// /CCITTFaxDecode, openjpeg.wasm for /JPXDecode, qcms_bg.wasm for ICC colour
// spaces), its CMaps, its standard-14 font programs and the CMYK ICC profile
// from URLs the app supplies. When a file is absent the failure is SILENT —
// pdf.js warns inside the decoder and the page draws blank — so nothing about
// this staging is self-announcing. These pins are the announcement.
//
// The manifest is imported from the staging script itself, so a pdfjs-dist
// bump that renames or drops a file fails here and in `npm run build:renderer`
// for the same reason, rather than shipping a viewer that cannot draw three
// image filters.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// @ts-expect-error — plain ESM build tooling, no type declarations by design.
import { PDFJS_ASSET_SETS, checkAssetSet } from '../scripts/sync-pdfjs-assets.mjs';

interface AssetSet {
  dir: string;
  required: string[];
  minFiles: number;
}

const sets = PDFJS_ASSET_SETS as AssetSet[];
const root = fileURLToPath(new URL('../', import.meta.url));
const staged = join(root, 'public', 'pdfjs');
const upstream = join(root, 'node_modules', 'pdfjs-dist');

describe('pdf.js runtime assets', () => {
  it('names every module the three image filters ride on', () => {
    const wasm = sets.find((s) => s.dir === 'wasm');
    expect(wasm).toBeDefined();
    // jbig2.wasm is load-bearing TWICE over: pdf.js 6's CCITTFaxStream
    // delegates to JBig2CCITTFaxImage, so a missing jbig2.wasm blanks fax
    // scans as well as JBIG2 ones.
    expect(wasm!.required).toContain('jbig2.wasm');
    expect(wasm!.required).toContain('openjpeg.wasm');
    expect(wasm!.required).toContain('qcms_bg.wasm');
    // The pure-JS fallbacks pdf.js imports when instantiation fails — staging
    // a .wasm without its sibling leaves no decode path at all.
    expect(wasm!.required).toContain('jbig2_nowasm_fallback.js');
    expect(wasm!.required).toContain('openjpeg_nowasm_fallback.js');
  });

  it('the pinned pdfjs-dist still carries every file the manifest expects', () => {
    const problems = sets.flatMap((set) => checkAssetSet(set, upstream) as string[]);
    expect(problems).toEqual([]);
  });

  it('has been staged into public/pdfjs (npm run sync-pdfjs)', () => {
    expect(
      existsSync(staged),
      'public/pdfjs is missing — run `npm run sync-pdfjs` (postinstall and build:renderer both do).',
    ).toBe(true);

    for (const set of sets) {
      const problems = checkAssetSet(set, staged) as string[];
      expect(problems, `staged ${set.dir}/ is incomplete`).toEqual([]);
    }
  });

  it('stages non-empty files (a zero-byte wasm decodes nothing)', () => {
    for (const set of sets) {
      for (const file of set.required) {
        const path = join(staged, set.dir, file);
        expect(statSync(path).size, `${set.dir}/${file} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('ships the licence text beside every staged set', () => {
    // Redistribution: these files land in the installer, so each set's own
    // notice travels with it (THIRD-PARTY-LICENSES.md § Frontend / runtime
    // libraries points here).
    for (const set of sets) {
      const licences = readdirSync(join(staged, set.dir)).filter((f) => f.startsWith('LICENSE'));
      expect(licences.length, `${set.dir}/ carries no LICENSE text`).toBeGreaterThan(0);
    }
  });
});
