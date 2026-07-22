import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  invokeAppCommand,
  documentJsSet,
  documentJsList,
} from '../support/harness.js';

// Phase 9.S6 — the Document JavaScript editor against the real binary. The
// editor reads and REWRITES the /Names /JavaScript name tree as text; it never
// runs the scripts. Saving routes through the undoable in-place workspace flow,
// so a change lands on the working copy and Ctrl+Z reverts it. Proof: empty →
// set a script (round-trips through the engine) → undo → empty again.

describe('document JavaScript editor (Phase 9.S6)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-docjs-'));
    source = resolve(tmp, 'doc.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    writeFileSync(source, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('edits document JavaScript in place, and undo reverts it', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('document_js'); // mounts the panel (registers the hooks)

    // Starts with no document scripts.
    expect(await documentJsList()).toHaveLength(0);

    // Set one script — undoable, in place (no new file).
    await documentJsSet([{ name: 'Init', js: 'app.alert("hello from open");' }]);
    const after = await documentJsList();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Init');
    expect(after[0].js).toContain('hello from open');

    // Undo returns the document to no scripts.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await documentJsList()).length === 0, {
      timeout: 15_000,
      timeoutMsg: 'undo did not remove the document JavaScript',
    });
  });

  it('refuses duplicate script names', async () => {
    await expect(
      documentJsSet([
        { name: 'Dup', js: 'a();' },
        { name: 'Dup', js: 'b();' },
      ]),
    ).rejects.toThrow();
  });
});
