// Remove Hidden Information, end to end.
//
// The assertions a unit test cannot make:
//   · the audit runs on its own when the panel opens, and it WRITES NOTHING —
//     the document is unchanged after it has reported what is in it,
//   · the checkbox decides: an unchecked category comes back with the same
//     count it started with,
//   · the automatic re-audit is what reports the result, so a category that
//     did not clear would show a residue rather than a success message,
//   · and ONE Ctrl+Z restores the whole pass, which is what proves the apply
//     is a single operation on the undo stack.
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  focusTab,
  invokeAppCommand,
  closeAllFiles,
  pressGlobalKey,
  signActiveFileInPlace,
  verifyActiveSignatures,
} from '../support/harness.js';

const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

/** A document carrying one instance of each class the report names.
 *
 * The second embedded file rides a /FileAttachment ANNOTATION rather than the
 * catalog's name tree, which is the case a name-tree walk under-reports. */
async function makeCarrier(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  page.drawText('Visible paragraph one.', { x: 72, y: 720, size: 12, font });
  page.drawText('WHITE ON WHITE TEXT', { x: 72, y: 660, size: 12, font, color: rgb(1, 1, 1) });
  page.drawText('TEXT UNDER A BOX', { x: 72, y: 600, size: 12, font });
  page.drawRectangle({
    x: 60,
    y: 590,
    width: 300,
    height: 26,
    color: rgb(0.9, 0.9, 0.9),
  });
  page.drawText('Visible paragraph two.', { x: 72, y: 540, size: 12, font });

  doc.setTitle('Quarterly results DRAFT');
  doc.setAuthor('Jane Doe');
  await doc.attach(new TextEncoder().encode('secret name-tree payload bytes'), 'names-payload.txt', {
    mimeType: 'text/plain',
  });

  const ctx = doc.context;
  const embedded = ctx.register(
    ctx.flateStream(new TextEncoder().encode('secret annotation payload bytes'), {
      Type: 'EmbeddedFile',
    }),
  );
  const spec = ctx.register(
    ctx.obj({
      Type: 'Filespec',
      F: PDFString.of('annot-payload.txt'),
      UF: PDFString.of('annot-payload.txt'),
      EF: ctx.obj({ F: embedded }),
    }),
  );
  const attachment = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [500, 600, 520, 620],
      FS: spec,
      Contents: PDFString.of('see attached'),
      T: PDFString.of('A. Reviewer'),
    }),
  );
  const note = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [400, 700, 420, 720],
      Contents: PDFString.of('Confirm the figures before release.'),
      T: PDFString.of('A. Reviewer'),
    }),
  );
  const link = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [72, 470, 200, 486],
      A: ctx.obj({ S: 'URI', URI: PDFString.of('https://intranet.example.invalid/secret') }),
    }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([note, attachment, link]));

  writeFileSync(path, await doc.save());
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

async function reportedCount(id: string): Promise<number> {
  const text = await browser.execute(
    (s: string) => document.querySelector(s)?.textContent ?? '',
    `[data-testid="sanitize-count-${id}"]`,
  );
  return Number(text);
}

async function waitForCount(id: string, expected: number, message: string): Promise<void> {
  await browser.waitUntil(async () => (await reportedCount(id)) === expected, {
    timeout: 30_000,
    interval: 200,
    timeoutMsg: message,
  });
}

async function detailLines(id: string): Promise<string[]> {
  await clickEl(`[data-testid="sanitize-details-${id}"]`);
  const el = await $(`[data-testid="sanitize-detail-${id}"]`);
  await el.waitForExist({ timeout: 20_000 });
  return browser.execute(
    (s: string) =>
      Array.from(document.querySelectorAll(`${s} li`)).map((n) => n.textContent ?? ''),
    `[data-testid="sanitize-detail-${id}"]`,
  );
}

