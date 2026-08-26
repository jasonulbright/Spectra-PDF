/**
 * The two outbound doors, driven end to end against a real HTTP server on this
 * machine.
 *
 * Everything here that matters is a NEGATIVE, and a negative about the network
 * cannot be asserted from inside the app: "nothing was sent" is a claim about
 * what a listener did or did not hear. So the fixture below is a real
 * `node:http` server that appends every request it receives — method, path,
 * headers, body — to a list this spec reads. A cancelled submission is proven
 * by that list still being empty; a re-opened recent is proven by it not
 * growing. No assertion here is made from the renderer's own account of
 * itself.
 *
 * A second server on a second port exists for one case only: its authority is
 * a different origin from the first, so a redirect pointed at it is the
 * cross-origin abort, and its own log proves the abort happened BEFORE any
 * request reached it.
 *
 * The fixture is plain HTTP by construction — a loopback listener with no
 * certificate — which is exactly the condition both plain-http warning lines
 * exist to state, so this spec asserts them rather than mocking the condition.
 */
import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString, PDFArray } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  closeAllFiles,
  invokeAppCommand,
  focusTab,
  startCanvasFormAction,
  answerNextFormDataSaveDialog,
  answerNextSaveDialog,
  takenSaveDialogDefault,
  saveActiveAs,
  getWorkspacePageIds,
  selectCanvasPages,
  getSelectedCanvasPageIds,
  rotateSelectedCanvasPages,
} from '../support/harness.js';

// ── the fixture server ────────────────────────────────────────────────────

interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Fixture {
  server: Server;
  port: number;
  log: LoggedRequest[];
}

/** A one-page PDF, as bytes — what a `application/pdf` reply carries and what
 * the open-from-web door downloads. */
async function pdfBytes(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText(text, { x: 20, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

/**
 * The listener. Routes are a fixed table keyed by the request path: no
 * response body is ever composed from anything the request carried, so a
 * spec's own payload can never be echoed back and mistaken for a fetch.
 */
async function startFixture(otherPortRef: { port: number }): Promise<Fixture> {
  const log: LoggedRequest[] = [];
  const document = await pdfBytes('served over the wire');
  const reply = await pdfBytes('the reply document');

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      log.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      switch (path) {
        case '/collect':
          // Accepted, nothing to hand back — the shortest complete round trip.
          res.writeHead(204).end();
          return;
        case '/reply-fdf': {
          const body =
            '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T (Name) /V (from-the-server) >> ] >> >>\n' +
            'endobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
          res.writeHead(200, {
            'content-type': 'application/vnd.fdf',
            'content-length': Buffer.byteLength(body),
          }).end(body);
          return;
        }
        case '/reply-pdf':
          res
            .writeHead(200, { 'content-type': 'application/pdf', 'content-length': reply.length })
            .end(reply);
          return;
        case '/reply-html': {
          const body = '<!DOCTYPE html><html><body><p>thank you</p></body></html>';
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body),
          }).end(body);
          return;
        }
        case '/bounce':
          // Off this origin entirely: a different port is a different
          // authority, which is what the same-origin rule compares.
          res
            .writeHead(302, { location: `http://127.0.0.1:${otherPortRef.port}/landed` })
            .end();
          return;
        case '/doc.pdf':
          res
            .writeHead(200, {
              'content-type': 'application/pdf',
              'content-length': document.length,
            })
            .end(document);
          return;
        case '/not-a-pdf': {
          const body = 'this is not a document\n';
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': Buffer.byteLength(body),
          }).end(body);
          return;
        }
        default:
          res.writeHead(404).end();
      }
    });
  });

  const port = await listen(server);
  return { server, port, log };
}

/** The second origin. It serves anything at all; the point of the case is
 * that it is never asked. */
async function startOther(): Promise<Fixture> {
  const log: LoggedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    log.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('reached');
  });
  const port = await listen(server);
  return { server, port, log };
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((done) => {
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
  });
}

