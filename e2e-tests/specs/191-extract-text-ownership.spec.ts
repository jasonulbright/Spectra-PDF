import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { answerNextSaveDialog, closeAllFiles, focusTab, openByPaths, setActiveOp,
  setReactInputValue, setView, waitForHarness } from '../support/harness.js';

async function intercept(boundary: 'picker' | 'read') {
  await browser.execute((hold: string) => {
    const w = window as any, native = window.fetch;
    const save = w.__TAURI_INTERNALS__.convertFileSrc('save_file_dialog', 'ipc');
    const engine = w.__TAURI_INTERNALS__.convertFileSrc('send_to_engine', 'ipc');
    w.__extractProbe = { native, release: null, reads: 0, writes: 0 };
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === save && hold === 'picker') return new Promise(resolve => {
        w.__extractProbe.release = (path: string | null) => {
          w.__extractProbe.release = null;
          resolve(new Response(JSON.stringify(path), {
            headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
          }));
        };
      });
      if (String(input) === engine && typeof init?.body === 'string') {
        const method = JSON.parse(init.body)?.request?.method;
        if (method === 'export_document') w.__extractProbe.writes++;
        if (method === 'extract_text') {
          w.__extractProbe.reads++;
          if (hold === 'read') return new Promise((resolve, reject) => {
            w.__extractProbe.release = () => {
              w.__extractProbe.release = null;
              native.call(window, input, init).then(resolve, reject);
            };
          });
        }
      }
      return native.call(window, input, init);
    };
  }, boundary);
}
async function release(path?: string) {
  await browser.execute((answer?: string) => (window as any).__extractProbe.release?.(answer ?? null), path);
}

describe('Extract Text revision and output ownership', () => {
  let directory: string, a: string, b: string;
  beforeEach(async () => {
    await waitForHarness(); await closeAllFiles();
    directory = mkdtempSync(resolve(__dirname, '../../extract-ownership.local.d-'));
    a = resolve(directory, 'A.pdf'); b = resolve(directory, 'B.pdf');
    for (const [path, name] of [[a, 'ALPHA'], [b, 'BRAVO']]) {
      const pdf = await PDFDocument.create();
      pdf.addPage([300, 400]).drawText(`${name} first page`, { x: 20, y: 300, size: 12 });
      pdf.addPage([300, 400]).drawText(`${name} second page`, { x: 20, y: 300, size: 12 });
      writeFileSync(path, await pdf.save());
    }
    await openByPaths([a, b]); await focusTab({ doc: a });
    await setView('operations'); await setActiveOp('extract_text');
    await $('[data-testid="extract-text-run"]').waitForEnabled({ timeout: 20000 });
  });
  afterEach(async () => {
    await browser.execute(() => {
      const w = window as any, probe = w.__extractProbe;
      if (probe) { probe.release?.(null); window.fetch = probe.native; delete w.__extractProbe; }
    });
    await closeAllFiles();
  });
  it('switching documents clears the old preview and Save exports the displayed page selection', async () => {
    const beforeA = readFileSync(a), beforeB = readFileSync(b);
    await $('[data-testid="extract-text-run"]').click();
    await $('[data-testid="extract-text-result"]').waitForDisplayed();
    expect(await $('[data-testid="extract-text-result"]').getValue()).toContain('ALPHA');
    await focusTab({ doc: b });
    expect(await $('[data-testid="extract-text-result"]').isExisting()).toBe(false);
    expect(await $('[data-testid="extract-text-copy"]').isExisting()).toBe(false);
    await setReactInputValue('[data-testid="extract-text-pages"]', '2');
    await $('[data-testid="extract-text-run"]').click();
    await $('[data-testid="extract-text-result"]').waitForDisplayed();
    const preview = await $('[data-testid="extract-text-result"]').getValue();
    expect(preview).toContain('BRAVO second'); expect(preview).not.toContain('first');
    const output = resolve(directory, 'chosen.txt'); await answerNextSaveDialog(output);
    await $('[data-testid="extract-text-save"]').click();
    await browser.waitUntil(async () => existsSync(output) && await $('[data-testid="extract-text-save"]').isEnabled(), { timeout: 30000 });
    const exported = readFileSync(output, 'utf8'); expect(exported).toContain('BRAVO second');
    expect(exported).not.toContain('first'); expect(exported).not.toContain('ALPHA');
    expect(readFileSync(a).equals(beforeA)).toBe(true); expect(readFileSync(b).equals(beforeB)).toBe(true);
  });
  it('a Save answer cannot export after its document is replaced by another tab', async () => {
    await intercept('picker'); await $('[data-testid="extract-text-save"]').click();
    await browser.waitUntil(async () => browser.execute(() => !!(window as any).__extractProbe.release));
    await focusTab({ doc: b }); const output = resolve(directory, 'must-not-exist.txt');
    await release(output); await $('[data-testid="extract-text-save"]').waitForEnabled();
    expect(await browser.execute(() => (window as any).__extractProbe.writes)).toBe(0);
    expect(existsSync(output)).toBe(false);
  });
  it('a delayed real extraction cannot populate the newly selected document', async () => {
    await intercept('read'); await $('[data-testid="extract-text-run"]').click();
    await browser.waitUntil(async () => browser.execute(() => !!(window as any).__extractProbe.release));
    await focusTab({ doc: b }); await release();
    await $('[data-testid="extract-text-run"]').waitForEnabled({ timeout: 30000 });
    expect(await browser.execute(() => (window as any).__extractProbe.reads)).toBe(1);
    expect(await $('[data-testid="extract-text-result"]').isExisting()).toBe(false);
  });
});
