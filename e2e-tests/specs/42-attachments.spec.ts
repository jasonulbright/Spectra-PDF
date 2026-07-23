import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import { waitForHarness, openByPaths, setView, setActiveOp } from '../support/harness.js';

// The Attach and Save actions open native file dialogs (not driveable in e2e),
// but LIST (automatic) and REMOVE (a button) exercise the engine round trip
// without a dialog — the important wiring. The fixture carries an attachment
// embedded by pdf-lib.
async function makeFixtureWithAttachment(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.attach(new TextEncoder().encode('hello attachment'), 'notes.txt', {
    mimeType: 'text/plain',
    description: 'a note',
  });
  writeFileSync(path, await doc.save());
}

describe('attachments panel (I.6)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-attach-'));
    source = resolve(tmp, 'with-attachment.pdf');
    await makeFixtureWithAttachment(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists an embedded attachment and removes it through the engine', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('attachments');

    // The list shows the embedded file.
    const item = $('[data-testid="attach-item"]');
    await item.waitForDisplayed({ timeout: 20_000 });
    expect(await item.getText()).toContain('notes.txt');

    // Remove it → the panel re-lists (empty) after the engine round trip.
    await $('[data-testid="attach-remove-notes.txt"]').click();
    await $('[data-testid="attach-empty"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'attachment was not removed',
    });
  });
});
