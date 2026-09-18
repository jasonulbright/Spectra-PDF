import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  answerNextSaveDialog,
  boxFit,
  getState,
  horizontalOverflow,
  invokeAppCommand,
  createPlacedField,
  openByPaths,
  placeNewField,
  pinStoreCertificates,
  placeSignature,
  rowMetrics,
  saveActiveAs,
  saveDialogPending,
  setActiveOp,
  setReactSelectValue,
  setToolDockWidth,
  setUiLanguage,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
  type RowMetrics,
} from '../support/harness.js';

// F29 — the FOURTH signer source: a certificate in the Windows store, signed
// through CNG with the private key never leaving the platform.
//
// The whole point of this source is that the app holds no secret, so the test
// cannot supply one either: the setup imports a throwaway self-signed
// certificate into the CURRENT USER's `MY` store through `certutil` — the same
// door an administrator would use, no elevation needed for one's own store —
// and the teardown removes it. That is `tests/win_store.py`'s approach, driven
// from here so the e2e run needs no pytest process beside it.
//
// The signing itself is the SHIPPED path end to end: the real picker reads the
// real store through the Rust enumeration, the real panel handler assembles the
// real request, and the engine's own self-verify reports on the produced file.
// Nothing about the CNG call is stubbed, which is the only way "the key stayed
// in the platform" can be a finding rather than a claim.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const REPO_ROOT = resolve(__dirname, '..', '..');
const VENV_PYTHON = resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
const CERTUTIL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'certutil.exe');

const SOURCE_STORE = '[data-testid="sign-source-input-store"]';
const SOURCE_PFX = '[data-testid="sign-source-input-pfx"]';
const STORE_SELECT = '[data-testid="sign-store-cert"]';
const STORE_REFRESH = '[data-testid="sign-store-refresh"]';
const SIGN_FORM = '[data-testid="sign-form"]';
const CANVAS_FORM = '[data-testid="sign-canvas-form"]';
const DOCK_BODY = '.tool-dock-body';

/** Every source the picker offers, in the order it renders them. The installed
 * Windows certificates come FIRST: they are the primary path. */
const SOURCES = ['store', 'pfx', 'pem', 'pkcs11', 'csc'] as const;

/** The dock clamps to this; a narrower request lands exactly on it. */
const DOCK_MIN_WIDTH = 300;

let SCRATCH = '';
let thumbprint: string | null = null;

/** Make a throwaway signing certificate and hand back its SHA-1 thumbprint —
 * the store's own spelling of an identity. Uses the repo venv's `cryptography`
 * through the test module that already knows how to build one. */
