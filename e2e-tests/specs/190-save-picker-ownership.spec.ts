import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, openByPaths, setActiveOp, setView, waitForHarness } from '../support/harness.js';

describe('a save-picker answer authorizes one export', () => {
  it('rapid Encrypt clicks dispatch one real write and leave the source unchanged', async () => {
    await waitForHarness(); await closeAllFiles();
    const directory = mkdtempSync(resolve(__dirname, '../../save-picker.local.d-'));
    const source = resolve(directory, 'source.pdf'), output = resolve(directory, 'encrypted.pdf');
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
    const bytes = await pdf.save(); writeFileSync(source, bytes);
    await openByPaths([source]); await setView('operations'); await setActiveOp('encrypt');
    await $('[data-testid="encrypt-run"]').waitForDisplayed({ timeout: 20000 });
    await $('input[type="password"]').setValue('fixture');
    // Intercept only the native dialog's custom-protocol response, BELOW the
    // production bridge and immutable Tauri invoke function. Do not log IPC
    // headers. The app handler, engine call and actual write still run.
    await browser.execute(() => {
      const w = window as any, native = window.fetch;
      const saveUrl = w.__TAURI_INTERNALS__.convertFileSrc('save_file_dialog', 'ipc');
      const engineUrl = w.__TAURI_INTERNALS__.convertFileSrc('send_to_engine', 'ipc');
      w.__pickerProbe = { native, dialogs: 0, writes: 0, answer: null };
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === saveUrl) {
          w.__pickerProbe.dialogs++;
          return new Promise(resolve => {
            w.__pickerProbe.answer = (path: string) => resolve(new Response(JSON.stringify(path), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }));
          });
        }
        if (String(input) === engineUrl && typeof init?.body === 'string'
            && JSON.parse(init.body)?.request?.method === 'encrypt') w.__pickerProbe.writes++;
        return native.call(window, input, init);
      };
    });
    try {
      await browser.execute(() => {
        const button = document.querySelector('[data-testid="encrypt-run"]') as HTMLButtonElement;
        button.click(); button.click();
      });
      expect(await browser.execute(() => ({
        dialogs: (window as any).__pickerProbe.dialogs,
        password: (document.querySelector('input[type="password"]') as HTMLInputElement)?.value,
        status: document.querySelector('[data-testid="status-bar"]')?.textContent,
      }))).toMatchObject({ dialogs: 1, password: 'fixture' });
      await browser.execute((path: string) => (window as any).__pickerProbe.answer(path), output);
      await browser.waitUntil(async () => existsSync(output)
        && await $('[data-testid="encrypt-run"]').isEnabled(),
      { timeout: 30000, timeoutMsg: 'real encryption did not finish' });
      expect(await browser.execute(() => (window as any).__pickerProbe.writes)).toBe(1);
      expect(Buffer.compare(readFileSync(source), Buffer.from(bytes))).toBe(0);
      expect(readFileSync(output).length).toBeGreaterThan(0);
    } finally {
      await browser.execute(() => {
        const w = window as any;
        if (w.__pickerProbe) { window.fetch = w.__pickerProbe.native; delete w.__pickerProbe; }
      });
      await closeAllFiles();
    }
  });
});
