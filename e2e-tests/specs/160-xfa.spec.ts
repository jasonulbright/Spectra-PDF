/**
 * F1a — static XFA forms, end to end through the shipped app.
 *
 * `tests/test_xfa.py` pins the engine over synthesized fixtures. What only the
 * built binary can prove is the part that crosses every boundary at once: the
 * bundled Python runtime classifying a real file, the Forms panel discharging
 * ISO 32000-2 Annex K's "shall clearly indicate", a value that exists ONLY in
 * the datasets packet reaching a control the user can read (F34), and a fill
 * landing in `/V` and the XML leaf together while the packets the fill must
 * not touch stay byte-identical.
 *
 * The fixtures are built by `fixtures/make-xfa-fixtures.py` — a wild-shaped
 * hybrid (line-broken tag style, a datasets tree flatter than the field names)
 * and the same document with `NeedsRendering` set, which is what
 * classification actually keys on.
 *
 * The bytes are read back by `support/xfa-packets.py` through the engine's own
 * packet accessor: the two `/XFA` spellings are what is being READ here, not
 * what is being tested, and no Node PDF library decodes them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  closeAllFiles,
  createPlacedField,
  getState,
  invokeAppCommand,
  openByPaths,
  placeNewField,
  saveActiveAs,
  setActiveOp,
  setReactInputValue,
  setView,
  waitForHarness,
} from '../support/harness.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const VENV_PYTHON = resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
const ORACLE = resolve(__dirname, '..', 'support', 'xfa-packets.py');
const STATIC_PDF = resolve(__dirname, '..', 'fixtures', 'xfa-static.pdf');
const DYNAMIC_PDF = resolve(__dirname, '..', 'fixtures', 'xfa-dynamic.pdf');

// XFA 3.3 ch. 2 "Field Names": a fully qualified name is a dot-separated SOM
// expression, each step carrying its occurrence index. These names carry both
// periods and brackets, which is exactly why they are used as-is here — a
// surface that mangles them is a surface that cannot address a real XFA field.
const NAME1 = 'topmostSubform[0].Page1[0].name1[0]';
const NAME2 = 'topmostSubform[0].Page1[0].name2[0]';
const INNER1 = 'topmostSubform[0].Page1[0].group1[0].inner1[0]';

interface PacketRead {
  packets: Record<string, string>;
  values: Record<string, string | null>;
  classification: string;
  has_xfa: boolean;
  needs_rendering: boolean;
}

function readPackets(path: string): PacketRead {
  const out = execFileSync(VENV_PYTHON, [ORACLE, path], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return JSON.parse(out) as PacketRead;
}

/** The datasets packet with the `name2` element cut out — everything the fill
 * was NOT asked to change. The design's claim is that a fill rewrites only the
 * named leaf's content region, so this remainder must survive a fill byte for
 * byte; a DOM round-trip would rewrite every line-broken tag in it. */
function outsideName2(datasets: string): { before: string; after: string } {
  const start = datasets.indexOf('<name2');
  const end = datasets.indexOf('<group1');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { before: datasets.slice(0, start), after: datasets.slice(end) };
}

function fieldSelector(name: string): string {
  return `[data-testid="form-field-${name}"]`;
}

async function present(selector: string): Promise<boolean> {
  return browser.execute((s: string) => Boolean(document.querySelector(s)), selector);
}

async function inputValue(selector: string): Promise<string | null> {
  return browser.execute((s: string) => {
    const el = document.querySelector(s) as HTMLInputElement | null;
    return el ? el.value : null;
  }, selector);
}

/**
 * One field row read off the panel by the field's own NAME rather than by a
 * test id.
 *
 * A non-editable row renders a disabled placeholder that carries no
 * `data-testid` — that is how the panel has always drawn a read-only field,
 * and it is what a dynamic XFA document's every row is. So the dynamic cases
 * address the row through the label the user actually reads.
 */
async function fieldRow(
  name: string,
): Promise<{ found: boolean; disabled: boolean; value: string } | null> {
  return browser.execute((n: string) => {
    const span = Array.from(document.querySelectorAll('span')).find(
      (s) => s.textContent === n,
    );
    if (!span) return null;
    const row = span.parentElement?.parentElement ?? null;
    const input = row?.querySelector('input, textarea, select') as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (!input) return null;
    return { found: true, disabled: input.disabled, value: input.value };
  }, name);
}