function stop(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

// ── driving the app's dialogs ─────────────────────────────────────────────

const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_AFFIRM = '[data-testid="confirm-affirm"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';
const NOTICE_OK = '[data-testid="notice-ok"]';
const CONSENT = '[data-testid="submit-consent-dialog"]';

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
  return browser.execute(
    (s: string) => document.querySelector(s)?.textContent ?? '',
    selector,
  );
}

async function valueOf(selector: string): Promise<string> {
  return browser.execute(
    (s: string) => (document.querySelector(s) as HTMLTextAreaElement | null)?.value ?? '',
    selector,
  );
}

async function present(selector: string): Promise<boolean> {
  return browser.execute((s: string) => Boolean(document.querySelector(s)), selector);
}

async function waitFor(selector: string, msg: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => present(selector), { timeout, timeoutMsg: msg });
}

async function waitGone(selector: string, msg: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => !(await present(selector)), { timeout, timeoutMsg: msg });
}

/** Read the confirm dialog's message, then answer it. */
async function answerConfirm(affirm: boolean, msg: string): Promise<string> {
  await waitFor(CONFIRM_MESSAGE, msg);
  const text = await textOf(CONFIRM_MESSAGE);
  await clickEl(affirm ? CONFIRM_AFFIRM : CONFIRM_CANCEL);
  return text;
}

/** Read a notice, then dismiss it. */
async function readNotice(msg: string): Promise<string> {
  await waitFor(NOTICE_OK, msg);
  const text = await textOf(CONFIRM_MESSAGE);
  await clickEl(NOTICE_OK);
  return text;
}

async function openWebDialog(): Promise<void> {
  expect(await invokeAppCommand('file.openFromWeb')).toBe(true);
  await waitFor('[data-testid="open-web-dialog"]', 'the open-from-web dialog never opened');
}

