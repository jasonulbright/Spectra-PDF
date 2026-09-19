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
import {
  STEP_CATALOG,
  gsBlocker,
  gsPathFor,
  gsRequiredSteps,
  planAction,
  planSteps,
  type GsNeed,
  type GsPlan,
  type GuidedAction,
  type GuidedStepOp,
} from '../src/renderer/lib/guided-actions';

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
    ]);
    for (const op of GS_ONLY_OPERATIONS) expect(OPERATIONS).toContain(op);
  });

  it('leaves every PARTIAL operation reachable', () => {
    // Each of these works on documents that need no interpreter: Compare's
    // text mode, Preflight's structural checks, the flattener's listing,
    // trap-preset authoring, vector form detection, and a crop or a scan
    // enhancement whose codestream this runtime can decode.
    for (const op of [
      'compare',
      'preflight',
      'flattener',
      'trappresets',
      'prepareform',
      'pagebox',
      'scanenhance',
    ]) {
      expect(GS_ONLY_OPERATIONS.has(op as (typeof OPERATIONS)[number])).toBe(false);
    }
  });
});

/** The engine's shared vectors (`engine/guided_actions.py::step_gs_need`). */
interface Vector {
  op: string;
  params: Record<string, unknown>;
  sources?: string[];
  asked?: string[];
  need: GsNeed;
}
const VECTORS = (
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/gs-need-vectors.json'), 'utf8')) as {
    vectors: Vector[];
  }
).vectors;

describe('the rules the dialogs keep answer the evaluator’s vectors', () => {
  // The export dialog and Create PDF decide a single request before any
  // engine call. Their rules answer the same vectors the engine's evaluator
  // and the command line answer, so the three cannot drift apart.
  const decided = (op: string) =>
    VECTORS.filter((v) => v.op === op && v.need !== 'undecided' && v.asked === undefined);

  it('the export formats', () => {
    const exported = [...decided('export_document'), ...decided('export_images')];
    expect(exported.length).toBeGreaterThan(0);
    for (const v of exported) {
      const format = String(v.params.fmt).toLowerCase() as (typeof EXPORT_FORMATS)[number];
      expect(EXPORT_FORMATS, format).toContain(format);
      expect(exportFormatNeedsGs(format), format).toBe(v.need === 'required');
    }
  });

  it('the Create PDF sources', () => {
    const created = decided('create_pdf');
    expect(created.length).toBeGreaterThan(0);
    for (const v of created) {
      const sources = v.sources ?? [];
      expect(postscriptSources(sources).length > 0, sources.join(', ')).toBe(v.need === 'required');
    }
  });
});

