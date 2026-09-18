import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  answerNextSaveDialog,
  boxFit,
  controlVisibility,
  getState,
  horizontalOverflow,
  invokeAppCommand,
  createPlacedField,
  openByPaths,
  overlappingControls,
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
  type ControlVisibility,
  type RowMetrics,
} from '../support/harness.js';

// Signing with a certificate in the Windows store, through CNG, with the
// private key never leaving the platform — and the picker that offers it.
//
// This source holds no secret, so the test cannot supply one either: the setup
// imports a throwaway self-signed certificate into the CURRENT USER's `MY`
// store through `certutil` — the door an administrator would use, no elevation
// needed for one's own store — and the teardown removes it. That is
// `tests/win_store.py`'s approach, driven from here so the e2e run needs no
// pytest process beside it.
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
/** The width a fresh profile opens the dock at. */
const DOCK_DEFAULT_WIDTH = 400;

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
 * a given dock width.
 *
 * The width is waited on, not assumed: the dock animates its width, so a
 * measurement taken straight after the dispatch reads a frame part-way between
 * the old width and the new one.
 */
async function seatDockPanel(width: number): Promise<void> {
  await setView('canvas');
  expect(await invokeAppCommand('tools.panel.signatures')).toBe(true);
  await waitForDisplayedSelector('[data-testid="tool-dock"]', { timeout: 20_000 });
  // The reducer clamps, so asking for less than the minimum lands on it.
  await setToolDockWidth(width === DOCK_MIN_WIDTH ? width - 100 : width);
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const dock = document.querySelector('[data-testid="tool-dock"]');
        return dock ? Math.round(dock.getBoundingClientRect().width) : -1;
      })) === width,
    { timeout: 10_000, timeoutMsg: `the dock never settled at ${width}px` },
  );
  await waitForDisplayedSelector('[data-testid="sign-open"]', { timeout: 20_000 });
}

/** The sign form open in the dock at its MINIMUM width — the narrowest real
 * width this panel has. */
async function openDockSignForm(): Promise<void> {
  await seatDockPanel(DOCK_MIN_WIDTH);
  if (!(await $(SIGN_FORM).isExisting())) {
    await $('[data-testid="sign-open"]').click();
  }
  await waitForDisplayedSelector(SIGN_FORM, { timeout: 10_000 });
}

/** CLOSE the sign form and open it again, so the picker remounts and re-reads
 * the store. The open-time decision is per opening, and a pinned answer only
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
 * axis. Nothing here scrolls first: WebDriver scrolls a control into view
 * before clicking it, and `overflow: hidden` is still scrollable, so a clipped
 * control answers to a testid click and to `scrollIntoView` alike.
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
/** Share of a control's box that must survive every clipping ancestor. */
const MIN_VISIBLE_FRACTION = 0.99;

/**
 * A source row is laid out, not squeezed: it spans its container, and its
 * label fits in at most two lines. A squeezed row stays inside its container
 * and grows taller instead, so containment alone cannot see it.
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

/**
 * A control can actually be SEEN: its box survives every clipping ancestor on
 * both axes, the point at the centre of what survives is the control and not
 * something painted over it, it is drawn at all, and its text is neither
 * truncated, spilling out of its box, nor drawn in the colour behind it.
 *
 * A `<select>` shows a prefix of its chosen option by design, so its own text
 * width is not held against it.
 */
async function assertSeen(
  selector: string,
  scrollContainer: string | null,
  opts: { allowTruncatedText?: boolean } = {},
): Promise<ControlVisibility> {
  const v = await controlVisibility(selector, scrollContainer);
  const detail = `${selector}: ${JSON.stringify(v)}`;
  if (v.width <= 0 || v.height <= 0) throw new Error(`not drawn — ${detail}`);
  if (v.visibility !== 'visible' || v.opacity < 0.5) throw new Error(`not drawn — ${detail}`);
  if (v.visibleFraction < MIN_VISIBLE_FRACTION) throw new Error(`clipped — ${detail}`);
  if (!v.hitsItself) throw new Error(`covered — ${detail}`);
  if (v.textClipped && !opts.allowTruncatedText) throw new Error(`text truncated — ${detail}`);
  if (v.textOutsideBox) throw new Error(`text spills out of its box — ${detail}`);
  if (v.textInvisible) throw new Error(`text drawn invisibly — ${detail}`);
  return v;
}