async function typeUrl(url: string): Promise<void> {
  await browser.execute((value: string) => {
    const input = document.querySelector(
      '[data-testid="open-web-url"]',
    ) as HTMLInputElement | null;
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, url);
}

/** Give the active document an unsaved change, so File ▸ Save is enabled at
 * all — Save is disabled on a document nothing has touched. */
async function dirtyTheDocument(): Promise<void> {
  await setView('canvas');
  // Both the page listing and the rotate go through the canvas selection
  // service, and BOTH are silent no-ops until it registers: the listing
  // answers `[]` and the rotate does nothing at all. `setView` returns before
  // the canvas has mounted, so a non-empty listing is the first honest
  // evidence that there is anything to act on — without it the rotate lands
  // nowhere, the document stays clean, and File ▸ Save is never enabled.
  // (The second window makes this reliable rather than occasional: it mounts
  // its canvas from scratch after the hand-off.)
  let pages: string[] = [];
  await browser.waitUntil(
    async () => {
      pages = await getWorkspacePageIds();
      return pages.length > 0;
    },
    { timeout: 30_000, timeoutMsg: 'the canvas never listed any pages to edit' },
  );

  await selectCanvasPages([pages[0]]);
  // The rotate acts on THE SELECTION, so it also has to have landed.
  await browser.waitUntil(
    async () => (await getSelectedCanvasPageIds()).includes(pages[0]),
    { timeout: 20_000, timeoutMsg: 'the page selection never landed' },
  );
  await rotateSelectedCanvasPages(90);
}

/**
 * Run File ▸ Save once it is enabled.
 *
 * Its enablement is `f.dirty || pageDirtyPaths.includes(f.path)`, and a
 * page-tier rotate lands in the SECOND of those — which the state snapshot
 * does not carry, so there is nothing to wait on directly. `invokeCommand`
 * returns the enablement verdict and does nothing at all when the answer is
 * no, so polling it IS the wait: the first `true` is also the one invocation
 * that ran.
 */
async function saveWhenEnabled(): Promise<void> {
  await browser.waitUntil(async () => invokeAppCommand('file.save'), {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: 'File ▸ Save never became enabled after the page edit',
  });
}

/** Wait until the driver reports `count` window handles. */
async function waitForHandles(count: number): Promise<string[]> {
  let handles: string[] = [];
  await browser.waitUntil(
    async () => {
      handles = await browser.getWindowHandles();
      return handles.length === count;
    },
    { timeout: 30_000, interval: 250, timeoutMsg: `never saw ${count} window handles` },
  );
  return handles;
}

// ── the fixture document ──────────────────────────────────────────────────

/**
 * A form whose buttons carry real `/SubmitForm` actions, authored straight
 * into the file rather than through this app's own writer: a submission
 * button is something a DOCUMENT arrives carrying, and the consent boundary
 * has to hold for one this app never wrote.
 *
 * `/Flags` 0 is FDF by POST — the format the payload preview shows as text,
 * which is what makes "the exact bytes" assertable. A destination may instead
 * name its own `/Flags` (PDF 32000-1 table 237: bit 3 ExportFormat, bit 4
 * GetMethod), which is how the URL-encoded-by-GET shape is authored.
 */
type Destination = string | { url: string; flags: number };

const HTML_BY_GET = (1 << 2) | (1 << 3);

async function makeSubmitFixture(path: string, destinations: Record<string, Destination>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const context = doc.context;

  const name = form.createTextField('Name');
  name.addToPage(page, { x: 50, y: 340, width: 200, height: 22 });
  name.setText('typed-by-the-user');

  let y = 300;
  for (const [field, destination] of Object.entries(destinations)) {
    const url = typeof destination === 'string' ? destination : destination.url;
    const flags = typeof destination === 'string' ? 0 : destination.flags;
    const button = form.createTextField(field);
    button.addToPage(page, { x: 320, y, width: 120, height: 20 });
    y -= 26;
    const widget = button.acroField.getWidgets()[0];
    const fields = PDFArray.withContext(context);
    fields.push(PDFString.of('Name'));
    widget.dict.set(
      PDFName.of('A'),
      context.register(
        context.obj({
          S: PDFName.of('SubmitForm'),
          F: PDFString.of(url),
          Fields: fields,
          Flags: flags,
        }),
      ),
    );
  }

  writeFileSync(path, await doc.save());
}

// ── the spec ──────────────────────────────────────────────────────────────

describe('the network doors: form submission and open from a web address', () => {
  let tmp = '';
  let fixture: Fixture;
  let other: Fixture;
  let form = '';
  let base = '';

  before(async () => {
    other = await startOther();
    fixture = await startFixture({ port: other.port });
    base = `http://127.0.0.1:${fixture.port}`;

    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-network-'));
    form = resolve(tmp, 'submit-form.pdf');
    await makeSubmitFixture(form, {
      SendCollect: `${base}/collect`,
      SendCancel: `${base}/collect?from=cancel`,
      SendFdf: `${base}/reply-fdf`,
      SendPdf: `${base}/reply-pdf`,
      SendHtml: `${base}/reply-html`,
      SendBounce: `${base}/bounce`,
      SendMail: 'mailto:forms@example.invalid',
      SendGet: { url: `${base}/collect`, flags: HTML_BY_GET },
    });
  });

  after(async () => {
    await closeAllFiles();
    await stop(fixture.server);
    await stop(other.server);
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  /** Open the submit fixture on the canvas, with a value in the field. */
  async function openForm(): Promise<void> {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([form]);
    await setView('canvas');
  }

  // ── 1. the consent flow ────────────────────────────────────────────────

  describe('submitting through the consent dialog', () => {
    before(openForm);

    it('shows the whole destination, the format and the exact payload', async () => {
      await startCanvasFormAction(form, 'SendCollect', 'A');

      // The pre-flight confirm names the destination before anything is built.
      const intro = await answerConfirm(true, 'the submit confirm never opened');
      expect(intro).toContain(`${base}/collect`);

      await waitFor(CONSENT, 'the consent dialog never opened');
      // The URL, whole and unelided — the string that will be requested.
      expect(await textOf('[data-testid="submit-consent-url"]')).toBe(`${base}/collect`);
      // The format, named rather than implied by the payload's shape.
      expect((await textOf(CONSENT)).toLowerCase()).toContain('fdf');
      // The payload, as its exact bytes. The value the user typed is in it;
      // the dialog is showing the file that transmits, not a paraphrase.
      const payload = await valueOf('[data-testid="submit-consent-payload"]');
      expect(payload).toContain('%FDF');
      expect(payload).toContain('typed-by-the-user');
      expect(payload).toContain('Name');
    });

    it('warns that the destination is plain HTTP', async () => {
      // The fixture is a loopback listener with no certificate — the warning
      // is asserted against the real condition, not a simulated one.
      expect(await present('[data-testid="submit-consent-http-warning"]')).toBe(true);
      expect(await textOf('[data-testid="submit-consent-http-warning"]')).not.toBe('');
    });

    it('sends the payload, with our user agent and no cookie or auth header', async () => {
      const before = fixture.log.length;
      await clickEl('[data-testid="submit-consent-submit"]');

      await browser.waitUntil(async () => fixture.log.length > before, {
        timeout: 30_000,
        timeoutMsg: 'the server never received the submission',
      });
      expect(fixture.log.length).toBe(before + 1);

      const sent = fixture.log[before];
      expect(sent.method).toBe('POST');
      expect(sent.url).toBe('/collect');
      // What the dialog showed is what arrived.
      expect(sent.body).toContain('%FDF');
      expect(sent.body).toContain('typed-by-the-user');
      expect(sent.headers['content-type']).toBe('application/vnd.fdf');
      // The posture, read off the wire rather than off the source: the plain
      // product UA, and no ambient credential of any kind.
      expect(String(sent.headers['user-agent'] ?? '')).toMatch(/^SpectraPDF\//);
      expect(sent.headers.cookie).toBeUndefined();
      expect(sent.headers.authorization).toBeUndefined();

      // 204: accepted with nothing to hand back, reported and done.
      expect(await readNotice('the submission never reported its result')).toContain(
        `${base}/collect`,
      );
    });
  });

  // ── 2. cancel sends nothing ────────────────────────────────────────────

  describe('cancelling the consent dialog', () => {
    it('sends nothing at all — proven by the server hearing nothing', async () => {
      const before = fixture.log.length;

      await startCanvasFormAction(form, 'SendCancel', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');
      expect(await textOf('[data-testid="submit-consent-url"]')).toBe(
        `${base}/collect?from=cancel`,
      );

      await clickEl('[data-testid="submit-consent-cancel"]');
      await waitGone(CONSENT, 'the consent dialog stayed open after Cancel');

      // Nothing follows a cancel: no notice, no request. The wait is real
      // time given to a request that would have been made, not an instant
      // check that could pass before one left.
      await browser.pause(2_000);
      expect(fixture.log.length).toBe(before);
    });
  });

  // ── 3. response routing ────────────────────────────────────────────────

  describe('routing what comes back', () => {
    it('offers an FDF reply as a form-data import', async () => {
      await startCanvasFormAction(form, 'SendFdf', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');
      await clickEl('[data-testid="submit-consent-submit"]');

      // The import door, user-confirmed — never applied on arrival.
      const offer = await answerConfirm(true, 'the FDF reply was never offered as an import');
      expect(offer).toContain(`${base}/reply-fdf`);

      // The import is a whole-file op: the proof is in the document's own
      // bytes, not in what the overlay is showing.
      const imported = resolve(tmp, 'after-fdf-import.pdf');
      await browser.waitUntil(
        async () => {
          await saveActiveAs(imported);
          const doc = await PDFDocument.load(new Uint8Array(readFileSync(imported)));
          return doc.getForm().getTextField('Name').getText() === 'from-the-server';
        },
        { timeout: 40_000, interval: 2_000, timeoutMsg: 'the confirmed import never landed' },
      );
    });

    it('opens a PDF reply as a document, through the ordinary funnel', async () => {
      const before = (await getState()).fileCount;
      await startCanvasFormAction(form, 'SendPdf', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');
      await clickEl('[data-testid="submit-consent-submit"]');

      const offer = await answerConfirm(true, 'the PDF reply was never offered to open');
      expect(offer).toContain(`${base}/reply-pdf`);

      await browser.waitUntil(async () => (await getState()).fileCount > before, {
        timeout: 40_000,
        timeoutMsg: 'the PDF reply never opened as a document',
      });
      const state = await getState();
      expect(state.activeFile?.path).not.toBe(form);
      expect(state.activeFile?.pageCount).toBe(1);
    });

    it('offers an HTML reply as a saved file and never renders it', async () => {
      await openForm();
      const before = (await getState()).fileCount;
      const saved = resolve(tmp, 'reply.html');
      await answerNextFormDataSaveDialog(saved);

      await startCanvasFormAction(form, 'SendHtml', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');
      await clickEl('[data-testid="submit-consent-submit"]');

      const offer = await answerConfirm(true, 'the HTML reply was never offered as a file');
      expect(offer).toContain(`${base}/reply-html`);
      expect(offer.toLowerCase()).toContain('text/html');

      expect(await readNotice('the saved reply was never reported')).toContain(saved);
      expect(existsSync(saved)).toBe(true);
      expect(readFileSync(saved, 'utf-8')).toContain('thank you');

      // The door that interprets nothing: no tab, no render, no document.
      expect((await getState()).fileCount).toBe(before);
    });
  });

  // ── 4. the cross-origin redirect ───────────────────────────────────────

  describe('a redirect off the approved origin', () => {
    it('aborts naming both hosts, and the other host is never asked', async () => {
      await startCanvasFormAction(form, 'SendBounce', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');
      await clickEl('[data-testid="submit-consent-submit"]');

      const failure = await readNotice('the redirect abort was never reported');
      expect(failure).toContain(`127.0.0.1:${fixture.port}`);
      expect(failure).toContain(`127.0.0.1:${other.port}`);

      // The abort happened in our own loop, before the transport followed it.
      await browser.pause(2_000);
      expect(other.log.length).toBe(0);
    });
  });

  // ── 6. a destination with no transport ─────────────────────────────────

  describe('a mailto: destination', () => {
    it('refuses the transport by name and still hands over the built file', async () => {
      const before = fixture.log.length;
      const saved = resolve(tmp, 'mailto-submission.fdf');
      await answerNextFormDataSaveDialog(saved);

      await startCanvasFormAction(form, 'SendMail', 'A');
      const refusal = await answerConfirm(true, 'the mailto refusal was never shown');
      expect(refusal.toLowerCase()).toContain('mail');

      // No consent dialog: there is no transport to consent to.
      expect(await present(CONSENT)).toBe(false);

      // The submission is still BUILT and handed over.
      const built = await answerConfirm(false, 'the built submission was never reported');
      expect(built).toContain(saved);
      expect(existsSync(saved)).toBe(true);
      expect(readFileSync(saved, 'utf-8')).toContain('typed-by-the-user');

      expect(fixture.log.length).toBe(before);
      expect(other.log.length).toBe(0);
    });
  });

  // ── 5. open from a web address ─────────────────────────────────────────

  describe('open from a web address', () => {
    it('warns that the address is plain HTTP before anything is fetched', async () => {
      await closeAllFiles();
      await openWebDialog();
      await typeUrl(`${base}/doc.pdf`);
      await browser.waitUntil(
        async () => (await textOf('[data-testid="open-web-target"]')).includes(`${base}/doc.pdf`),
        { timeout: 20_000, timeoutMsg: 'the dialog never showed the address it would fetch' },
      );
      expect(await present('[data-testid="open-web-insecure"]')).toBe(true);
    });

    it('opens the served document through the one funnel', async () => {
      const before = fixture.log.length;
      await clickEl('[data-testid="open-web-open"]');
      await waitGone('[data-testid="open-web-dialog"]', 'the dialog never closed on a success');

      const state = await getState();
      expect(state.fileCount).toBeGreaterThan(0);
      expect(state.activeFile?.pageCount).toBe(1);

      const fetched = fixture.log[before];
      expect(fetched.method).toBe('GET');
      expect(fetched.url).toBe('/doc.pdf');
      expect(String(fetched.headers['user-agent'] ?? '')).toMatch(/^SpectraPDF\//);
      expect(fetched.headers.cookie).toBeUndefined();
    });

    it('routes Save on the downloaded document to Save As, every time', async () => {
      await dirtyTheDocument();
      const kept = resolve(tmp, 'kept-from-the-web.pdf');
      await answerNextSaveDialog(kept);
      await saveWhenEnabled();

      await browser.waitUntil(async () => existsSync(kept), {
        timeout: 40_000,
        timeoutMsg: 'File ▸ Save never reached the Save As picker',
      });
      // The picker really was the one that ran — it took a default name.
      expect(await takenSaveDialogDefault()).not.toBeNull();

      // And the document stayed on its temp path: Save As wrote a COPY, so
      // the download never acquired a home to save back to. A second Save
      // therefore asks again.
      const state = await getState();
      expect(state.activeFile?.path).not.toBe(kept);

      const again = resolve(tmp, 'kept-again.pdf');
      await dirtyTheDocument();
      await answerNextSaveDialog(again);
      await saveWhenEnabled();
      await browser.waitUntil(async () => existsSync(again), {
        timeout: 40_000,
        timeoutMsg: 'the second Save did not route to Save As as well',
      });
    });

    it('refuses a response that is not a document, without crashing', async () => {
      const before = fixture.log.length;
      await openWebDialog();
      await typeUrl(`${base}/not-a-pdf`);
      await clickEl('[data-testid="open-web-open"]');

      await waitFor('[data-testid="open-web-error"]', 'the refusal was never shown');
      const refusal = await textOf('[data-testid="open-web-error"]');
      expect(refusal).toContain(`${base}/not-a-pdf`);

      // The request happened; the app is still alive and the dialog is still
      // the surface holding the refusal.
      expect(fixture.log.length).toBe(before + 1);
      expect(await present('[data-testid="open-web-dialog"]')).toBe(true);
      await clickEl('[data-testid="open-web-cancel"]');
      await waitGone('[data-testid="open-web-dialog"]', 'Cancel never closed the dialog');
      expect((await getState()).fileCount).toBeGreaterThan(0);
    });

    it('re-opens a recent web document PRE-FILLED, and fetches nothing until Open', async () => {
      await closeAllFiles();
      await focusTab('home');
      await waitFor('[data-testid="home-recent-item"]', 'the recent list never appeared');

      const before = fixture.log.length;
      // The first row is the most recent — the download from two cases up.
      await clickEl('[data-testid="home-recent-item"]');

      await waitFor(
        '[data-testid="open-web-dialog"]',
        'a recent web document did not re-open through the dialog',
      );
      const filled = await browser.execute(
        () =>
          (document.querySelector('[data-testid="open-web-url"]') as HTMLInputElement | null)
            ?.value ?? '',
      );
      expect(filled).toBe(`${base}/doc.pdf`);

      // Pre-filled, never pre-fetched: the server heard nothing.
      await browser.pause(2_000);
      expect(fixture.log.length).toBe(before);

      // And Open from here does fetch — the door still works, it just waited.
      await clickEl('[data-testid="open-web-open"]');
      await waitGone('[data-testid="open-web-dialog"]', 'the re-open never completed');
      expect(fixture.log.length).toBe(before + 1);
      expect(fixture.log[before].url).toBe('/doc.pdf');
    });
  });

  // ── 7. GET puts the payload on the URL ─────────────────────────────────

  describe('a GET-method submission', () => {
    /**
     * `GetMethod` moves the field data onto the query string. That is a
     * different DISCLOSURE than a POST body — a query string is logged by
     * every proxy and server on the path — so the consent dialog has to name
     * the method, and the request that leaves has to actually carry the data
     * where the method says it goes. Both halves are asserted here, the
     * second from the server's own log rather than from the app's account of
     * what it sent.
     */
    before(openForm);

    it('names the method in the consent dialog', async () => {
      await startCanvasFormAction(form, 'SendGet', 'A');
      await answerConfirm(true, 'the submit confirm never opened');
      await waitFor(CONSENT, 'the consent dialog never opened');

      const method = (await textOf('[data-testid="submit-consent-method"]')).toLowerCase();
      expect(method).toContain('get');

      // Export format follows the flag: URL-encoded, not FDF. The payload
      // preview is the bytes that will ride the query.
      expect((await textOf(CONSENT)).toLowerCase()).not.toContain('%fdf');
      const payload = await valueOf('[data-testid="submit-consent-payload"]');
      expect(payload).toContain('Name=typed-by-the-user');
    });

    it('sends the payload in the query string, with no body', async () => {
      const before = fixture.log.length;
      await clickEl('[data-testid="submit-consent-submit"]');

      await browser.waitUntil(async () => fixture.log.length > before, {
        timeout: 30_000,
        timeoutMsg: 'the server never received the GET submission',
      });
      expect(fixture.log.length).toBe(before + 1);

      const sent = fixture.log[before];
      expect(sent.method).toBe('GET');
      // The data is ON THE URL — the whole point of the method flag.
      expect(sent.url).toContain('?');
      expect(sent.url).toContain('Name=typed-by-the-user');
      expect(sent.url.split('?')[0]).toBe('/collect');
      // …and nowhere else. A GET that also carried a body would be sending
      // the form twice, and a server reading only one would see half of it.
      expect(sent.body).toBe('');
      expect(sent.headers['content-type']).toBeUndefined();
      expect(String(sent.headers['user-agent'] ?? '')).toMatch(/^SpectraPDF\//);
      expect(sent.headers.cookie).toBeUndefined();

      expect(await readNotice('the GET submission never reported its result')).toContain(
        `${base}/collect`,
      );
    });
  });

  // ── 8. the private-address split ───────────────────────────────────────

  describe('a private destination', () => {
    /**
     * The two doors take OPPOSITE decisions about the same address, and the
     * difference is who chose it.
     *
     *   * A submit destination is DOCUMENT-chosen. A file that arrives by
     *     mail can name a printer, a router or a service on the user's own
     *     LAN, and the user never typed that address. It is REFUSED by name.
     *   * An open address is USER-typed. A private host there is plausibly a
     *     deliberate LAN fetch, so it is fetched — with the dialog saying
     *     plainly what kind of address it is first.
     *
     * The WARN half is driven end to end below against the loopback fixture,
     * which is a private address by construction.
     *
     * The REFUSE half cannot be driven through this binary: the e2e build
     * exports `SPECTRAPDF_E2E`, which opens `net.rs`'s `env_allows_private`
     * carve-out for the whole process — the same carve-out that lets every
     * other case in this spec reach 127.0.0.1 at all. Turning it off would
     * take the rest of the file down with it. The refusal itself is proven
     * against the production policy (`allow_private = false`) by the Rust
     * unit test `a_submit_to_a_hostname_that_resolves_private_is_refused` in
     * `src-tauri/src/net.rs`, which asserts the by-name refusal and that no
     * connection is attempted. What is asserted here is the half this
     * process can honestly observe.
     */
    it('warns that an open address is private, and still opens it', async () => {
      await closeAllFiles();
      await openWebDialog();
      await typeUrl(`${base}/doc.pdf`);
      await browser.waitUntil(
        async () => (await textOf('[data-testid="open-web-target"]')).includes(`${base}/doc.pdf`),
        { timeout: 20_000, timeoutMsg: 'the dialog never showed the address it would fetch' },
      );

      // Named as private, not merely as insecure: those are two warnings
      // about two different things and the address is both.
      expect(await present('[data-testid="open-web-private"]')).toBe(true);
      expect(await textOf('[data-testid="open-web-private"]')).not.toBe('');
      expect(await present('[data-testid="open-web-insecure"]')).toBe(true);

      // Warned is not refused: the user typed it, so Open proceeds.
      const before = fixture.log.length;
      await clickEl('[data-testid="open-web-open"]');
      await waitGone('[data-testid="open-web-dialog"]', 'a warned private open never completed');

      expect(fixture.log.length).toBe(before + 1);
      expect(fixture.log[before].url).toBe('/doc.pdf');
      const state = await getState();
      expect(state.fileCount).toBeGreaterThan(0);
      expect(state.activeFile?.pageCount).toBe(1);
    });
  });

  // ── 9. the origin crosses windows ──────────────────────────────────────

  describe('a downloaded document moved to a second window', () => {
    /**
     * `webOrigin` is what routes File ▸ Save to Save As: a download has no
     * home on disk to save back to, and saving over its scratch copy would
     * discard the user's work into the temp tree. The record lives in Rust
     * managed state keyed by path, NOT in the renderer, precisely because a
     * second window is a fresh module scope that starts empty. Move-to-new-
     * window carries the path and nothing else, so if the second window
     * re-derived the origin from its own memory it would have none — and
     * Save there would write over the temp file silently.
     */
    let mainHandle = '';
    let popped = '';

    after(async () => {
      // Leave the session on one window however this block ended.
      const handles = await browser.getWindowHandles();
      if (popped && handles.includes(popped)) {
        await browser.switchToWindow(popped);
        await browser.execute(() => {
          void (window as any).__SPECTRA_TEST__.closeThisWindow();
        });
      }
      if (mainHandle) {
        await browser.switchToWindow(mainHandle);
        await waitForHandles(1);
      }
    });

    it('downloads a document in the first window', async () => {
      await closeAllFiles();
      mainHandle = (await browser.getWindowHandles())[0];

      await openWebDialog();
      await typeUrl(`${base}/doc.pdf`);
      await clickEl('[data-testid="open-web-open"]');
      await waitGone('[data-testid="open-web-dialog"]', 'the download never completed');
      expect((await getState()).fileCount).toBe(1);
    });

    it('moves it to a second window, which claims it', async () => {
      const moved = (await getState()).activeFile!.path;
      expect(await invokeAppCommand('window.moveToNewWindow')).toBe(true);

      const handles = await waitForHandles(2);
      popped = handles.find((h) => h !== mainHandle)!;

      await browser.waitUntil(async () => (await getState()).fileCount === 0, {
        timeout: 30_000,
        timeoutMsg: 'the moved document never left the first window',
      });

      await browser.switchToWindow(popped);
      await waitForHarness(30_000);
      // The handover is a queued open on the receiving side: the harness
      // answering does not mean the document has landed yet.
      await browser.waitUntil(async () => (await getState()).fileCount === 1, {
        timeout: 30_000,
        timeoutMsg: 'the moved document never arrived in the new window',
      });
      expect((await getState()).activeFile?.path.toLowerCase()).toBe(moved.toLowerCase());
    });

    it('still routes Save to Save As over there', async () => {
      const kept = resolve(tmp, 'kept-in-the-second-window.pdf');
      await dirtyTheDocument();
      const onTemp = (await getState()).activeFile!.path;
      await answerNextSaveDialog(kept);
      await saveWhenEnabled();

      await browser.waitUntil(async () => existsSync(kept), {
        timeout: 40_000,
        timeoutMsg: 'File ▸ Save in the second window never reached the Save As picker',
      });
      expect(await takenSaveDialogDefault()).not.toBeNull();

      // Save As wrote a COPY: the download is still on its scratch path, and
      // nothing was written over it.
      const state = await getState();
      expect(state.activeFile?.path).toBe(onTemp);
      expect(state.activeFile?.path).not.toBe(kept);
    });
  });
});
