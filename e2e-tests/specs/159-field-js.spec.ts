/**
 * Arbitrary field JavaScript, driven end to end through the real interpreter.
 *
 * `tests/field-js-real.test.ts` loads the same vendored sandbox in Node and
 * proves the object model computes. What only the built app can prove is the
 * part that Node cannot host: the module worker actually resolving
 * `pdfjs/wasm/quickjs-eval.js` out of the STAGED asset tree, the preference and
 * the machine policy deciding whether any of it runs, and the watchdog killing
 * a script that never returns — which needs a real thread, because the
 * interpreter's dispatch is a synchronous call with no interrupt.
 *
 * The fixtures are authored straight into the file rather than through this
 * app's writer: a `/AA` body and a `/Names /JavaScript` helper are things a
 * document ARRIVES carrying, and the preference boundary has to hold for one
 * this app never wrote.
 */
import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  closeAllFiles,
  invokeAppCommand,
  setCanvasFormValue,
  canvasFormShownValue,
  canvasFormScriptsNotRun,
  applyCanvasFormValues,
  saveActiveAs,
} from '../support/harness.js';

// ── the fixtures ──────────────────────────────────────────────────────────

/** The document-level helper every custom calculation in the wild calls into.
 * It returns a NUMBER, which is what the object model then stores — the shape
 * that decides whether the overlay can draw the result at all. */
const DOC_HELPER =
  'function LineTotal(q, p) {' +
  '  var a = this.getField(q).value, b = this.getField(p).value;' +
  '  if (a === "" || b === "") { return ""; }' +
  '  return Number(a) * Number(b);' +
  '}';

interface FieldSpec {
  name: string;
  actions: Record<string, string>;
}

/** Author a form whose fields carry raw `/AA` JavaScript, a `/CO` order, and a
 * document-level `/Names /JavaScript` helper. */
async function makeScriptedFixture(
  path: string,
  fields: FieldSpec[],
  calculationOrder: string[],
  documentJs: Record<string, string>,
): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const context = doc.context;

  let y = 340;
  for (const spec of fields) {
    const text = form.createTextField(spec.name);
    text.addToPage(page, { x: 50, y, width: 180, height: 22 });
    y -= 34;
    const entries = Object.entries(spec.actions);
    if (entries.length === 0) continue;
    const aa = PDFDict.withContext(context);
    for (const [trigger, js] of entries) {
      aa.set(
        PDFName.of(trigger),
        context.register(context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(js) })),
      );
    }
    text.acroField.dict.set(PDFName.of('AA'), aa);
  }

  const acroForm = form.acroForm.dict;
  if (calculationOrder.length > 0) {
    const co = PDFArray.withContext(context);
    for (const name of calculationOrder) {
      const field = form.getTextField(name);
      co.push(field.ref);
    }
    acroForm.set(PDFName.of('CO'), co);
  }

  const names = Object.entries(documentJs);
  if (names.length > 0) {
    const flat = PDFArray.withContext(context);
    for (const [name, js] of names) {
      flat.push(PDFString.of(name));
      flat.push(context.register(context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(js) })));
    }
    const tree = context.obj({ Names: flat });
    const catalog = doc.catalog as unknown as PDFDict;
    const existing = catalog.lookup(PDFName.of('Names'));
    if (existing instanceof PDFDict) existing.set(PDFName.of('JavaScript'), context.register(tree));
    else
      catalog.set(
        PDFName.of('Names'),
        context.register(context.obj({ JavaScript: context.register(tree) })),
      );
  }

  writeFileSync(path, await doc.save());
}

// ── the preference, through the control the user actually has ─────────────

const PREF = '[data-testid="pref-run-field-scripts"]';

async function openPreferences(): Promise<void> {
  expect(await invokeAppCommand('help.licenses')).toBe(true);
  await $(PREF).waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: 'the field-scripts preference is missing from Preferences',
  });
}

async function setFieldScriptPreference(on: boolean): Promise<void> {
  await openPreferences();
  const box = $(PREF);
  if ((await box.isSelected()) !== on) {
    await box.click();
    await browser.waitUntil(async () => (await box.isSelected()) === on, {
      timeout: 10_000,
      timeoutMsg: `the field-scripts preference did not become ${on}`,
    });
  }
  await $('[data-testid="prefs-close"]').click();
  await $(PREF).waitForDisplayed({ reverse: true, timeout: 10_000 });
}