/** One surface's picker: every source row, the store hint, the certificate
 * select when the store is chosen, and the generator. */
function pickerControls(prefix: 'sign' | 'canvas-sign', withStoreFields: boolean): string[] {
  const t = (id: string) => `[data-testid="${prefix}-${id}"]`;
  return [
    t('source-store'),
    t('source-store-hint'),
    ...(withStoreFields ? [t('store-cert')] : []),
    ...SOURCES.filter((m) => m !== 'store').map((m) => t(`source-${m}`)),
    t('generate-open'),
  ];
}

/**
 * The whole picker is laid out AND visible: every row full width and at most
 * two lines, every control seen, and no two controls overlapping.
 */
async function assertPickerShown(
  prefix: 'sign' | 'canvas-sign',
  container: string,
  scrollContainer: string,
): Promise<void> {
  // Measure the SETTLED picker: a store answer can still move the selection,
  // and with it which controls exist.
  await browser.waitUntil(
    async () => !(await $(`[data-testid="${prefix}-store-loading"]`).isExisting()),
    { timeout: 30_000, timeoutMsg: 'the store never answered' },
  );
  const withStoreFields = await $(`[data-testid="${prefix}-store-cert"]`).isExisting();
  for (const mode of SOURCES) {
    const m = await assertRowLaidOut(`[data-testid="${prefix}-source-${mode}"]`, container);
    expect(m.width).toBeGreaterThan(200);
  }
  await assertRowLaidOut(`[data-testid="${prefix}-source-store-hint"]`, container);
  const controls = pickerControls(prefix, withStoreFields);
  for (const sel of controls) {
    await assertSeen(sel, scrollContainer, {
      allowTruncatedText: sel.endsWith('-store-cert"]'),
    });
  }
  const overlaps = await overlappingControls(controls);
  if (overlaps.length > 0) throw new Error(`controls overlap: ${overlaps.join('; ')}`);
}

/** No content pokes out of a container on EITHER inline edge. */
async function assertNoHorizontalOverflow(container: string): Promise<void> {
  const o = await horizontalOverflow(container);
  if (o.scroll > 0 || o.left > 0 || o.right > 0) {
    throw new Error(`${container} overflows horizontally: ${JSON.stringify(o)}`);
  }
}

/** A catalog string exactly as a locale ships it, read from the catalog the
 * build embeds, so a translated message is asserted without restating it. */
function catalogString(locale: string, key: string, params: Record<string, string> = {}): string {
  const file = resolve(REPO_ROOT, 'src', 'renderer', 'locales', locale, 'chrome.json');
  const text = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)[key];
  if (text === undefined) throw new Error(`${locale} has no ${key}`);
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => params[name] ?? '');
}

