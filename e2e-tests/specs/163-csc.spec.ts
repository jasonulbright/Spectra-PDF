/**
 * The remote-signing door (Cloud Signature Consortium), driven end to end
 * against a real provider on this machine.
 *
 * The engine's CSC client is pinned exhaustively by `tests/test_csc.py` and
 * `tests/test_csc_sign.py`, in-process. What those cannot reach is the half
 * this file is about: the PANEL — how a provider is configured and persisted,
 * what the user is shown when the provider refuses, which credentials can be
 * selected at all — and the seam between that panel and the shipped engine
 * running inside the built binary's own Python. A parameter dropped between
 * those two is invisible to both suites separately.
 *
 * The provider is `tests/csc_mock.py`, hosted out-of-process by
 * `support/csc-mock-server.py` so the same server the unit tests pin is the
 * one the application talks to. It generates its own CA and leaf and serves
 * real HTTPS on a loopback port: the client refuses plain HTTP and never
 * disables certificate verification, so a mock speaking HTTP would only ever
 * exercise the refusal. The CA is handed to the application the way a user
 * inside a private PKI hands one over — the provider row's own CA-bundle
 * field — so nothing here relaxes the product's trust to make a test pass.
 *
 * WHAT IS NOT COVERED HERE, and why:
 *
 *   * The BROWSER sign-in leg of the authorization-code grant. Listing under
 *     that grant calls `dialog.cscAuthorize`, which opens the user's real
 *     browser against the provider's authorization server and waits on a
 *     loopback listener. WebDriver drives the application's webview, not the
 *     system browser, so the round trip cannot be completed from here. What
 *     IS asserted is everything on this side of it: that the grant changes
 *     the affordance from "list" to "sign in", and that signing refuses by
 *     name while the authorization is missing. The token exchange itself —
 *     the PKCE verifier echo, the redirect URI — is pinned by
 *     `test_authorization_code_grant_echoes_the_pkce_verifier`.
 *   * The CA-bundle FILE PICKER (`sign-csc-pick-ca`), which is a native
 *     dialog and not WebDriver-drivable — the same seam as the `.pfx` picker
 *     in `13-signing`. The bundle is seeded into the stored provider row
 *     instead, which is the exact shape the picker writes, and every later
 *     step reads it back through the product's own `loadProviders`.
 *   * Signing with a client SECRET. The mock accepts a registration without
 *     one, and this spec asserts the stronger fact — that a token request
 *     carries no `client_secret` when none was configured. That a configured
 *     secret is sent, and only then, is `test_a_secret_is_sent_only_when_configured`.
 */
import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  setActiveOp,
  setReactInputValue,
  setReactSelectValue,
  verifyActiveSignatures,
} from '../support/harness.js';

// ── the provider ──────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..', '..');
const RUNNER = resolve(__dirname, '..', 'support', 'csc-mock-server.py');
const VENV_PYTHON = resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe');

/** What the provider has been asked to do — read from the server, never from
 * the application's account of what it sent. */
interface MockState {
  token_forms: Record<string, string>[];
  authorized_hashes: string[][];
  signed_hashes: string[][];
}

class MockProvider {
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly lines: Interface,
    readonly baseUrl: string,
    readonly caPath: string,
  ) {}

  static async start(config: unknown): Promise<MockProvider> {
    const child = spawn(VENV_PYTHON, [RUNNER, JSON.stringify(config)], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    const lines = createInterface({ input: child.stdout });
    const first = await new Promise<string>((done, fail) => {
      lines.once('line', done);
      child.once('exit', (code) =>
        fail(new Error(`the mock provider exited (${code}) before serving: ${stderr}`)),
      );
    });
    const { base_url, ca_path } = JSON.parse(first) as { base_url: string; ca_path: string };
    return new MockProvider(child, lines, base_url, ca_path);
  }

  async state(): Promise<MockState> {
    const answer = new Promise<string>((done) => this.lines.once('line', done));
    this.child.stdin.write('state\n');
    return JSON.parse(await answer) as MockState;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((done) => {
      this.child.once('exit', () => done());
      this.child.stdin.write('stop\n');
      setTimeout(() => {
        this.child.kill();
        done();
      }, 5_000);
    });
  }
}

// ── driving the panel ─────────────────────────────────────────────────────

const SIGN_OPEN = '[data-testid="sign-open"]';
const SIGN_FORM = '[data-testid="sign-form"]';
const SOURCE_CSC = '[data-testid="sign-source-csc"]';
const PROVIDER = '[data-testid="sign-csc-provider"]';
const CREDENTIAL = '[data-testid="sign-csc-credential"]';
const LIST = '[data-testid="sign-csc-list"]';
const CSC_ERROR = '[data-testid="sign-csc-error"]';
const ADD_PROVIDER = '[data-testid="sign-csc-add-provider"]';
const SAVE_PROVIDER = '[data-testid="sign-csc-save-provider"]';
const SIGN_IN_PLACE = '[data-testid="sign-in-place"]';

