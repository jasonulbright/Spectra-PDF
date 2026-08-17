/**
 * P35 — Create PDF from the clipboard, and from a web page.
 *
 * The clipboard image is seeded by the PRODUCT'S OWN WRITE PATH: spec 132
 * drives the snapshot tool, which publishes `CF_DIB` + `PNG` in one clipboard
 * session; the same gesture runs here and Create PDF then reads it back. So
 * the seed needs no harness of its own and the two halves of the clipboard
 * are proved against each other.
 *
 * Text and HTML have no in-app writer, so they are seeded from OUTSIDE the
 * app with PowerShell against the real Windows clipboard — which is what a
 * user's other application is. Nothing is added to the product to make the
 * test possible.
 *
 * The assertion that matters most is the third: an HTML fragment carrying a
 * REMOTE `<img>` is converted against a LIVE local listener and must produce
 * ZERO hits. Headless LibreOffice fetches a remote reference unless its
 * profile is seeded against it, so a pasted fragment gets that measured
 * end to end rather than asserted about.
 *
 * The web capture runs for real against a `file://` fixture — the whole
 * WebView2 `PrintToPdf` route, on this machine, without leaving it.
 */
import { resolve } from 'node:path';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  invokeAppCommand,
  closeAllFiles,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const TOKEN = 'CLIPWEB-9713';

interface ClipboardRead {
  path: string;
  kind: string;
  format: string;
}

interface CapturedPage {
  url: string;
  title: string;
  path: string;
}

interface CaptureRun {
  pages: CapturedPage[];
  visited: number;
  truncated: boolean;
  failures: string[];
}

async function addClipboard(): Promise<ClipboardRead | null> {
  return browser.executeAsync<ClipboardRead | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.createPdfAddClipboard()
      .then((r: ClipboardRead | null) => done(r))
      .catch(() => done(null));
  });
}

async function createPdfRun(
  sources: string[],
  output: string,
  options?: Record<string, unknown>,
): Promise<{ output: string; pages: number } | null> {
  return browser.executeAsync<{ output: string; pages: number } | null, [string[], string, unknown]>(
    function (srcs, out, opts, done) {
      (window as any).__SPECTRA_TEST__.createPdfRun(srcs, out, opts ?? undefined)
        .then((r: { output: string; pages: number } | null) => done(r))
        .catch(() => done(null));
    },
    sources,
    output,
    options ?? null,
  );
}

async function convertCurrent(
  output: string,
  options?: Record<string, unknown>,
): Promise<{ output: string; pages: number } | null> {
  return browser.executeAsync<{ output: string; pages: number } | null, [string, unknown]>(
    function (out, opts, done) {
      (window as any).__SPECTRA_TEST__.createPdfConvertCurrent(out, opts ?? undefined)
        .then((r: { output: string; pages: number } | null) => done(r))
        .catch(() => done(null));
    },
    output,
    options ?? null,
  );
}

async function webCaptureRun(request: Record<string, unknown>): Promise<CaptureRun | null> {
  return browser.executeAsync<CaptureRun | null, [unknown]>(function (req, done) {
    (window as any).__SPECTRA_TEST__.webCaptureRun(req)
      .then((r: CaptureRun | null) => done(r))
      .catch(() => done(null));
  }, request);
}

async function readPdf(
  path: string,
): Promise<{ pages: number; boxes: number[][]; text: string; outline: string[] }> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
  }).promise;
  const boxes: number[][] = [];
  let text = '';
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const [, , width, height] = page.view as number[];
    boxes.push([Math.round(width), Math.round(height)]);
    const content = await page.getTextContent();
    text += (content.items as { str?: string }[]).map((item) => item.str ?? '').join(' ');
  }
  const pages = pdf.numPages;
  const items = ((await pdf.getOutline()) ?? []) as { title?: string }[];
  const outline = items.map((item) => item.title ?? '');
  await pdf.loadingTask.destroy();
  return { pages, boxes, text, outline };
}

/** Run a PowerShell snippet against the real Windows clipboard. */
function powershell(script: string): void {
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'pipe', timeout: 60_000 },
  );
}

function seedClipboardText(text: string): void {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  powershell(
    `Add-Type -AssemblyName System.Windows.Forms;` +
      `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));` +
      `[Windows.Forms.Clipboard]::SetText($t);`,
  );
}

/**
 * Seed a real `CF_HTML` payload — header offsets and all.
 *
 * `Clipboard::SetText($html, 'Html')` builds the CF_HTML wrapper itself, so
 * the offsets the Rust parser reads are Windows' own, not ones this spec
 * computed to match its own parser.
 */
