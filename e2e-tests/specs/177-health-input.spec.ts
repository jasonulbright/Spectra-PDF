import { existsSync, mkdtempSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, openByPaths, setView, waitForHarness } from '../support/harness.js';

const scratch = resolve(tmpdir(), 'spectrapdf', 'batch-scratch');
const healthFiles = () => existsSync(scratch) ? readdirSync(scratch).filter((name) => name.startsWith('health_')) : [];
const toggle = '[data-testid="doc-health-toggle"]';
async function healthy() {
  await browser.waitUntil(async () => await $(toggle).getAttribute('data-verdict') === 'healthy', {
    timeout: 40_000, timeoutMsg: 'the clean displayed revision did not complete both health boundaries',
  });
}

describe('private background health input', () => {
  it('collects successfully through real scoped IPC and releases every private input on recheck', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await closeAllFiles();
    const oldFiles = new Set(healthFiles());
    const dir = mkdtempSync(resolve(__dirname, '../../docs/audit/health-input.local.d-'));
    const path = resolve(dir, 'clean.pdf');
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    writeFileSync(path, await pdf.save());
    await openByPaths([path]);
    await setView('canvas');
    await $(toggle).waitForDisplayed();
    await healthy();
    expect(healthFiles().filter((name) => !oldFiles.has(name))).toEqual([]);

    const observed = new Set<string>();
    const watcher = watch(scratch, (_event, filename) => {
      const name = filename?.toString();
      if (name?.startsWith('health_') && !oldFiles.has(name)) observed.add(name);
    });
    try {
      await $(toggle).click();
      await $('[data-testid="doc-health-recheck"]').click();
      await browser.waitUntil(async () => observed.size > 0, {
        timeout: 10_000, timeoutMsg: 'recheck did not create a separate health input',
      });
      await healthy();
      expect(healthFiles().filter((name) => !oldFiles.has(name))).toEqual([]);
    } finally {
      watcher.close();
      await closeAllFiles();
    }
  });
});