/** The key `lib/csc-providers.ts` persists provider rows under. */
const PROVIDERS_KEY = 'spectra-csc-providers';

interface SeedRow {
  id: string;
  name: string;
  url: string;
  clientId: string;
  scope: string;
  grant: 'client-credentials' | 'authorization-code';
  caBundle: string | null;
}

async function clickEl(selector: string): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ timeout: 20_000 });
  await browser.execute((s: string) => {
    const node = document.querySelector(s) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center' });
    node?.click();
  }, selector);
}

async function textOf(selector: string): Promise<string> {
  return browser.execute((s: string) => document.querySelector(s)?.textContent ?? '', selector);
}

async function present(selector: string): Promise<boolean> {
  return browser.execute((s: string) => Boolean(document.querySelector(s)), selector);
}

async function waitFor(selector: string, msg: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => present(selector), { timeout, timeoutMsg: msg });
}

/** The options a `<select>` is offering, and which of them are selectable. */
async function options(
  selector: string,
): Promise<{ value: string; label: string; disabled: boolean }[]> {
  return browser.execute((s: string) => {
    const el = document.querySelector(s) as HTMLSelectElement | null;
    if (!el) return [];
    return Array.from(el.options).map((o) => ({
      value: o.value,
      label: o.textContent ?? '',
      disabled: o.disabled,
    }));
  }, selector);
}

/**
 * Write provider rows straight into the store the panel reads.
 *
 * This stands in for the CA-bundle picker only — a native dialog WebDriver
 * cannot open. The shape written is the module's own persisted shape, and the
 * panel loads it back through `loadProviders`, so the row still has to pass
 * the product's own validation to be usable.
 */
async function seedProviders(rows: SeedRow[]): Promise<void> {
  await browser.execute(
    (key: string, json: string) => localStorage.setItem(key, json),
    PROVIDERS_KEY,
    JSON.stringify(rows),
  );
}

/** Open the Signatures panel's sign form with the signing-service source
 * chosen, so `CscSignerFields` mounts and reads the seeded rows. */
async function openCscSource(): Promise<void> {
  await setView('operations');
  await setActiveOp('signatures');
  if (!(await present(SIGN_FORM))) await clickEl(SIGN_OPEN);
  await waitFor(SIGN_FORM, 'the sign form never opened');
  await clickEl(SOURCE_CSC);
  await waitFor(PROVIDER, 'the signing-service source never mounted');
}

/** Close the sign form, so the next case remounts the source fields against
 * whatever the store now holds. */
async function closeSignForm(): Promise<void> {
  if (!(await present(SIGN_FORM))) return;
  // `sign-open` toggles the form, so it closes it as well as opens it — no
  // need to hunt an untestid'd Cancel button inside.
  await clickEl(SIGN_OPEN);
  await browser.waitUntil(async () => !(await present(SIGN_FORM)), {
    timeout: 10_000,
    timeoutMsg: 'the sign form never closed',
  });
}

// ── the spec ──────────────────────────────────────────────────────────────

