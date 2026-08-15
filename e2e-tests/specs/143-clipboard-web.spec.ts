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
    isEvalSupported: false,
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
});
