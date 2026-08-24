import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  answerNextSaveDialog,
  getState,
  invokeAppCommand,
  createPlacedField,
  openByPaths,
  placeNewField,
  saveActiveAs,
  saveDialogPending,
  setActiveOp,
  setReactSelectValue,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
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

const SOURCE_STORE = '[data-testid="sign-source-store"]';
const STORE_SELECT = '[data-testid="sign-store-cert"]';
const STORE_REFRESH = '[data-testid="sign-store-refresh"]';
const SIGN_FORM = '[data-testid="sign-form"]';

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

async function rememberedThumbprint(): Promise<string | null> {
  return browser.execute(
    () => localStorage.getItem('spectra-signer-store-cert'),
  ) as Promise<string | null>;
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

  it('offers a fourth signer source, and choosing it prompts for nothing', async () => {
    await openSignForm();
    // All four sources are offered on the panel surface.
    for (const mode of ['pfx', 'pem', 'pkcs11', 'store']) {
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
    await $('[data-testid="sign-source-pfx"]').click();
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
    await browser.execute(() =>
      localStorage.setItem('spectra-signer-store-cert', '0000000000000000000000000000000000000000'),
    );
    await openByPaths([SAMPLE_PDF]);
    await openSignForm();
    await chooseStoreSource();
    // The picker settled and no identity is selected — the placeholder row.
    expect(await $(STORE_SELECT).getValue()).toBe('');
    if (thumbprint) {
      await browser.execute(
        (tp: string) => localStorage.setItem('spectra-signer-store-cert', tp),
        thumbprint,
      );
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
    await $('[data-testid="sign-source-pfx"]').click();
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
});