describe('Remove Hidden Information', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f16-'));
    source = resolve(tmp, 'carrier.pdf');
    await makeCarrier(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports what the document carries, removes only what is checked, and undoes as one act', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    await focusTab({ doc: source });

    const before = statSync(source);
    expect(await invokeAppCommand('tools.panel.sanitize')).toBe(true);
    await $('[data-testid="sanitize-panel"]').waitForDisplayed({ timeout: 20_000 });

    // The audit runs on its own when the panel opens.
    await waitForCount('embedded_files', 2, 'the report never named both embedded files');
    await waitForCount('hidden_text', 2, 'the report never named the hidden text');
    expect(await reportedCount('comments')).toBe(2);
    expect(await reportedCount('links_and_actions')).toBe(1);
    expect(await reportedCount('metadata')).toBeGreaterThan(0);

    // Reading a document does not change it.
    expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(source).size).toBe(before.size);

    // The second embedded file is the one a name-tree walk misses, and the
    // report says how it is reached.
    const files = await detailLines('embedded_files');
    expect(files.join(' ')).toContain('names-payload.txt');
    expect(files.join(' ')).toContain('annot-payload.txt');
    expect(files.join(' ')).toContain('annotation');
    const hidden = await detailLines('hidden_text');
    expect(hidden.join(' ')).toContain('WHITE ON WHITE TEXT');
    expect(hidden.join(' ')).toContain('TEXT UNDER A BOX');

    // Nothing is checked by default, so there is nothing to apply.
    expect(await $('[data-testid="sanitize-apply"]').isEnabled()).toBe(false);

    for (const id of ['metadata', 'hidden_text', 'links_and_actions']) {
      await clickEl(`[data-testid="sanitize-check-${id}"]`);
    }
    await clickEl('[data-testid="sanitize-apply"]');

    // The automatic re-audit is what reports the result.
    await $('[data-testid="sanitize-comparison"]').waitForExist({ timeout: 30_000 });
    await waitForCount('metadata', 0, 'metadata was not cleared');
    await waitForCount('hidden_text', 0, 'the hidden text was not cleared');
    await waitForCount('links_and_actions', 0, 'the link was not cleared');
    // The unchecked categories are untouched.
    expect(await reportedCount('comments')).toBe(2);
    expect(await reportedCount('embedded_files')).toBe(2);
    // A cleared category reports no residue.
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-testid^="sanitize-residue-"]').length,
      ),
    ).toBe(0);

    // ONE undo puts the whole pass back.
    await pressGlobalKey('z', { ctrl: true });
    await waitForCount('hidden_text', 2, 'one undo did not restore the hidden text');
    await waitForCount('links_and_actions', 1, 'one undo did not restore the link');
    expect(await reportedCount('embedded_files')).toBe(2);
  });

  it('leaves the document untouched when the checked set is applied to a second file', async () => {
    // A second document proves the panel re-audits per file rather than
    // carrying the previous report's selection into it.
    const second = resolve(tmp, 'plain.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText('nothing hidden here', { x: 20, y: 200, size: 12, font });
    writeFileSync(second, await doc.save());

    await closeAllFiles();
    await openByPaths([second]);
    await setView('canvas');
    await focusTab({ doc: second });
    expect(await invokeAppCommand('tools.panel.sanitize')).toBe(true);
    await $('[data-testid="sanitize-panel"]').waitForDisplayed({ timeout: 20_000 });

    await waitForCount('embedded_files', 0, 'a clean document reported an embedded file');
    await waitForCount('hidden_text', 0, 'a clean document reported hidden text');
    // A clean category shows as zero rather than as an absent row.
    expect(await $('[data-testid="sanitize-row-thumbnails"]').isExisting()).toBe(true);
    expect(await $('[data-testid="sanitize-apply"]').isEnabled()).toBe(false);
    expect(readFileSync(second).length).toBeGreaterThan(0);
  });

  it('warns before removing anything from a signed document, and proceeds when told to', async () => {
    // A clean-up is a full rewrite by construction, so it breaks a signature.
    // The count is named BEFORE the choice, and the choice is the user's.
    const signed = resolve(tmp, 'signed.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 400]).drawText('INVISIBLE', {
      x: 20,
      y: 200,
      size: 12,
      font,
      color: rgb(1, 1, 1),
    });
    doc.setTitle('a signed draft');
    writeFileSync(signed, await doc.save());

    await closeAllFiles();
    await openByPaths([signed]);
    await setView('operations');
    await setActiveOp('signatures');
    expect(
      (await signActiveFileInPlace({ pfxPath: TEST_PFX, password: TEST_PFX_PASSWORD }))
        .signature_count,
    ).toBe(1);

    await setView('canvas');
    await focusTab({ doc: signed });
    expect(await invokeAppCommand('tools.panel.sanitize')).toBe(true);
    await $('[data-testid="sanitize-panel"]').waitForDisplayed({ timeout: 20_000 });
    await waitForCount('signatures', 1, 'the report never named the signature');
    await $('[data-testid="sanitize-signed"]').waitForExist({ timeout: 20_000 });

    await clickEl('[data-testid="sanitize-check-metadata"]');
    await clickEl('[data-testid="sanitize-apply"]');

    // The warning names the signature count and waits.
    const message = await $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 20_000 });
    expect(await message.getText()).toContain('1');
    await clickEl('[data-testid="confirm-affirm"]');

    await waitForCount('metadata', 0, 'the signed document was not cleaned after the warning');
    // The warning promised the signature would break, and it did. The verify
    // reads through the signatures panel, so it is mounted again first.
    await setView('operations');
    await setActiveOp('signatures');
    expect((await verifyActiveSignatures()).all_valid).toBe(false);
  });
});