function seedClipboardHtml(html: string): void {
  const encoded = Buffer.from(html, 'utf8').toString('base64');
  powershell(
    `Add-Type -AssemblyName System.Windows.Forms;` +
      `$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));` +
      `[Windows.Forms.Clipboard]::SetText($h,[Windows.Forms.TextDataFormat]::Html);`,
  );
}

function emptyClipboard(): void {
  powershell(`Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.Clipboard]::Clear();`);
}

/** Run a PowerShell snippet and hand back what it wrote to stdout. */
function powershellOut(script: string): string {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'pipe', timeout: 60_000 },
  )
    .toString()
    .trim();
}

const USER32 = `
Add-Type -Namespace E2E -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr p);
'@;
$found = [System.Collections.ArrayList]::new();
$cb = [E2E.W+EnumProc]{ param($h,$p)
  $sb = New-Object System.Text.StringBuilder 512;
  [void][E2E.W]::GetWindowTextW($h, $sb, 512);
  if ($sb.ToString().StartsWith('Capturing')) { [void]$found.Add($h) }
  return $true };
[void][E2E.W]::EnumWindows($cb, [IntPtr]::Zero);
`;

/** How many top-level windows the capture titles its own. */
function captureWindowCount(): number {
  return Number(powershellOut(`${USER32} $found.Count`));
}

/**
 * Close the capture window the way a user does — a real `WM_CLOSE` at the
 * window, not a WebDriver close.
 *
 * `WM_CLOSE` is what the title-bar button and Alt+F4 both produce, and it is
 * what the capture's own window subclass intercepts. A driver close enters
 * further up, through the app's window-event path, and would leave the
 * subclass — the thing that makes a close a cancel — untested.
 */
function closeCaptureWindow(): boolean {
  const posted = powershellOut(
    `${USER32} foreach ($h in $found) { [void][E2E.W]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }; $found.Count`,
  );
  return Number(posted) > 0;
}

/** Wait until the driver reports exactly `count` window handles. */
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

/**
 * Serve an index that links to pages which answer slowly, so a crawl is long
 * enough to be observed and interrupted while it runs.
 */
async function slowSite(delayMs: number): Promise<{ server: Server; port: number }> {
  let port = 0;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const body =
      path === '/'
        ? '<!DOCTYPE html><html><head><title>Slow Index</title></head><body>' +
          ['a', 'b', 'c', 'd', 'e', 'f']
            .map((name) => `<a href="/${name}">${name}</a>`)
            .join('') +
          '</body></html>'
        : `<!DOCTYPE html><html><head><title>Slow ${path}</title></head><body>${path}</body></html>`;
    setTimeout(
      () => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      },
      path === '/' ? 0 : delayMs,
    );
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });
  return { server, port };
}

/** Start a capture and DO NOT wait for it: the page keeps the promise. */
async function startCaptureDetached(request: Record<string, unknown>): Promise<void> {
  await browser.execute(function (req) {
    (window as any).__captureOutcome = 'pending';
    (window as any).__SPECTRA_TEST__.webCaptureRun(req)
      .then((r: unknown) => {
        (window as any).__captureOutcome = r === null ? 'cancelled' : 'captured';
      })
      .catch(() => {
        (window as any).__captureOutcome = 'error';
      });
  }, request);
}

async function captureOutcome(): Promise<string> {
  return browser.execute(function () {
    return (window as any).__captureOutcome ?? 'absent';
  });
}

async function makePdfFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('SNAPSHOT ME', { x: 60, y: 500, size: 24, font });
  writeFileSync(path, await doc.save());
}