describe('the remote-signing door: a signing service over its own TLS', () => {
  let provider: MockProvider;
  let tmp = '';
  let document_ = '';

  const USABLE = 'cred-1';
  const REVOKED = 'revoked-cert';
  const PIN = 'pin-cred';

  before(async () => {
    provider = await MockProvider.start({
      credentials: [
        { credential_id: USABLE },
        { credential_id: REVOKED, cert_status: 'revoked' },
        { credential_id: PIN, auth_mode: 'explicit' },
      ],
    });

    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-csc-'));
    document_ = resolve(tmp, 'to-sign.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    writeFileSync(document_, await doc.save());

    await waitForHarness();
    await closeAllFiles();
    await openByPaths([document_]);
  });

  after(async () => {
    await closeSignForm();
    await closeAllFiles();
    await provider.stop();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  /** A configured row pointing at the mock, trusting its CA. */
  function row(overrides: Partial<SeedRow> = {}): SeedRow {
    return {
      id: 'csc-e2e',
      name: 'Mock provider',
      url: provider.baseUrl,
      clientId: 'mock-client',
      scope: 'service',
      grant: 'client-credentials',
      caBundle: provider.caPath,
      ...overrides,
    };
  }

  // ── 1. configuring a provider ────────────────────────────────────────────

  describe('configuring a provider', () => {
    before(async () => {
      await seedProviders([]);
      await closeSignForm();
      await openCscSource();
    });

    it('refuses a plain-http address without asking the network anything', async () => {
      const before = (await provider.state()).token_forms.length;

      await clickEl(ADD_PROVIDER);
      await setReactInputValue('[data-testid="sign-csc-name"]', 'Plain');
      await setReactInputValue(
        '[data-testid="sign-csc-url"]',
        provider.baseUrl.replace('https://', 'http://'),
      );
      await setReactInputValue('[data-testid="sign-csc-client-id"]', 'mock-client');
      await clickEl(SAVE_PROVIDER);

      // The refusal is the panel's own, stated before a socket is opened: a
      // signing credential is what would have travelled.
      await browser.waitUntil(
        async () => (await textOf('[data-testid="sign-form"]')).toLowerCase().includes('https'),
        { timeout: 20_000, timeoutMsg: 'the plain-http address was never refused' },
      );
      // The draft is still open — a refused row is not saved behind the user.
      expect(await present(SAVE_PROVIDER)).toBe(true);
      expect((await provider.state()).token_forms.length).toBe(before);
    });

    it('refuses a provider with no client registration of the user’s own', async () => {
      await setReactInputValue('[data-testid="sign-csc-url"]', provider.baseUrl);
      await setReactInputValue('[data-testid="sign-csc-client-id"]', '');
      await clickEl(SAVE_PROVIDER);

      await browser.waitUntil(async () => present(SAVE_PROVIDER), {
        timeout: 20_000,
        timeoutMsg: 'the draft closed on a row with no client id',
      });
      expect(await present(SAVE_PROVIDER)).toBe(true);
    });

    it('saves a complete row, and it is still there in a new panel', async () => {
      await setReactInputValue('[data-testid="sign-csc-client-id"]', 'mock-client');
      await setReactInputValue('[data-testid="sign-csc-name"]', 'Mock provider');
      await clickEl(SAVE_PROVIDER);

      await waitFor(PROVIDER, 'the draft never committed');
      // Re-read through the product's own store, in a freshly mounted panel.
      await closeSignForm();
      await openCscSource();
      const labels = (await options(PROVIDER)).map((o) => o.label);
      expect(labels).toContain('Mock provider');

      // The OAuth client secret is never persisted — the row on disk is
      // public identifiers only.
      const stored = await browser.execute(
        (key: string) => localStorage.getItem(key) ?? '',
        PROVIDERS_KEY,
      );
      expect(stored).toContain('mock-client');
      expect(stored.toLowerCase()).not.toContain('secret');
    });
  });

  // ── 2. listing, over the provider's own TLS ──────────────────────────────

  describe('listing credentials', () => {
    it('refuses a certificate it has no reason to trust, and gets no token', async () => {
      // The same address, with the private CA withheld: the only difference
      // is trust, so a listing that succeeded here would mean verification is
      // not actually happening.
      await seedProviders([row({ caBundle: null })]);
      await closeSignForm();
      await openCscSource();
      await setReactSelectValue(PROVIDER, 'csc-e2e');

      const before = (await provider.state()).token_forms.length;
      await clickEl(LIST);
      await waitFor(CSC_ERROR, 'an untrusted certificate was never refused');
      expect((await textOf(CSC_ERROR)).toLowerCase()).toContain('trusted');
      // Refused at the handshake: the token endpoint was never reached.
      expect((await provider.state()).token_forms.length).toBe(before);
    });

    it('surfaces the provider’s own refusal of an unknown client registration', async () => {
      await seedProviders([row({ clientId: 'not-the-client' })]);
      await closeSignForm();
      await openCscSource();
      await setReactSelectValue(PROVIDER, 'csc-e2e');

      const before = (await provider.state()).token_forms.length;
      await clickEl(LIST);
      await waitFor(CSC_ERROR, 'the provider’s refusal was never shown');
      expect(await textOf(CSC_ERROR)).toContain('401');

      // The provider really was asked, with the client id the row carried —
      // and the credential list never opened.
      const state = await provider.state();
      expect(state.token_forms.length).toBe(before + 1);
      expect(state.token_forms[before].client_id).toBe('not-the-client');
      expect((await options(CREDENTIAL)).length).toBe(1); // the placeholder only
    });

    it('lists the credentials over TLS the user’s own CA anchors', async () => {
      await seedProviders([row()]);
      await closeSignForm();
      await openCscSource();
      await setReactSelectValue(PROVIDER, 'csc-e2e');

      const before = (await provider.state()).token_forms.length;
      await clickEl(LIST);
      await browser.waitUntil(async () => (await options(CREDENTIAL)).length > 1, {
        timeout: 60_000,
        timeoutMsg: 'the credentials never listed',
      });
      expect(await present(CSC_ERROR)).toBe(false);

      const values = (await options(CREDENTIAL)).map((o) => o.value);
      expect(values).toContain(USABLE);
      expect(values).toContain(REVOKED);
      expect(values).toContain(PIN);

      // A client-credentials registration with no secret configured sends
      // none — an empty one is omitted, never sent as a registration that
      // has none.
      const form = (await provider.state()).token_forms[before];
      expect(form.grant_type).toBe('client_credentials');
      expect(form.client_id).toBe('mock-client');
      expect(form.client_secret).toBeUndefined();
    });

    it('shows an unusable credential with its reason, and will not let it be chosen', async () => {
      const rows = await options(CREDENTIAL);
      // Both unusable rows are OFFERED — a user staring at a short list has
      // to be able to learn why it is short — and both are unselectable.
      expect(rows.find((o) => o.value === REVOKED)?.disabled).toBe(true);
      expect(rows.find((o) => o.value === PIN)?.disabled).toBe(true);
      expect(rows.find((o) => o.value === USABLE)?.disabled).toBe(false);

      const panel = (await textOf(SIGN_FORM)).toLowerCase();
      expect(panel).toContain('revoked');
      // The PIN credential's reason names the posture, not just a status:
      // this application does not collect an authentication factor.
      expect(panel).toContain('one-time password');
    });
  });

  // ── 3. signing through the service ───────────────────────────────────────

  describe('signing with a service credential', () => {
    it('signs the open document, and the provider signed exactly what it authorized', async () => {
      const before = await provider.state();
      await setReactSelectValue(CREDENTIAL, USABLE);
      await clickEl(SIGN_IN_PLACE);

      // The sign form closes on success; the panel then lists the signature.
      await browser.waitUntil(async () => !(await present(SIGN_FORM)), {
        timeout: 120_000,
        timeoutMsg: 'the sign never completed (the form stayed open)',
      });

      const verified = await verifyActiveSignatures();
      expect(verified.signature_count).toBe(before.signed_hashes.length + 1);
      expect(verified.all_valid).toBe(true);

      // Read from the PROVIDER, not from the application: one authorization,
      // one signature, and under SCAL2 the SAD it spent was bound to exactly
      // the hash it then signed — the mock refuses the pair otherwise.
      const after = await provider.state();
      expect(after.authorized_hashes.length).toBe(before.authorized_hashes.length + 1);
      expect(after.signed_hashes.length).toBe(before.signed_hashes.length + 1);
      const authorized = after.authorized_hashes[before.authorized_hashes.length];
      const signed = after.signed_hashes[before.signed_hashes.length];
      expect(authorized.length).toBe(1);
      expect(signed).toEqual(authorized);
    });

    it('sent a digest and never the document', async () => {
      // The seam is the digest: a SHA-256 hash is 32 bytes, which is 44
      // base64 characters, and the document is orders of magnitude larger.
      // A provider that had been handed the file would show it here.
      const state = await provider.state();
      for (const batch of state.signed_hashes) {
        for (const hash of batch) {
          expect(hash.length).toBeLessThanOrEqual(88);
        }
      }
    });
  });

  // ── 4. the grant that needs a browser ────────────────────────────────────

  describe('a provider whose grant needs the browser', () => {
    /**
     * The sign-in itself opens the system browser and cannot be completed
     * from a webview session (see the file header). What is reachable is
     * everything either side of it: the affordance changes, and every path
     * that would send a signing request without an authorization refuses by
     * name rather than reaching the provider anyway.
     */
    before(async () => {
      await seedProviders([row({ grant: 'authorization-code' })]);
      await closeSignForm();
      await openCscSource();
      await setReactSelectValue(PROVIDER, 'csc-e2e');
    });

    it('offers a sign-in rather than a listing', async () => {
      const label = (await textOf(LIST)).toLowerCase();
      expect(label).not.toBe('');
      // Whatever the wording, it is NOT the plain listing affordance the
      // client-credentials row shows — the user is being told a browser is
      // about to open.
      expect(label).toContain('sign in');
    });

    it('refuses to sign while the authorization is missing, and asks nothing of the provider', async () => {
      const before = (await provider.state()).token_forms.length;
      const quiet = await textOf(SIGN_FORM);
      await clickEl(SIGN_IN_PLACE);

      // The refusal renders INSIDE the form (the `sign-error` surface is the
      // one shown once the form is closed), so it is read as a change to the
      // form's own text.
      await browser.waitUntil(async () => (await textOf(SIGN_FORM)) !== quiet, {
        timeout: 20_000,
        timeoutMsg: 'signing without an authorization was allowed silently',
      });
      // The form is still open — the sign never started.
      expect(await present(SIGN_FORM)).toBe(true);
      expect((await provider.state()).token_forms.length).toBe(before);
    });
  });
});
