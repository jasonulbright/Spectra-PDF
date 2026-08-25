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

// ── the fixture document ──────────────────────────────────────────────────

/**
 * A form whose buttons carry real `/SubmitForm` actions, authored straight
 * into the file rather than through this app's own writer: a submission
 * button is something a DOCUMENT arrives carrying, and the consent boundary
 * has to hold for one this app never wrote.
 *
 * `/Flags` 0 is FDF by POST — the format the payload preview shows as text,
 * which is what makes "the exact bytes" assertable.
 */
async function makeSubmitFixture(path: string, destinations: Record<string, string>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const context = doc.context;

  const name = form.createTextField('Name');
  name.addToPage(page, { x: 50, y: 340, width: 200, height: 22 });
  name.setText('typed-by-the-user');

  let y = 300;
  for (const [field, url] of Object.entries(destinations)) {
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
          Flags: 0,
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
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, url);
    }

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

    /** Give the downloaded document an unsaved change, so File ▸ Save is
     * enabled at all — Save is disabled on a document nothing has touched. */
    async function dirtyTheDocument(): Promise<void> {
      await setView('canvas');
      const pages = await getWorkspacePageIds();
      await selectCanvasPages([pages[0]]);
      await rotateSelectedCanvasPages(90);
      await browser.waitUntil(async () => (await getState()).activeFile !== null, {
        timeout: 20_000,
        timeoutMsg: 'the rotate never settled',
      });
    }

    it('routes Save on the downloaded document to Save As, every time', async () => {
      await dirtyTheDocument();
      const kept = resolve(tmp, 'kept-from-the-web.pdf');
      await answerNextSaveDialog(kept);
      expect(await invokeAppCommand('file.save')).toBe(true);

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
      expect(await invokeAppCommand('file.save')).toBe(true);
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
});