async function describedByIds(selector: string): Promise<string[]> {
  const v = await $(selector).getAttribute('aria-describedby');
  return (v ?? '').split(/\s+/).filter(Boolean);
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
    // The store source is what a freshly opened form holds.
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

  it('shows every source inside the dock panel at its minimum width', async () => {
    await openDockSignForm();
    const panel = await boxFit(SIGN_FORM, DOCK_BODY);
    expect(panel.container.width).toBeLessThanOrEqual(DOCK_MIN_WIDTH);
    await assertPickerShown('sign', SIGN_FORM, DOCK_BODY);
    await assertFullyVisible('[data-testid="sign-generate-open"]', SIGN_FORM);
    await assertNoHorizontalOverflow(SIGN_FORM);
    await assertNoHorizontalOverflow(DOCK_BODY);
  });

  it('shows every source inside the canvas sign card', async () => {
    await setView('canvas');
    await placeSignature({ x: 0.1, y: 0.6, w: 0.4, h: 0.12 });
    await waitForDisplayedSelector(CANVAS_FORM, { timeout: 20_000 });
    try {
      await assertPickerShown('canvas-sign', CANVAS_FORM, CANVAS_FORM);
      await assertFullyVisible('[data-testid="canvas-sign-generate-open"]', CANVAS_FORM);
      await assertNoHorizontalOverflow(CANVAS_FORM);
    } finally {
      await $('[data-testid="canvas-sign-cancel"]').click();
    }
  });

  it('names the certificate picker and each source for assistive technology', async () => {
    await openDockSignForm();
    await waitForDisplayedSelector(STORE_SELECT, { timeout: 20_000 });
    expect(await $(STORE_SELECT).getComputedLabel()).toBe(catalogString('en', 'dialog.signer.storeCertificate'));
    // The hint is a description, not part of the name.
    expect(await $(SOURCE_STORE).getComputedLabel()).toBe(catalogString('en', 'dialog.signer.modeStore'));
    expect(await describedByIds(SOURCE_STORE)).toContain('sign-source-store-hint');
  });

  it('fits the picker and the action row in the longest shipped locales', async () => {
    // Each of these holds the longest translation of at least one string on
    // this surface; the store hint wraps to two lines in pl at the dock minimum.
    const locales = ['el', 'de', 'pl', 'ca', 'hu', 'fi', 'ro', 'nl'];
    try {
      for (const locale of locales) {
        await setUiLanguage(locale);
        await openDockSignForm();
        await assertPickerShown('sign', SIGN_FORM, DOCK_BODY);
        for (const id of ['sign-cancel', 'sign-in-place', 'sign-apply']) {
          await assertFullyVisible(`[data-testid="${id}"]`, SIGN_FORM);
          await assertSeen(`[data-testid="${id}"]`, DOCK_BODY);
        }
        await assertNoHorizontalOverflow(SIGN_FORM);
        await assertNoHorizontalOverflow(DOCK_BODY);
      }
    } finally {
      await setUiLanguage('en');
    }
  });

  it('says why when the store holds no signer, and hands over a usable source', async () => {
    try {
      await pinStoreCertificates({ rows: [] });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-empty"]', { timeout: 20_000 });
      expect(await $('[data-testid="sign-store-empty"]').getText()).toBe(
        catalogString('en', 'dialog.signer.storeNone'),
      );
      // Handed over: a usable source is selected, and the store's own fields
      // are gone with it.
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      expect(await $(STORE_SELECT).isExisting()).toBe(false);
      // The store row is still there to go back to, with the reason under it.
      await assertRowLaidOut('[data-testid="sign-source-store"]', SIGN_FORM);
      await assertSeen('[data-testid="sign-store-empty"]', DOCK_BODY);
      // Announced, and attached to both radios the move concerns.
      expect(await $('[data-testid="sign-store-verdict"]').getAttribute('role')).toBe('status');
      expect(await describedByIds(SOURCE_PFX)).toContain('sign-store-verdict');
      expect(await describedByIds(SOURCE_STORE)).toContain('sign-store-verdict');
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('moves the keyboard with the selection and leaves the reason on the radio it lands on', async () => {
    // Held back so focus can be on the store radio when the answer lands.
    try {
      await pinStoreCertificates({ rows: [], delayMs: 2_000 });
      await reopenDockSignForm();
      // Focus placed without operating the chooser: a pick makes the selection
      // the user's, and a user's selection is never moved.
      await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).focus(), SOURCE_STORE);
      expect(await focusedSourceTestId()).toBe('sign-source-input-store');
      await waitForDisplayedSelector('[data-testid="sign-store-empty"]', { timeout: 20_000 });
      expect(await focusedSourceTestId()).toBe('sign-source-input-pfx');
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      expect(await describedByIds(SOURCE_PFX)).toContain('sign-store-verdict');
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('names the store\u2019s refusal in the UI language and keeps it on screen', async () => {
    try {
      await pinStoreCertificates({
        error: { reason: 'open-failed', code: '0x80090016', message: 'The Windows certificate store could not be opened: x' },
      });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-error"]', { timeout: 20_000 });
      expect(await $('[data-testid="sign-store-error"]').getText()).toBe(
        catalogString('en', 'dialog.signer.storeErrorCode', { code: '0x80090016' }),
      );
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      await assertSeen('[data-testid="sign-store-error"]', DOCK_BODY);
      await assertNoHorizontalOverflow(SIGN_FORM);
      expect(await describedByIds(SOURCE_PFX)).toContain('sign-store-verdict');
      // Going back to the store source sticks: the answer that moved the
      // selection fires once, not every time the source is re-entered.
      await $(SOURCE_STORE).click();
      await waitForDisplayedSelector(STORE_SELECT, { timeout: 10_000 });
      expect(await $(SOURCE_STORE).isSelected()).toBe(true);
      expect(await $('[data-testid="sign-store-error"]').isDisplayed()).toBe(true);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('words a known store refusal from the catalog, never from the platform text', async () => {
    try {
      await setUiLanguage('de');
      await pinStoreCertificates({
        error: { reason: 'open-failed', code: '0x80070005', message: 'Access is denied.' },
      });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-error"]', { timeout: 20_000 });
      expect(await $('[data-testid="sign-store-error"]').getText()).toBe(
        catalogString('de', 'dialog.signer.storeErrorDenied'),
      );
    } finally {
      await pinStoreCertificates(null);
      await setUiLanguage('en');
    }
  });

  it('offers the installed certificates again once the store recovers', async function () {
    if (!requireCertificate(this)) return;
    // The panel's source state survives a close, so the fallback must be
    // re-decided on the next open or a recovered store is never offered again.
    try {
      await pinStoreCertificates({ rows: [] });
      await reopenDockSignForm();
      await waitForDisplayedSelector('[data-testid="sign-store-empty"]', { timeout: 20_000 });
      expect(await $(SOURCE_PFX).isSelected()).toBe(true);
      await pinStoreCertificates(null);
      await reopenDockSignForm();
      // Wait for the recovered store's ANSWER, not only for the select: the
      // select renders while the read is still in flight.
      await browser.waitUntil(
        async () =>
          (await $(STORE_SELECT).isEnabled())
          && (await $$(`${STORE_SELECT} option`).length) >= 2,
        { timeout: 30_000, timeoutMsg: 'the recovered store never answered' },
      );
      expect(await $(SOURCE_STORE).isSelected()).toBe(true);
      expect(await $('[data-testid="sign-store-empty"]').isExisting()).toBe(false);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('shows the certificate a reopened form will sign with while the store is still read', async function () {
    if (!requireCertificate(this)) return;
    const row = cliStoreCerts().find((r) => r.thumbprint === thumbprint);
    expect(row).toBeDefined();
    try {
      await openDockSignForm();
      await $(SOURCE_STORE).click();
      await chooseStoreSource();
      await setReactSelectValue(STORE_SELECT, thumbprint!);
      // Held back, so the window between opening and the answer is observable.
      await pinStoreCertificates({ rows: [row!], delayMs: 3_000 });
      await $('[data-testid="sign-open"]').click();
      await browser.waitUntil(async () => !(await $(SIGN_FORM).isExisting()), { timeout: 10_000 });
      await $('[data-testid="sign-open"]').click();
      await waitForDisplayedSelector(STORE_SELECT, { timeout: 10_000 });
      // Still reading: what the picker shows is what the request would carry.
      expect(await $(STORE_SELECT).isEnabled()).toBe(false);
      expect(await $(STORE_SELECT).getValue()).toBe(thumbprint);
      // Answered: the same certificate, now confirmed by the store.
      await browser.waitUntil(async () => $(STORE_SELECT).isEnabled(), { timeout: 20_000 });
      expect(await $(STORE_SELECT).getValue()).toBe(thumbprint);
    } finally {
      await pinStoreCertificates(null);
    }
  });

  it('keeps the signing actions reachable with a long file name in long locales', async () => {
    // A file name is one unbroken word of any length; the panel header must
    // wrap it rather than push the button that opens the signing form out of
    // the dock, at the default width as well as the minimum.
    const longName = join(SCRATCH, 'Quarterly_Supplier_Agreement_2026_Countersigned.pdf');
    copyFileSync(SAMPLE_PDF, longName);
    await openByPaths([longName]);
    try {
      for (const locale of ['en', 'nl', 'de', 'el']) {
        await setUiLanguage(locale);
        for (const width of [DOCK_MIN_WIDTH, DOCK_DEFAULT_WIDTH]) {
          await seatDockPanel(width);
          for (const id of ['signatures-heading', 'signatures-recheck', 'sign-open']) {
            await assertSeen(`[data-testid="${id}"]`, DOCK_BODY);
          }
          await assertNoHorizontalOverflow(DOCK_BODY);
        }
      }
    } finally {
      await setUiLanguage('en');
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