describe('create PDF from the clipboard and from a web page', () => {
  let tmp: string;
  let listener: Server | null = null;
  let listenerPort = 0;
  let hits: string[] = [];

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p35-'));
    await new Promise<void>((done) => {
      listener = createServer((req, res) => {
        hits.push(req.url ?? '');
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(
          Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
              '0000000a49444154789c6360000002000100fdff03fd0000000049454e44ae426082',
            'hex',
          ),
        );
      });
      listener.listen(0, '127.0.0.1', () => {
        listenerPort = (listener!.address() as { port: number }).port;
        done();
      });
    });
    await waitForHarness();
    await closeAllFiles();
  });

  after(() => {
    if (listener) listener.close();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('an image on the clipboard becomes a PDF page', async () => {
    // Seeded by the product's OWN write path: the snapshot tool publishes
    // CF_DIB + PNG, and Create PDF reads that back.
    const source = resolve(tmp, 'src.pdf');
    await makePdfFixture(source);
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelector('[data-page-id]') !== null)) === true,
      { timeout: 20_000, timeoutMsg: 'no page cell appeared' },
    );
    expect(await invokeAppCommand('tools.open.snapshot')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'snapshot', {
      timeout: 10_000,
      timeoutMsg: 'the snapshot mode never armed',
    });
    const pr = (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number };
    const at = (fx: number, fy: number): { x: number; y: number } => ({
      x: Math.round(pr.x + pr.w * fx),
      y: Math.round(pr.y + pr.h * fy),
    });
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(at(0.2, 0.2))
      .down()
      .pause(80)
      .move(at(0.4, 0.35))
      .pause(80)
      .move(at(0.6, 0.5))
      .pause(80)
      .up()
      .perform();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[data-testid="snapshot-placement"]') !== null,
        )) === true,
      { timeout: 25_000, timeoutMsg: 'the drag left no snapshot card' },
    );

    // Now read it back through Create PDF.
    await closeAllFiles();
    expect(await invokeAppCommand('file.createPdf')).toBe(true);
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 15_000 });
    const clip = await addClipboard();
    expect(clip).not.toBeNull();
    expect(clip!.kind).toBe('image');
    // The write side publishes both formats; the read side prefers PNG.
    expect(['PNG', 'CF_DIB']).toContain(clip!.format);
    expect(existsSync(clip!.path)).toBe(true);

    // The row is on the list, badged by the ENGINE's own classification.
    const rowKind = await browser.execute(function () {
      const rows = document.querySelectorAll('[data-testid="create-pdf-row"]');
      const last = rows[rows.length - 1];
      return last ? last.getAttribute('data-kind') : null;
    });
    expect(rowKind).toBe('image');

    const out = resolve(tmp, 'clip-image.pdf');
    const result = await createPdfRun([clip!.path], out);
    expect(result).not.toBeNull();
    expect(result!.pages).toBe(1);
    const read = await readPdf(out);
    expect(read.pages).toBe(1);
    // A captured region is wider than it is tall here, and the page must
    // follow the raster rather than land on a paper default.
    expect(read.boxes[0][0]).toBeGreaterThan(read.boxes[0][1]);
    await $('[data-testid="create-pdf-close"]').click();
  });

  it('text on the clipboard becomes a PDF page', async () => {
    seedClipboardText(`${TOKEN}\r\nsecond line of the pasted note\r\n`);
    expect(await invokeAppCommand('file.createPdf')).toBe(true);
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 15_000 });
    const clip = await addClipboard();
    expect(clip).not.toBeNull();
    expect(clip!.kind).toBe('text');
    expect(clip!.format).toBe('CF_UNICODETEXT');
    // `.txt` is already an accepted source, so a pasted note and a dropped
    // one produce the SAME document — the reason this route was chosen.
    expect(clip!.path.endsWith('.txt')).toBe(true);

    const out = resolve(tmp, 'clip-text.pdf');
    const result = await createPdfRun([clip!.path], out);
    expect(result).not.toBeNull();
    const read = await readPdf(out);
    expect(read.pages).toBeGreaterThanOrEqual(1);
    expect(read.text).toContain(TOKEN);
    await $('[data-testid="create-pdf-close"]').click();
  });

  it('an HTML fragment referencing a remote image does NOT fetch it', async () => {
    hits = [];
    seedClipboardHtml(
      `<p><b>${TOKEN}</b></p>` +
        `<table border=1><tr><td>a</td><td>b</td></tr></table>` +
        `<img src="http://127.0.0.1:${listenerPort}/remote.png" width=40 height=40>`,
    );
    expect(await invokeAppCommand('file.createPdf')).toBe(true);
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 15_000 });
    const clip = await addClipboard();
    expect(clip).not.toBeNull();
    expect(clip!.kind).toBe('html');
    expect(clip!.format).toBe('CF_HTML');

    const out = resolve(tmp, 'clip-html.pdf');
    const result = await createPdfRun([clip!.path], out);
    expect(result).not.toBeNull();
    const read = await readPdf(out);
    expect(read.text).toContain(TOKEN);
    // The listener is LIVE and reachable — a fetch would have landed.
    await browser.pause(1200);
    expect(hits).toEqual([]);
    await $('[data-testid="create-pdf-close"]').click();
  });

  it('an empty clipboard refuses by name instead of adding a blank row', async () => {
    emptyClipboard();
    expect(await invokeAppCommand('file.createPdf')).toBe(true);
    await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({ timeout: 15_000 });
    expect(await addClipboard()).toBeNull();
    const error = await $('[data-testid="create-pdf-error"]');
    await error.waitForDisplayed({ timeout: 10_000 });
    expect((await error.getText()).length).toBeGreaterThan(10);
    await $('[data-testid="create-pdf-close"]').click();
  });

  it('the web capture dialog states the host it will contact', async () => {
    expect(await invokeAppCommand('file.createFromWebPage')).toBe(true);
    await $('[data-testid="web-capture-dialog"]').waitForDisplayed({ timeout: 15_000 });
    // The posture is on the page, not in a doc nobody reads.
    expect((await $('[data-testid="web-capture-posture"]').getText()).length).toBeGreaterThan(80);
    await $('[data-testid="web-capture-url"]').setValue('example.test/a');
    const target = await $('[data-testid="web-capture-target"]');
    await target.waitForDisplayed({ timeout: 10_000 });
    expect(await target.getText()).toContain('example.test');
    // The capture button is live only once there is an address.
    expect(await $('[data-testid="web-capture-run"]').isEnabled()).toBe(true);
  });

  it('a scheme the gate refuses never opens a window', async () => {
    // The dialog from the previous case is still up.
    const result = await webCaptureRun({ url: 'javascript:alert(1)' });
    expect(result).toBeNull();
    const error = await $('[data-testid="web-capture-error"]');
    await error.waitForDisplayed({ timeout: 10_000 });
    expect(await error.getText()).toContain('javascript');
  });

  it('captures a real page through the browser and bookmarks it', async () => {
    // A file:// fixture: the whole WebView2 PrintToPdf route runs for real,
    // on this machine, without leaving it.
    const page = resolve(tmp, 'capture.html');
    writeFileSync(
      page,
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<title>Captured Fixture</title></head><body>' +
        `<h1>${TOKEN}</h1><p>A local page, captured by the browser.</p>` +
        '</body></html>',
      'utf8',
    );
    const url = pathToFileURL(page).href;
    const result = await webCaptureRun({ url, depth: 0, maxPages: 1 });
    expect(result).not.toBeNull();
    expect(result!.failures).toEqual([]);
    expect(result!.pages.length).toBe(1);
    expect(result!.pages[0].title).toBe('Captured Fixture');
    expect(existsSync(result!.pages[0].path)).toBe(true);

    // The capture window is created and destroyed by the command; the main
    // window is still the one being driven.
    expect(await $('[data-testid="create-pdf-dialog"]').isExisting()).toBe(true);

    const captured = await readPdf(result!.pages[0].path);
    expect(captured.pages).toBe(1);
    expect(captured.text).toContain(TOKEN);

    // ...and through the shipped door, where the captured link structure
    // lands as a bookmark. `convertCurrent` — not the injected run, which
    // replaces the rows and with them everything that says where a row came
    // from.
    const out = resolve(tmp, 'captured.pdf');
    const built = await convertCurrent(out);
    expect(built).not.toBeNull();
    expect(built!.pages).toBe(1);
    const assembled = await readPdf(out);
    expect(assembled.text).toContain(TOKEN);
    expect(assembled.outline).toEqual(['Captured Fixture']);
  });

  it('closing the capture window cancels the crawl and takes the window with it', async () => {
    // The previous case handed its capture up, which closes this dialog.
    if (await $('[data-testid="create-pdf-close"]').isExisting()) {
      await $('[data-testid="create-pdf-close"]').click();
    }
    expect(await invokeAppCommand('file.createFromWebPage')).toBe(true);
    await $('[data-testid="web-capture-dialog"]').waitForDisplayed({ timeout: 15_000 });

    // A crawl slow enough to be interrupted: the index answers at once, every
    // linked page stalls, so the close lands while a navigation is in flight.
    const { server: slow, port } = await slowSite(4000);

    try {
      expect(captureWindowCount()).toBe(0);

      // Started, NOT awaited: the close has to land while the crawl is running.
      const running = webCaptureRun({
        url: `http://127.0.0.1:${port}/`,
        depth: 1,
        maxPages: 6,
      });

      // The close is posted to a window that has to EXIST to receive it, and
      // the crawl creates it asynchronously — so the post is retried until one
      // takes it, and a run where none ever did fails here rather than going
      // on to read a cancellation that nothing asked for.
      await browser.waitUntil(async () => closeCaptureWindow(), {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: 'the capture window never appeared',
      });

      // Cancelled, not hung, and not a partial run handed up as a finished
      // one: the dialog reports the cancellation and adds nothing.
      const result = await running;
      expect(result).toBeNull();

      const notice = await $('[data-testid="web-capture-notice"]');
      await notice.waitForDisplayed({ timeout: 10_000 });
      expect((await notice.getText()).length).toBeGreaterThan(0);
      expect(await $('[data-testid="web-capture-error"]').isExisting()).toBe(false);

      // Destroyed on the cancellation path, like every other exit path.
      await browser.waitUntil(async () => captureWindowCount() === 0, {
        timeout: 15_000,
        timeoutMsg: 'the capture window outlived the capture it was cancelled with',
      });

      // The app is still there: the capture window's close is not a workspace
      // window's close, so nothing quit and nothing was prompted about.
      expect(await $('[data-testid="web-capture-dialog"]').isDisplayed()).toBe(true);
      expect((await browser.getWindowHandles()).length).toBeGreaterThan(0);

      // And a second capture still starts — the cancel did not leave the
      // one-at-a-time guard latched.
      const page = resolve(tmp, 'after-cancel.html');
      writeFileSync(
        page,
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>After Cancel</title>' +
          `</head><body><h1>${TOKEN}</h1></body></html>`,
        'utf8',
      );
      const second = await webCaptureRun({
        url: pathToFileURL(page).href,
        depth: 0,
        maxPages: 1,
      });
      expect(second).not.toBeNull();
      expect(second!.pages.length).toBe(1);
    } finally {
      slow.close();
    }
  });

  it('a capture in one window does not withhold the other window\'s engine replies', async () => {
    // The capture borrows the window's own thread for each browser call and
    // waits for it elsewhere. Held for a whole crawl instead, that thread
    // stops delivering events app-wide — and engine replies are delivered as
    // events, so a second workspace would sit on a spinner for the length of
    // the crawl while its request had already been answered.
    const before = await browser.getWindowHandles();
    const mainHandle = before[0];
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const withSecond = await waitForHandles(before.length + 1);
    const secondHandle = withSecond.find((h) => !before.includes(h))!;

    // Warm the engine in the second window BEFORE the capture starts, so what
    // is timed below is one round trip and not a sidecar launch.
    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);
    await browser.executeAsync<null, []>(function (done) {
      (window as any).__SPECTRA_TEST__.waitForEngine(30000)
        .then(() => done(null))
        .catch(() => done(null));
    });
    await browser.switchToWindow(mainHandle);

    const { server: slow, port } = await slowSite(4000);
    try {
      if (await $('[data-testid="create-pdf-close"]').isExisting()) {
        await $('[data-testid="create-pdf-close"]').click();
      }
      expect(await invokeAppCommand('file.createFromWebPage')).toBe(true);
      await $('[data-testid="web-capture-dialog"]').waitForDisplayed({ timeout: 15_000 });

      await startCaptureDetached({ url: `http://127.0.0.1:${port}/`, depth: 1, maxPages: 6 });
      // Live, not merely requested.
      await browser.waitUntil(async () => captureWindowCount() > 0, {
        timeout: 30_000,
        timeoutMsg: 'the capture window never appeared',
      });

      await browser.switchToWindow(secondHandle);
      const started = Date.now();
      const failure = await browser.executeAsync<string | null, []>(function (done) {
        (window as any).__SPECTRA_TEST__.engineRequestWithId('ping', {}, 987654)
          .then(() => done(null))
          .catch((err: unknown) => done(String(err)));
      });
      const elapsed = Date.now() - started;
      expect(failure).toBeNull();
      // The crawl still has pages to fetch, each stalling 4s. A reply that had
      // been withheld could not come back inside a second.
      expect(elapsed).toBeLessThan(3000);

      // ...and prove the crawl really was still running when it answered,
      // rather than the reply having simply outlived a capture that ended.
      await browser.switchToWindow(mainHandle);
      expect(await captureOutcome()).toBe('pending');
      expect(captureWindowCount()).toBeGreaterThan(0);

      expect(closeCaptureWindow()).toBe(true);
      await browser.waitUntil(async () => (await captureOutcome()) === 'cancelled', {
        timeout: 30_000,
        timeoutMsg: 'the capture never reported its cancellation',
      });
      await browser.waitUntil(async () => captureWindowCount() === 0, {
        timeout: 15_000,
        timeoutMsg: 'the capture window outlived the capture it was cancelled with',
      });
    } finally {
      slow.close();
      // Leave one window behind so the session's final close is the ordinary
      // last-window teardown.
      await browser.switchToWindow(secondHandle);
      await browser.execute(() => {
        void (window as any).__SPECTRA_TEST__.closeThisWindow();
      });
      await browser.switchToWindow(mainHandle);
      await waitForHandles(1);
    }
  });
});