async function present(selector: string): Promise<boolean> {
  return browser.execute((s: string) => Boolean(document.querySelector(s)), selector);
}

async function textOf(selector: string): Promise<string> {
  return browser.execute((s: string) => document.querySelector(s)?.textContent ?? '', selector);
}

// ── the spec ──────────────────────────────────────────────────────────────

describe('field JavaScript: off by default, real when switched on', () => {
  let tmp = '';
  let scripted = '';
  let runaway = '';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-fieldjs-'));
    scripted = resolve(tmp, 'scripted.pdf');
    runaway = resolve(tmp, 'runaway.pdf');

    await makeScriptedFixture(
      scripted,
      [
        { name: 'Qty', actions: {} },
        { name: 'Price', actions: {} },
        // A custom calculation that can only work if the document-level helper
        // was evaluated into the same scope first.
        { name: 'Total', actions: { C: 'event.value = LineTotal("Qty", "Price");' } },
        // Upper-casing, in both the per-character and the commit shape.
        {
          name: 'Name',
          actions: {
            K:
              'if (event.willCommit) { event.value = event.value.toUpperCase(); }' +
              ' else { event.change = event.change.toUpperCase(); }',
          },
        },
        // A format action, so the display string is the document's own.
        { name: 'Fee', actions: { F: 'event.value = "$" + event.value;' } },
      ],
      ['Total'],
      { 'zz-helpers': DOC_HELPER },
    );

    await makeScriptedFixture(
      runaway,
      [{ name: 'Spin', actions: { K: 'var i = 0; while (i >= 0) { i = i + 1; } event.value = i;' } }],
      [],
      {},
    );
  });

  after(async () => {
    await setFieldScriptPreference(false);
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  async function openScripted(): Promise<void> {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([scripted]);
    await setView('canvas');
    await setActiveOp('forms');
  }

  // ── (a) the default: nothing runs, and the panel reads as it always did ──

  describe('with the preference off, which is how it ships', () => {
    before(async () => {
      await waitForHarness();
      await setFieldScriptPreference(false);
      await openScripted();
    });

    it('lists the custom scripts as not run, naming the preference', async () => {
      await $('[data-testid="forms-scripts-not-run"]').waitForDisplayed({
        timeout: 20_000,
        timeoutMsg: 'the off-state script list never appeared',
      });
      // The refusal list is the F23 wording, unchanged, plus the one line that
      // says which switch decides.
      expect(await textOf('[data-testid="forms-scripts-switch"]')).not.toBe('');
      expect(await present('[data-testid="forms-scripts-running"]')).toBe(false);

      const notRun = await canvasFormScriptsNotRun(scripted);
      expect(notRun).toContain('Total');
      expect(notRun).toContain('Name');
    });

    it('computes nothing: a typed quantity leaves the total alone', async () => {
      expect(await setCanvasFormValue(scripted, 'Qty', '3')).toBe(true);
      expect(await setCanvasFormValue(scripted, 'Price', '2')).toBe(true);
      await browser.pause(2_000);
      expect(await canvasFormShownValue(scripted, 'Total')).toBe(null);
    });

    it('does not upper-case, because no script ran', async () => {
      expect(await setCanvasFormValue(scripted, 'Name', 'acme')).toBe(true);
      expect(await canvasFormShownValue(scripted, 'Name')).toBe('acme');
    });
  });

  // ── (b) switched on: the document's own scripts decide ──────────────────

  describe('with the preference on', () => {
    before(async () => {
      await setFieldScriptPreference(true);
      await openScripted();
    });

    it('runs the custom calculation through the document-level helper', async () => {
      expect(await setCanvasFormValue(scripted, 'Qty', '3')).toBe(true);
      expect(await setCanvasFormValue(scripted, 'Price', '2')).toBe(true);
      await browser.waitUntil(
        async () => (await canvasFormShownValue(scripted, 'Total')) === '6',
        {
          timeout: 30_000,
          timeoutMsg: 'the custom calculation never produced the total',
        },
      );
    });

    it('upper-cases through the keystroke action', async () => {
      expect(await setCanvasFormValue(scripted, 'Name', 'acme')).toBe(true);
      await browser.waitUntil(
        async () => (await canvasFormShownValue(scripted, 'Name')) === 'ACME',
        { timeout: 30_000, timeoutMsg: 'the keystroke action never upper-cased' },
      );
    });

    it('draws the format action’s own display string', async () => {
      expect(await setCanvasFormValue(scripted, 'Fee', '12')).toBe(true);
      await browser.waitUntil(
        async () => (await canvasFormShownValue(scripted, 'Fee')) === '$12',
        { timeout: 30_000, timeoutMsg: 'the format action never produced a display string' },
      );
    });

    it('reports a clean run rather than a refusal list', async () => {
      await $('[data-testid="forms-scripts-running"]').waitForDisplayed({
        timeout: 20_000,
        timeoutMsg: 'the on-state script list never appeared',
      });
      expect(await present('[data-testid="forms-scripts-not-run"]')).toBe(false);
      expect(await present('[data-testid="forms-scripts-all-clean"]')).toBe(true);
    });

    it('commits the TYPED values through Save, and only those', async () => {
      // Script results are DERIVED: they are drawn, never written into the
      // pending map, because the fill names what that map holds and a
      // calculated total is routinely read-only. So the saved bytes carry what
      // the user typed — this asserts the design, and pins it against a change
      // that would silently start writing computed values.
      await applyCanvasFormValues();
      const saved = resolve(tmp, 'saved.pdf');
      await saveActiveAs(saved);
      const doc = await PDFDocument.load(new Uint8Array(readFileSync(saved)));
      const form = doc.getForm();
      expect(form.getTextField('Qty').getText()).toBe('3');
      expect(form.getTextField('Price').getText()).toBe('2');
      expect(form.getTextField('Name').getText()).toBe('acme');
    });
  });

  // ── (c) a script that never returns ─────────────────────────────────────

  describe('a script that does not terminate', () => {
    before(async () => {
      await setFieldScriptPreference(true);
      await waitForHarness();
      await closeAllFiles();
      await openByPaths([runaway]);
      await setView('canvas');
      await setActiveOp('forms');
    });

    it('costs one worker, names the script, and leaves the app answering', async () => {
      expect(await setCanvasFormValue(runaway, 'Spin', 'go')).toBe(true);

      // The watchdog's deadline is 2s; give it room and then require the
      // report. The script is named by the field and trigger the dispatch
      // carried — the only thing known for certain about a worker that never
      // answered.
      await browser.waitUntil(
        async () => present('[data-testid="forms-script-note-Spin-K"]'),
        { timeout: 40_000, timeoutMsg: 'the runaway script was never reported' },
      );
      expect(await textOf('[data-testid="forms-script-note-Spin-K"]')).not.toBe('');

      // The render thread never blocked: the harness still answers, the
      // document is still open, and the panel is still drawing.
      const state = await getState();
      expect(state.activeFile?.path).toBe(runaway);
      expect(await present('[data-testid="forms-scripts-running"]')).toBe(true);
    });
  });

  // ── (d) the machine policy ──────────────────────────────────────────────

  describe('the enterprise policy control', () => {
    /**
     * The policy lives in `HKLM\SOFTWARE\Spectra PDF\DisableFieldScripts`,
     * which needs elevation to write and is machine-wide — a spec must not
     * change the machine it runs on. So what is asserted here is the CONTROL's
     * contract in both directions against whatever this machine actually
     * reports: when the policy decides, the switch is disabled and says so;
     * when it does not, the switch is live and the policy line is absent. The
     * resolution itself (`fieldScriptsEnabled`, `scriptSuppression`) is pinned
     * by `tests/field-js.test.ts` over both states.
     */
    it('says who is deciding, and never lies about what it controls', async () => {
      await openPreferences();
      const box = $(PREF);
      const disabled = !(await box.isEnabled());
      expect(await present('[data-testid="field-scripts-policy"]')).toBe(disabled);
      if (disabled) {
        // Policy decides: the wording is present and the preference cannot
        // grant what the machine has taken away.
        expect(await textOf('[data-testid="field-scripts-policy"]')).not.toBe('');
      }
      await $('[data-testid="prefs-close"]').click();
      await $(PREF).waitForDisplayed({ reverse: true, timeout: 10_000 });
    });
  });
});