function makeTestCertificate(pfxPath: string, password: string): string | null {
  if (!existsSync(VENV_PYTHON) || !existsSync(CERTUTIL)) return null;
  try {
    const out = execFileSync(
      VENV_PYTHON,
      [
        '-c',
        // Loaded BY PATH, not by package name: the venv's own site-packages
        // carries an unrelated `tests` package that shadows the repo's.
        'import sys, importlib.util, os;' +
          'root = sys.argv[1];' +
          'sys.path.insert(0, os.path.join(root, "src"));' +
          'spec = importlib.util.spec_from_file_location(' +
          '"e2e_win_store", os.path.join(root, "tests", "win_store.py"));' +
          'mod = importlib.util.module_from_spec(spec);' +
          'spec.loader.exec_module(mod);' +
          'print(mod.make_pfx(sys.argv[2], sys.argv[3]))',
        REPO_ROOT,
        pfxPath,
        password,
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    return out.trim().split(/\r?\n/).pop() ?? null;
  } catch {
    return null;
  }
}

function importIntoUserStore(pfxPath: string, password: string): boolean {
  try {
    execFileSync(CERTUTIL, ['-user', '-f', '-p', password, '-importpfx', 'My', pfxPath, 'NoRoot'], {
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

function removeFromUserStore(tp: string): void {
  try {
    execFileSync(CERTUTIL, ['-user', '-delstore', 'My', tp], { encoding: 'utf-8' });
  } catch {
    // Already gone, or the store refused — nothing left to undo either way.
  }
}

interface CliStoreRow {
  thumbprint: string;
  subject: string;
  issuer: string;
  not_after: string;
  machine_store: boolean;
  hardware_backed: boolean;
}

/** The CLI writes engine progress lines before its JSON, so the document
 * starts at the first brace rather than at byte zero. */
function cliJson<T>(args: string[]): T {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`no JSON in \`${args.join(' ')}\` output: ${out}`);
  return JSON.parse(out.slice(start)) as T;
}

function cliStoreCerts(): CliStoreRow[] {
  return cliJson<{ certificates?: CliStoreRow[] }>(['sign', '--list-store-certs']).certificates ?? [];
}

/** Open the panel's sign form on a fresh document. Re-opened per test: the
 * form resets on a file change, so a shared open form would make each test
 * depend on the last one's exit state. */
async function openSignForm(): Promise<void> {
  await setView('operations');
  await setActiveOp('signatures');
  await waitForDisplayedSelector('[data-testid="sign-open"]', { timeout: 20_000 });
  if (!(await $(SIGN_FORM).isExisting())) {
    await $('[data-testid="sign-open"]').click();
  }
  await waitForDisplayedSelector(SIGN_FORM, { timeout: 10_000 });
}

async function chooseStoreSource(): Promise<void> {
  await $(SOURCE_STORE).click();
  await waitForDisplayedSelector(STORE_SELECT, { timeout: 20_000 });
  // The enumeration is a Rust round trip; the select is disabled until it
  // lands, and disabled-forever is the store-unavailable state, not a wait.
  await browser.waitUntil(async () => $(STORE_SELECT).isEnabled(), {
    timeout: 30_000,
    timeoutMsg: 'the store certificate picker never became usable',
  });
}

/**
 * Seat the signatures panel in the TOOL DOCK (not the full-page Tools tab) at
 * the dock's MINIMUM width, with the sign form open. That is the narrowest
 * real width this panel has.
 *
 * The width is waited on, not assumed: the dock animates its width, so a
 * measurement taken straight after the dispatch reads a frame part-way between
 * the old width and the new one.
 */
async function openDockSignForm(): Promise<void> {
  await setView('canvas');
  expect(await invokeAppCommand('tools.panel.signatures')).toBe(true);
  await waitForDisplayedSelector('[data-testid="tool-dock"]', { timeout: 20_000 });
  await setToolDockWidth(DOCK_MIN_WIDTH - 100);
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const dock = document.querySelector('[data-testid="tool-dock"]');
        return dock ? Math.round(dock.getBoundingClientRect().width) : -1;
      })) === DOCK_MIN_WIDTH,
    { timeout: 10_000, timeoutMsg: 'the dock never settled at its minimum width' },
  );
  await waitForDisplayedSelector('[data-testid="sign-open"]', { timeout: 20_000 });
  if (!(await $(SIGN_FORM).isExisting())) {
    await $('[data-testid="sign-open"]').click();
  }
  await waitForDisplayedSelector(SIGN_FORM, { timeout: 10_000 });
}

/** CLOSE the sign form and open it again, so the picker remounts and re-reads
 * the store. The open-time decision is per opening, and the pinned answer only
 * takes effect on the next read. */
async function reopenDockSignForm(): Promise<void> {
  await openDockSignForm();
  await $('[data-testid="sign-open"]').click();
  await browser.waitUntil(async () => !(await $(SIGN_FORM).isExisting()), {
    timeout: 10_000,
    timeoutMsg: 'the sign form never closed',
  });
  await $('[data-testid="sign-open"]').click();
  await waitForDisplayedSelector(SIGN_FORM, { timeout: 10_000 });
}

/**
 * A control is BOTH present and entirely inside its container along the inline
 * axis.
 *
 * The distinction is the whole point: the source controls once sat in an
 * `overflow-hidden` flex group that could neither wrap nor scroll, so two of
 * the five were painted nowhere — and a testid click still reached them,
 * because WebDriver scrolls a control into view before clicking it. Nothing
 * here scrolls first, and the box is compared against the panel rather than
 * against the clipping group.
 */
async function assertFullyVisible(selector: string, container: string): Promise<void> {
  await expect($(selector)).toBeDisplayed();
  const fit = await boxFit(selector, container);
  if (!fit.insideHorizontally) {
    throw new Error(
      `${selector} is clipped by ${container}: element ${JSON.stringify(fit.element)} `
        + `is not inside ${JSON.stringify(fit.container)}`,
    );
  }
}

/** A source row's label has to be READABLE, not merely contained. */
const MAX_LABEL_LINES = 2;
/** How much narrower than its container a full-width row may measure. Covers
 * the row's own border/rounding only. */
const ROW_WIDTH_SLACK = 8;

/**
 * A source row is laid out, not squeezed.
 *
 * Containment stopped being sufficient the moment the labels began to wrap: a
 * row squeezed into a narrow column stays inside its panel and grows TALLER
 * instead. Squeezing the group back into one `overflow-hidden` flex row put
 * these rows at 45–76px wide and 64px tall (four lines for `.pfx file`) with
 * containment still reporting true. So the row must span its container and
 * its label must fit in at most two lines.
 */
async function assertRowLaidOut(selector: string, container: string): Promise<RowMetrics> {
  await expect($(selector)).toBeDisplayed();
  const m = await rowMetrics(selector, container);
  const detail = `${selector} in ${container}: ${JSON.stringify(m)}`;
  if (!m.insideHorizontally) throw new Error(`clipped — ${detail}`);
  if (m.width < m.containerWidth - ROW_WIDTH_SLACK) {
    throw new Error(
      `squeezed: ${m.width}px wide in a ${m.containerWidth}px container — ${detail}`,
    );
  }
  if (m.lines > MAX_LABEL_LINES) {
    throw new Error(`label wrapped onto ${m.lines} lines — ${detail}`);
  }
  return m;
}

/** No content pokes out of a container on EITHER inline edge. */
async function assertNoHorizontalOverflow(container: string): Promise<void> {
  const o = await horizontalOverflow(container);
  if (o.scroll > 0 || o.left > 0 || o.right > 0) {
    throw new Error(`${container} overflows horizontally: ${JSON.stringify(o)}`);
  }
}

async function rememberedThumbprint(): Promise<string | null> {
  return browser.execute(
    () => localStorage.getItem('spectra-signer-store-cert'),
  ) as Promise<string | null>;
}

/** Which radio the keyboard is on right now. */
async function focusedSourceTestId(): Promise<string> {
  return browser.execute(() => {
    const el = document.activeElement;
    return el ? (el.getAttribute('data-testid') ?? '') : '';
  }) as Promise<string>;
}

describe('signing with a Windows certificate store certificate', function () {
  before(async function () {
    SCRATCH = mkdtempSync(join(tmpdir(), 'spectra-e2e-store-'));
    const pfx = join(SCRATCH, 'store-test.pfx');
    const tp = makeTestCertificate(pfx, 'storepw');
    if (tp && importIntoUserStore(pfx, 'storepw')) thumbprint = tp;

    await waitForHarness();
    await browser.execute(() => localStorage.removeItem('spectra-signer-store-cert'));
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
  });

  after(async () => {
    if (thumbprint) removeFromUserStore(thumbprint);
    await browser.execute(() => localStorage.removeItem('spectra-signer-store-cert'));
    await invokeAppCommand('tools.close').catch(() => undefined);
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  });

  /** Every case below needs the imported certificate to exist. A machine that
   * could not host it is named, not silently green. */
  function requireCertificate(ctx: Mocha.Context): boolean {
    if (thumbprint) return true;
    ctx.skip();
    return false;
  }

  it('offers the installed-certificate source, and choosing it prompts for nothing', async () => {
    await openSignForm();
    // Every source is offered on the panel surface.
    for (const mode of SOURCES) {
      await expect($(`[data-testid="sign-source-${mode}"]`)).toBeDisplayed();
    }
    await chooseStoreSource();
    // Selecting the source READS the store and renders rows. It never asks
    // Windows for a key handle, so no PIN or consent dialog can appear — the
    // hardware probe runs under the silent flag for exactly this reason. The
    // evidence a spec can hold: the picker settled, and the window is still
    // the app's own (an OS consent dialog would have taken it).
    expect(await $(STORE_SELECT).isEnabled()).toBe(true);
    expect(await browser.getWindowHandles()).toHaveLength(1);
  });

  it('opens on the installed-certificate source, with no source chosen for it', async () => {
    // The issue this closes: the store source shipped at every layer and the
    // picker rendered it, but nothing in the UI led to it. It is now the
    // source a freshly opened form already holds.
    await openSignForm();
    await waitForDisplayedSelector(STORE_SELECT, { timeout: 20_000 });
    expect(await $(`[data-testid="sign-source-input-store"]`).isSelected()).toBe(true);
    for (const mode of SOURCES.filter((m) => m !== 'store')) {
      expect(await $(`[data-testid="sign-source-input-${mode}"]`).isSelected()).toBe(false);
    }
  });

  it('names the no-eligible-certificate refusal instead of signing', async () => {
    await openSignForm();
    await chooseStoreSource();
    // Nothing selected — the source is chosen but no identity is.
    await setReactSelectValue(STORE_SELECT, '');
    const dest = join(SCRATCH, 'never-written.pdf');
    await answerNextSaveDialog(dest);
    await $('[data-testid="sign-apply"]').click();

    // The refusal lands BEFORE the save dialog: the armed answer is untaken
    // and nothing was written.
    await browser.waitUntil(
      async () => (await $(SIGN_FORM).getText()).includes('certificate'),
      { timeout: 15_000, timeoutMsg: 'the missing-certificate refusal never rendered' },
    );
    expect(await saveDialogPending()).toBe(true);
    expect(existsSync(dest)).toBe(false);
    // Consume the armed answer so it cannot leak into the next case.
    await answerNextSaveDialog(null);
  });

  it('signs invisibly through CNG and the engine self-verifies the file', async function () {
    if (!requireCertificate(this)) return;
    await openSignForm();
    await chooseStoreSource();
    await setReactSelectValue(STORE_SELECT, thumbprint!);

    const dest = join(SCRATCH, 'store-signed.pdf');
    await answerNextSaveDialog(dest);
    await $('[data-testid="sign-apply"]').click();

    await waitForDisplayedSelector('[data-testid="sign-result"]', { timeout: 90_000 });
    const reported = await $('[data-testid="sign-result"]').getText();
    expect(reported).toContain('Spectra Store Test Signer');
    expect(existsSync(dest)).toBe(true);

    // Independent verification through the CLI arm: valid and intact, and the
    // signature covers the whole document.
    const verified = cliJson<{
      signature_count: number;
      signatures: { valid: boolean; intact: boolean; covers_whole_document: boolean }[];
    }>(['verify-signatures', dest]);
    expect(verified.signature_count).toBe(1);
    expect(verified.signatures[0].valid).toBe(true);
    expect(verified.signatures[0].intact).toBe(true);
    expect(verified.signatures[0].covers_whole_document).toBe(true);
  });

  it('remembers the thumbprint and never signs with it unasked', async function () {
    if (!requireCertificate(this)) return;
    // The previous sign recorded it.
    expect(await rememberedThumbprint()).toBe(thumbprint);

    // ENTERING the source pre-selects it. The store is read when the mode is
    // entered and not on every keystroke above it, so the transition has to be
    // a real one — this leaves the store source and comes back, which is what
    // a user switching signers does.
    await openSignForm();
    await $(SOURCE_PFX).click();
    await waitForDisplayedSelector('[data-testid="sign-pfx-path"]', { timeout: 10_000 });
    await chooseStoreSource();
    await browser.waitUntil(
      async () => (await $(STORE_SELECT).getValue()) === thumbprint,
      { timeout: 20_000, timeoutMsg: 'the remembered certificate was not pre-selected' },
    );
    // Pre-selected is not signed with: nothing has been written and the form
    // is still waiting for the user's own click.
    await expect($('[data-testid="sign-apply"]')).toBeDisplayed();
  });

  it('drops the pre-selection when the remembered thumbprint is gone', async () => {
    // A certificate that expired or was removed must not sit selected: what
    // the form shows has to be something the store still offers.
    const remembered = await rememberedThumbprint();
    await openSignForm();
    await $(SOURCE_PFX).click();
    await $('[data-testid="sign-pfx-path"]').waitForDisplayed();
    try {
      await browser.execute(() =>
        localStorage.setItem('spectra-signer-store-cert', '0000000000000000000000000000000000000000'),
      );
      // Reopening an already-open file keeps its working session. Enter the
      // source for real: that is when remembered identity is resolved.
      await chooseStoreSource();
      expect(await $(STORE_SELECT).getValue()).toBe('');
    } finally {
      await browser.execute((tp: string | null) => {
        if (tp === null) localStorage.removeItem('spectra-signer-store-cert');
        else localStorage.setItem('spectra-signer-store-cert', tp);
      }, remembered);
    }
  });

  it('refreshing the store preserves the current selection', async function () {
    if (!requireCertificate(this)) return;
    await openSignForm();
    await chooseStoreSource();
    await setReactSelectValue(STORE_SELECT, thumbprint!);
    expect(await $(STORE_SELECT).getValue()).toBe(thumbprint);

    await $(STORE_REFRESH).click();
    await browser.waitUntil(async () => $(STORE_SELECT).isEnabled(), {
      timeout: 30_000,
      timeoutMsg: 'the refresh never completed',
    });
    // A re-read that silently cleared the choice would make the button a trap.
    expect(await $(STORE_SELECT).getValue()).toBe(thumbprint);
  });

  it('signs into an existing empty signature field', async function () {
    if (!requireCertificate(this)) return;
    // The field is authored through the app's own field-creation path (there
    // is no headless arm for it), then saved out — so this case is about the
    // STORE source reaching the existing-field placement, not about authoring.
    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');
    await placeNewField({ x: 0.1, y: 0.6, w: 0.4, h: 0.12 });
    await createPlacedField(
      { name: 'StoreField', type: 'signature' },
      { path: SAMPLE_PDF, widgetDelta: 1 },
    );
    const withField = join(SCRATCH, 'with-field.pdf');
    await saveActiveAs(withField);

    const dest = join(SCRATCH, 'store-field-signed.pdf');
    execFileSync(
      APP_EXE,
      ['sign', withField, '-o', dest, '--store-cert', thumbprint!, '--existing-field', 'StoreField'],
      { encoding: 'utf-8' },
    );
    const verified = cliJson<{
      signature_count: number;
      signatures: { field: string; valid: boolean }[];
    }>(['verify-signatures', dest]);
    expect(verified.signature_count).toBe(1);
    expect(verified.signatures[0].field).toBe('StoreField');
    expect(verified.signatures[0].valid).toBe(true);
  });

  it('leaves no store parameters behind when the source changes back to a file', async function () {
    if (!requireCertificate(this)) return;
    // store → pfx → store. The request is assembled from the CURRENT source,
    // so a `store_cert` surviving a switch would sign the wrong way silently.
    await openByPaths([SAMPLE_PDF]);
    await openSignForm();
    await chooseStoreSource();
    await setReactSelectValue(STORE_SELECT, thumbprint!);
    await $(SOURCE_PFX).click();
    await waitForDisplayedSelector('[data-testid="sign-pfx-path"]', { timeout: 10_000 });
    // The store controls are gone with the mode — there is no hidden carrier.
    expect(await $(STORE_SELECT).isExisting()).toBe(false);

    await $(SOURCE_STORE).click();
    await waitForDisplayedSelector(STORE_SELECT, { timeout: 20_000 });
    await browser.waitUntil(async () => $(STORE_SELECT).isEnabled(), { timeout: 30_000 });
    // Back in the store source the identity is the remembered one again —
    // resolved from the store's own rows, never carried through the pfx form.
    expect(await $(STORE_SELECT).getValue()).toBe(thumbprint);
  });

  it('the CLI enumerates the same certificate the picker offers', async function () {
    if (!requireCertificate(this)) return;
    // One enumeration authority (Rust `store_certs`), two consumers.
    const rows = cliStoreCerts();
    const match = rows.find((r) => r.thumbprint === thumbprint);
    expect(match).toBeDefined();
    expect(match!.subject).toContain('Spectra Store Test Signer');
    expect(match!.machine_store).toBe(false);
  });

  it('lays every source out inside the dock panel at its minimum width', async () => {
    // 300px is the narrowest the dock goes, which leaves this panel about
    // 250px of content. A single row of five source labels needs ~300px and
    // got ~70px, and the group it sat in could neither wrap nor scroll.
    await openDockSignForm();
    const panel = await boxFit(SIGN_FORM, DOCK_BODY);
    expect(panel.container.width).toBeLessThanOrEqual(DOCK_MIN_WIDTH);

    for (const mode of SOURCES) {
      const m = await assertRowLaidOut(`[data-testid="sign-source-${mode}"]`, SIGN_FORM);
      // Each row is the full content width of the panel, not a squeezed column.
      expect(m.width).toBeGreaterThan(200);
    }
    // The generator is a source too, and it was the one that survived the old
    // clipping only because it was a sibling of the clipped group.
    await assertFullyVisible('[data-testid="sign-generate-open"]', SIGN_FORM);
    // Nothing pokes out of either inline edge: not the panel, not the dock.
    await assertNoHorizontalOverflow(SIGN_FORM);
    await assertNoHorizontalOverflow(DOCK_BODY);
  });

  it('lays every source out inside the canvas sign card', async () => {
    // The narrower of the two surfaces: a 320px card with 12px padding, so
    // the source list has 296px and no user control over it at all.
    await setView('canvas');
    await placeSignature({ x: 0.1, y: 0.6, w: 0.4, h: 0.12 });
    await waitForDisplayedSelector(CANVAS_FORM, { timeout: 20_000 });
    try {
      for (const mode of SOURCES) {
        const m = await assertRowLaidOut(`[data-testid="canvas-sign-source-${mode}"]`, CANVAS_FORM);
        expect(m.width).toBeGreaterThan(200);
      }
      await assertFullyVisible('[data-testid="canvas-sign-generate-open"]', CANVAS_FORM);
      await assertNoHorizontalOverflow(CANVAS_FORM);
    } finally {
      await $('[data-testid="canvas-sign-cancel"]').click();
    }
  });

  it('fits the picker and the action row in the longest shipped locales', async () => {
    // The labels are longest in these: `sourceAdvanced` and `modeStore` in el,
    // `modePem` in de, `modeStoreHint` in pl, `modeToken` and `create` in ca,
    // `modeCsc` in hu, `label` in fi, `storeRefresh` in ro. The panel's action
    // row lost 7px of Cancel off the inline-start edge in el and 6px in de,
    // where a scroll container clips and cannot scroll back.
    const locales = ['el', 'de', 'pl', 'ca', 'hu', 'fi', 'ro'];
    try {
      for (const locale of locales) {
        await setUiLanguage(locale);
        await openDockSignForm();
        for (const mode of SOURCES) {
          await assertRowLaidOut(`[data-testid="sign-source-${mode}"]`, SIGN_FORM);
        }
        await assertFullyVisible('[data-testid="sign-cancel"]', SIGN_FORM);
        await assertFullyVisible('[data-testid="sign-in-place"]', SIGN_FORM);
        await assertFullyVisible('[data-testid="sign-apply"]', SIGN_FORM);
        await assertNoHorizontalOverflow(SIGN_FORM);
        await assertNoHorizontalOverflow(DOCK_BODY);
      }
    } finally {
      await setUiLanguage('en');
    }
  });

  it('says why when the store holds no signer, and hands over a usable source', async () => {
    // The fallback and the reason are one act: the message is rendered on the
    // store ROW, not inside the store source's own fields, because a message
    // gated on the selection would unmount in the same commit that moved it.
    try {
      await pinStoreCertificates({ rows: [] });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-empty"]', { timeout: 20_000 });
      const said = await $('[data-testid="sign-store-empty"]').getText();
      expect(said).toContain('certificate');
      // Handed over: a usable source is selected, and the store's own fields
      // are gone with it.
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      expect(await $(STORE_SELECT).isExisting()).toBe(false);
      // The store row is still there to go back to, and the reason with it.
      await assertRowLaidOut('[data-testid="sign-source-store"]', SIGN_FORM);
      await assertFullyVisible('[data-testid="sign-store-empty"]', SIGN_FORM);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('names the store’s own refusal and keeps it on screen', async () => {
    try {
      await pinStoreCertificates({ error: 'the certificate store could not be opened (0x80090016)' });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-error"]', { timeout: 20_000 });
      expect(await $('[data-testid="sign-store-error"]').getText()).toContain('0x80090016');
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      // Still legible where it matters: the dock at its minimum width.
      await assertFullyVisible('[data-testid="sign-store-error"]', SIGN_FORM);
      await assertNoHorizontalOverflow(SIGN_FORM);
      // Going back to the store source sticks — the answer that moved the
      // selection fires once, not every time the source is re-entered.
      await $(SOURCE_STORE).click();
      await waitForDisplayedSelector(STORE_SELECT, { timeout: 10_000 });
      expect(await $(SOURCE_STORE).isSelected()).toBe(true);
      expect(await $('[data-testid="sign-store-error"]').isDisplayed()).toBe(true);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('offers the installed certificates again once the store recovers', async () => {
    // The fallback must not outlive the form that took it: the panel's source
    // state survives a close, so a recovered store would otherwise never be
    // offered again.
    try {
      await pinStoreCertificates({ rows: [] });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-empty"]', { timeout: 20_000 });
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      await pinStoreCertificates(null);
      await reopenDockSignForm();
      await waitForDisplayedSelector(STORE_SELECT, { timeout: 20_000 });
      expect(await $(SOURCE_STORE).isSelected()).toBe(true);
      expect(await $('[data-testid="sign-store-empty"]').isExisting()).toBe(false);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('reaches every source with the keyboard alone', async () => {
    await openDockSignForm();
    // Native radios grouped by name: the arrow keys walk the whole group in
    // document order and wrap, so there is no source the keyboard cannot
    // reach and nothing that traps focus inside one of the two groups.
    await $(SOURCE_STORE).click();
    const walked: string[] = [];
    for (let i = 0; i < SOURCES.length + 1; i += 1) {
      if (i > 0) await browser.keys(['ArrowDown']);
      walked.push(await focusedSourceTestId());
    }
    expect(walked).toEqual([
      ...SOURCES.map((m) => `sign-source-input-${m}`),
      'sign-source-input-store',
    ]);
    // Walking with the keyboard SELECTED as it went, and the last ArrowDown
    // wrapped back onto the store source, which is where the form began.
    expect(await $(SOURCE_STORE).isSelected()).toBe(true);
  });
});