describe('guided actions take their Ghostscript need from the engine’s plan', () => {
  const action = (...steps: GuidedAction['steps']): GuidedAction => ({
    id: 'a1',
    name: 'test',
    steps,
  });
  const plan = (gs: GsNeed, ...steps: [GuidedStepOp, GsNeed][]): GsPlan => ({
    gs,
    steps: steps.map(([op, need]) => ({ op, gs: need })),
  });

  it('carries no Ghostscript demand of its own', () => {
    for (const def of STEP_CATALOG) {
      expect(Object.keys(def), def.op).not.toContain('needsGs');
      expect(Object.keys(def), def.op).not.toContain('optionalGs');
    }
    const lib = readFileSync(resolve(__dirname, '../src/renderer/lib/guided-actions.ts'), 'utf8');
    expect(lib).not.toContain('guided-step-catalog.json');
  });

  it('asks the engine for a plan of the steps over the picked folder', async () => {
    const sent: Record<string, unknown>[] = [];
    const answer = plan('optional', ['search_redact', 'optional']);
    const request = async (params: Record<string, unknown>) => {
      sent.push(params);
      return answer;
    };
    const redact = action({ op: 'search_redact', params: { query: 'x' } });
    expect(await planAction(request, redact, undefined, 'C:/in')).toBe(answer);
    expect(await planAction(request, redact)).toBe(answer);
    expect(sent).toEqual([
      { source: 'C:/in', dest: '', steps: planSteps(redact), plan: true },
      { source: '', dest: '', steps: planSteps(redact), plan: true },
    ]);
  });

  it('marks the values a run collects later, and sends the collected ones', () => {
    const slides = action({ op: 'export_document', params: { fmt: 'pptx' }, ask: ['fmt'] });
    expect(planSteps(slides)).toEqual([
      { op: 'export_document', params: expect.objectContaining({ fmt: 'pptx' }), ask: ['fmt'] },
    ]);
    const sent = planSteps(slides, { 0: { fmt: 'txt' } });
    expect(sent).toEqual([{ op: 'export_document', params: expect.objectContaining({ fmt: 'txt' }) }]);
    expect(sent[0]).not.toHaveProperty('ask');
  });

  it('refuses a run before its first step only when the plan requires Ghostscript', () => {
    const required = plan('required', ['optimize', 'never'], ['compress', 'required']);
    const blocked = gsBlocker(required, false);
    expect(blocked).not.toBeNull();
    expect(blocked).toContain('Ghostscript');
    expect(gsBlocker(required, true)).toBeNull();
    for (const need of ['optional', 'undecided', 'never'] as const) {
      expect(gsBlocker(plan(need, ['search_redact', need]), false), need).toBeNull();
    }
    // A plan not answered yet blocks nothing; the run asks again first.
    expect(gsBlocker(null, false)).toBeNull();
  });

  it('names each step that needs Ghostscript once, in order', () => {
    const twice = plan(
      'required',
      ['compress', 'required'],
      ['search_redact', 'optional'],
      ['grayscale', 'required'],
      ['compress', 'required'],
    );
    expect(gsRequiredSteps(twice)).toEqual(['compress', 'grayscale']);
    expect(gsBlocker(twice, false)).toContain('need Ghostscript');
    const once = plan('required', ['optimize', 'never'], ['compress', 'required']);
    expect(gsBlocker(once, false)).toContain('needs Ghostscript');
  });
});

describe('guided actions resolve Ghostscript per planned need', () => {
  const lookup = (configured: string) => {
    const asked: string[] = [];
    return {
      asked,
      require: async () => {
        asked.push('require');
        if (!configured) throw new Error('Ghostscript is required');
        return configured;
      },
      ifAvailable: async () => {
        asked.push('ifAvailable');
        return configured;
      },
    };
  };

  it('asks the refusing lookup for a required need', async () => {
    const absent = lookup('');
    await expect(gsPathFor('required', absent)).rejects.toThrow('Ghostscript');
    expect(absent.asked).toEqual(['require']);
    expect(await gsPathFor('required', lookup('C:/gs/bin/gswin64c.exe'))).toBe('C:/gs/bin/gswin64c.exe');
  });

  it('hands a need the content decides whatever is usable, and runs without one', async () => {
    for (const need of ['optional', 'undecided'] as const) {
      const absent = lookup('');
      expect(await gsPathFor(need, absent), need).toBe('');
      expect(absent.asked, need).toEqual(['ifAvailable']);
      expect(await gsPathFor(need, lookup('C:/gs/bin/gswin64c.exe')), need).toBe(
        'C:/gs/bin/gswin64c.exe',
      );
    }
  });

  it('asks nothing for work that never reaches Ghostscript', async () => {
    const absent = lookup('');
    expect(await gsPathFor('never', absent)).toBeUndefined();
    expect(absent.asked).toEqual([]);
  });
});

describe('scan enhancement: the content, not the panel', () => {
  const text = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('hands the panel’s calls what is usable and never gates the panel', () => {
    const panel = text('src/renderer/panels/ScanEnhancePanel.tsx');
    expect(panel).toContain('gsPathIfAvailable()');
    expect(panel).not.toContain('requireGsPath');
    expect(panel).not.toContain('gsBlocked');
  });

  it('keeps the scan dialog’s enhancement open and gates only recognition', () => {
    const dialog = text('src/renderer/components/ScanDialog.tsx');
    expect(dialog).not.toContain('requireGsPath');
    const checkbox = (testId: string) => {
      const at = dialog.indexOf(`data-testid="${testId}"`);
      expect(at, testId).toBeGreaterThan(-1);
      return dialog.slice(at, dialog.indexOf('/>', at));
    };
    expect(checkbox('scan-enhance')).not.toContain('gsOff');
    expect(checkbox('scan-ocr')).toContain('gsOff');
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
