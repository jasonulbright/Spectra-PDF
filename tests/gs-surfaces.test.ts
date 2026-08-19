// What each Ghostscript-bearing surface DOES when there is no Ghostscript.
//
// The blast radius is 25 surfaces, and nine of them are PARTIAL: blanket
// disabling any of those would cut capability that needs no interpreter at
// all. These are the decisions that say which is which, in the leaf modules
// that hold them, so the answer is one function per question rather than one
// per component.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { gsCapability: vi.fn(), refreshGsCapability: vi.fn() },
  dialog: {},
}));

import {
  EXPORT_FORMATS,
  GS_EXPORT_FORMATS,
  availableExportFormats,
  exportFormatNeedsGs,
} from '../src/renderer/lib/export-targets';
import { classify, postscriptSources } from '../src/renderer/lib/create-pdf';
import { GS_ONLY_OPERATIONS } from '../src/renderer/commands/registry';
import { OPERATIONS } from '../src/renderer/commands/operations';
import { STEP_CATALOG, gsBlockedSteps, gsBlocker } from '../src/renderer/lib/guided-actions';
import type { GuidedAction } from '../src/renderer/lib/guided-actions';

describe('export: the format list, not the door', () => {
  it('gates the rendered formats and NOTHING else', () => {
    // Slides carry a picture of the page and every image format is a raster;
    // Word, Excel, HTML and text come out of LibreOffice and the text
    // extractor, which need no interpreter.
    expect([...GS_EXPORT_FORMATS].sort()).toEqual(['jpeg', 'png', 'pptx', 'tiff']);
    for (const f of ['docx', 'rtf', 'odt', 'html', 'xhtml', 'txt', 'xlsx'] as const) {
      expect(exportFormatNeedsGs(f)).toBe(false);
    }
  });

  it('offers a SHORTER list rather than refusing export', () => {
    const offered = availableExportFormats(EXPORT_FORMATS, false);
    expect(offered).toContain('docx');
    expect(offered).toContain('txt');
    expect(offered).not.toContain('pptx');
    expect(offered).not.toContain('png');
    expect(availableExportFormats(EXPORT_FORMATS, true)).toEqual([...EXPORT_FORMATS]);
  });
});

describe('create pdf: the source, not the dialog', () => {
  it('names the PostScript sources and no others', () => {
    const picked = ['a.ps', 'b.eps', 'c.png', 'd.docx', 'e.pdf'];
    expect(postscriptSources(picked)).toEqual(['a.ps', 'b.eps']);
    expect(postscriptSources(['c.png', 'e.pdf'])).toEqual([]);
    // The classification the refusal reads is the dialog's own.
    expect(classify('b.EPS')).toBe('postscript');
  });
});

describe('the chrome gate', () => {
  it('gates the operations that are Ghostscript ALL the way down', () => {
    expect([...GS_ONLY_OPERATIONS].sort()).toEqual([
      'compress',
      'convert_cmyk',
      'grayscale',
      'inkmanager',
      'outputpreview',
      'pdfa',
      'rebuild',
      'scanenhance',
    ]);
    for (const op of GS_ONLY_OPERATIONS) expect(OPERATIONS).toContain(op);
  });

  it('leaves every PARTIAL operation reachable', () => {
    // Each of these works on documents that need no interpreter: Compare's
    // text mode, Preflight's structural checks, the flattener's listing,
    // trap-preset authoring, vector form detection, and a crop whose
    // codestream this runtime can decode.
    for (const op of ['compare', 'preflight', 'flattener', 'trappresets', 'prepareform', 'pagebox']) {
      expect(GS_ONLY_OPERATIONS.has(op as (typeof OPERATIONS)[number])).toBe(false);
    }
  });
});

describe('guided actions refuse at PLAN time', () => {
  const action = (...ops: string[]): GuidedAction => ({
    id: 'a1',
    name: 'test',
    steps: ops.map((op) => ({ op, params: {} })),
  }) as unknown as GuidedAction;

  it('keeps the renderer roster at the engine registry’s eleven', () => {
    // The roster IS the test: a new gs-bearing step cannot ship without an
    // absent-state answer, and the two registries are at parity by count.
    const declared = STEP_CATALOG.filter((s) => s.needsGs).map((s) => s.op).sort();
    expect(declared).toEqual([
      'compress',
      'convert_pdfa',
      'create_pdf',
      'create_pdf_folders',
      'enhance_scan',
      'export_document',
      'export_images',
      'grayscale',
      'ocr_file',
      'preflight',
      'prepare_forms',
    ]);
  });

  it('names the blocked steps of a saved action, deduplicated and in order', () => {
    expect(gsBlockedSteps(action('optimize', 'compress', 'watermark', 'compress'))).toEqual([
      'compress',
    ]);
    expect(gsBlockedSteps(action('optimize', 'watermark', 'encrypt'))).toEqual([]);
  });

  it('refuses the whole action BEFORE its first step rewrites the document', () => {
    // A run that dies at step four has already rewritten the document three
    // times, so the answer is taken from the plan.
    const blocked = gsBlocker(action('optimize', 'compress', 'convert_pdfa'), false);
    expect(blocked).not.toBeNull();
    expect(blocked).toContain('Ghostscript');
    expect(gsBlocker(action('optimize', 'watermark'), false)).toBeNull();
    expect(gsBlocker(action('compress'), true)).toBeNull();
  });

  it('says "needs" of one step and "need" of several', () => {
    expect(gsBlocker(action('compress'), false)).toContain('needs Ghostscript');
    expect(gsBlocker(action('compress', 'grayscale'), false)).toContain('need Ghostscript');
  });
});

describe('the distribution never claims to carry Ghostscript', () => {
  const text = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('uses the translated user-installed explanation in Settings', () => {
    const panel = text('src/renderer/panels/SettingsPanel.tsx');
    expect(panel).toContain("tChrome('panel.settings.gsLicense')");
    expect(panel).not.toContain('panel.settings.licensesP1');
  });

  it('describes the package as an optional integration', () => {
    const pkg = JSON.parse(text('package.json')) as { description: string };
    expect(pkg.description).toContain('optional Ghostscript integration');
    expect(pkg.description).not.toContain('vendors upstream Ghostscript');
  });

  it('builds the scan fixture with the app-probed executable', () => {
    const spec = text('e2e-tests/specs/114-prepare-form-detect.spec.ts');
    expect(spec).toContain('await gsRestore()');
    expect(spec).not.toMatch(/resources.{0,20}ghostscript/i);
  });
});