/** Open a document and land on the Forms panel with its fields listed. */
async function openOnFormsPanel(path: string): Promise<void> {
  await waitForHarness();
  await closeAllFiles();
  await openByPaths([path]);
  await setView('operations');
  await setActiveOp('forms');
  await browser.waitUntil(async () => (await fieldRow(NAME1)) !== null, {
    timeout: 30_000,
    timeoutMsg: `the forms panel never listed ${NAME1}`,
  });
}

describe('static XFA forms: indicated, back-filled, dual-written', () => {
  let tmp = '';
  let original: PacketRead;

  before(() => {
    expect(existsSync(STATIC_PDF)).toBe(true);
    expect(existsSync(DYNAMIC_PDF)).toBe(true);
    // The oracle is the engine's own reader; without the repo venv there is no
    // independent read of the bytes and the byte assertions would be vacuous.
    expect(existsSync(VENV_PYTHON)).toBe(true);
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-xfa-'));
    original = readPackets(STATIC_PDF);
    expect(original.classification).toBe('static');
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // ── (a) it opens, it says what it is, and it shows the XML's own value ───

  describe('a hybrid static document', () => {
    before(async () => {
      await openOnFormsPanel(STATIC_PDF);
    });

    it('opens as an ordinary document with its fields listed', async () => {
      const state = await getState();
      expect(state.activeFile?.path).toBe(STATIC_PDF);
      expect(await present(fieldSelector(NAME2))).toBe(true);
      expect(await present(fieldSelector(INNER1))).toBe(true);
    });

    it('states that this is a static XML form, never the dynamic wording', async () => {
      // Annex K: a processor that supports XFA forms shall clearly indicate to
      // the user that they are interacting with one. Two kinds, two sentences.
      await $('[data-testid="forms-xfa-static"]').waitForDisplayed({ timeout: 20_000 });
      expect(await present('[data-testid="forms-xfa-dynamic"]')).toBe(false);
    });

    it('names the calculations the template authors and this app does not run', async () => {
      // XFA calculations are FormCalc / XFA-scoped JavaScript against the XFA
      // object model. Not executed — and said so, because a value another
      // field computes from is stale rather than quietly wrong.
      expect(await present('[data-testid="forms-xfa-calculations"]')).toBe(true);
    });

    it('DISPLAYS a value that exists only in the datasets packet (F34)', async () => {
      // The field object carries no `/V` at all: reporting the field blank was
      // the silent wrong read this round fixes. Both the shallow-bound leaf
      // and the one under a data group are asserted, because they resolve
      // through different halves of the SOM walk.
      expect(original.values[NAME1]).toBe(null);
      expect(original.values[INNER1]).toBe(null);
      expect(original.packets.datasets).toContain('>Ada</name1');
      expect(original.packets.datasets).toContain('>Lovelace</inner1');

      expect(await inputValue(fieldSelector(NAME1))).toBe('Ada');
      expect(await inputValue(fieldSelector(INNER1))).toBe('Lovelace');
    });

    it('badges those values as coming from the XML data, and only those', async () => {
      expect(await present(`[data-testid="form-from-xfa-${NAME1}"]`)).toBe(true);
      expect(await present(`[data-testid="form-from-xfa-${INNER1}"]`)).toBe(true);
      // `name2` has no value anywhere; a badge on it would claim a provenance
      // for a blank.
      expect(await present(`[data-testid="form-from-xfa-${NAME2}"]`)).toBe(false);
    });
  });

  // ── (b) fill → save → reopen, and what the bytes carry ──────────────────

  describe('filling a field', () => {
    const FILLED = 'Byron';
    let dest = '';
    let saved: PacketRead;

    before(async () => {
      dest = resolve(tmp, 'filled.pdf');
      await openOnFormsPanel(STATIC_PDF);
      await setReactInputValue(fieldSelector(NAME2), FILLED);
      await $('[data-testid="forms-apply"]').click();
      await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
        timeout: 40_000,
        timeoutMsg: 'the XFA fill never marked the file dirty',
      });
      await saveActiveAs(dest);
      expect(existsSync(dest)).toBe(true);
      saved = readPackets(dest);
    });

    it('reopens with the value present', async () => {
      await openOnFormsPanel(dest);
      expect(await inputValue(fieldSelector(NAME2))).toBe(FILLED);
      // The back-filled neighbours are still there — a fill is not a rewrite
      // of the packet.
      expect(await inputValue(fieldSelector(NAME1))).toBe('Ada');
      expect(await inputValue(fieldSelector(INNER1))).toBe('Lovelace');
    });

    it('writes BOTH the field object’s /V and the datasets leaf', async () => {
      // Annex K: the XFA field values shall be consistent with the `/V`
      // entries of the corresponding field objects. Writing one without the
      // other is a document two readers disagree about.
      expect(saved.values[NAME2]).toBe(FILLED);
      expect(saved.packets.datasets).toContain(`>${FILLED}</name2`);
    });

    it('keeps /XFA — the packet is updated, never stripped', async () => {
      expect(saved.has_xfa).toBe(true);
      expect(saved.classification).toBe('static');
      expect(Object.keys(saved.packets).sort()).toEqual(
        Object.keys(original.packets).sort(),
      );
    });

    it('leaves every untouched datasets byte identical', async () => {
      const before = outsideName2(original.packets.datasets);
      const after = outsideName2(saved.packets.datasets);
      expect(after.before).toBe(before.before);
      expect(after.after).toBe(before.after);
    });

    it('leaves the packets it must never act on byte-identical', async () => {
      // `connectionSet` declares a binding to an external data service and is
      // never read (this app performs no network access); `xfdf` is annotation
      // data, not field values; the template is what the form IS.
      expect(saved.packets.connectionSet).toBe(original.packets.connectionSet);
      expect(saved.packets.xfdf).toBe(original.packets.xfdf);
      expect(saved.packets.template).toBe(original.packets.template);
    });
  });

  // ── (c) the dynamic form: shown, said, and not fillable ─────────────────

  describe('a dynamic XFA document', () => {
    before(async () => {
      await openOnFormsPanel(DYNAMIC_PDF);
    });

    it('says it is dynamic rather than static', async () => {
      await $('[data-testid="forms-xfa-dynamic"]').waitForDisplayed({ timeout: 20_000 });
      expect(await present('[data-testid="forms-xfa-static"]')).toBe(false);
    });

    it('does not back-fill: its state is not in the PDF field objects', async () => {
      // Attributing a datasets value to a field object here would describe a
      // document nothing renders — the same packet, deliberately read
      // differently.
      const read = readPackets(DYNAMIC_PDF);
      expect(read.needs_rendering).toBe(true);
      expect(read.packets.datasets).toContain('>Ada</name1');
      expect((await fieldRow(NAME1))?.value).toBe('');
      expect(await present(`[data-testid="form-from-xfa-${NAME1}"]`)).toBe(false);
    });

    it('renders every field non-editable', async () => {
      for (const name of [NAME1, NAME2, INNER1]) {
        const row = await fieldRow(name);
        expect(row).not.toBe(null);
        expect(row?.disabled).toBe(true);
      }
    });

    it('disables Fill: there is nothing the fill door would accept', async () => {
      const apply = $('[data-testid="forms-apply"]');
      await apply.waitForDisplayed({ timeout: 20_000 });
      expect(await apply.isEnabled()).toBe(false);
    });
  });

  // ── (d) field authoring refuses, by name, and changes nothing ───────────

  describe('the field-authoring tool on an XFA document', () => {
    it('refuses by name and leaves the packets intact', async () => {
      const bytesBefore = readFileSync(STATIC_PDF);

      await waitForHarness();
      await closeAllFiles();
      await openByPaths([STATIC_PDF]);
      await setView('canvas');
      expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);

      await placeNewField({ x: 0.1, y: 0.2, w: 0.4, h: 0.06 });
      let message = '';
      try {
        await createPlacedField({ name: 'AddedField', type: 'text' });
      } catch (err) {
        message = String(err);
      }
      // The named refusal — `refusal.field.xfa`, rendered. Adding a field goes
      // through pdf-lib, which deletes `/XFA` on both `getForm()` and
      // `save()`: the template, datasets, config and localeSet packets would
      // go with no notice, which is why this door is shut before any other
      // rule runs.
      expect(message).toContain('XML form (XFA)');
      expect(message).toContain('field creation is not available');

      // Nothing was written: the file on disk is the byte-identical original,
      // packets and all.
      expect(readFileSync(STATIC_PDF).equals(bytesBefore)).toBe(true);
      const after = readPackets(STATIC_PDF);
      expect(after.packets).toEqual(original.packets);

      // And the document is still the same form to the app.
      await setView('operations');
      await setActiveOp('forms');
      await $('[data-testid="forms-xfa-static"]').waitForDisplayed({ timeout: 20_000 });
      expect(await present(fieldSelector('AddedField'))).toBe(false);
    });
  });
});
