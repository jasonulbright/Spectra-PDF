import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  getWorkspacePageIds,
  selectCanvasPages,
  invokeAppCommand,
  focusTab,
  commitPendingEdits,
} from '../support/harness.js';

// § I.6 Portfolio authoring: create (bridge-injected paths), the auto-open
// "opening a portfolio shows its members" story, open-member through the one
// open funnel, member CRUD, and THE CARRY LEG — a committed page edit must
// not strip /EmbeddedFiles//Collection (embedded-files-carry.ts; before it,
// one committed rotation deleted every attachment a document carried).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
// OS-temp scratch (the 71-scheduled-runs convention): per-run unique, never
// inside the repo. Assigned in `before`.
let SCRATCH = '';
let NOTE_V1 = '';
let NOTE_V2 = '';
let OUT = '';
let SAVED = '';

async function memberNames(): Promise<string[]> {
  const items = await $$('[data-testid="portfolio-item"]');
  const names: string[] = [];
  for (const item of await items) {
    names.push(await item.$('.text-neutral-200').getText());
  }
  return names;
}

describe('portfolio authoring (§ I.6)', () => {
  before(() => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-portfolio-'));
    NOTE_V1 = resolve(SCRATCH, 'e2e-note.txt');
    NOTE_V2 = resolve(SCRATCH, 'e2e-note-v2.txt');
    OUT = resolve(SCRATCH, 'e2e-folio.pdf');
    SAVED = resolve(SCRATCH, 'saved-back.txt');
    writeFileSync(NOTE_V1, 'portfolio note v1');
    writeFileSync(NOTE_V2, 'portfolio note v2 — updated contents');
  });

  it('creates a portfolio from files and the open auto-shows its members', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });

    // Mount the panel (registers the harness bridge); sample.pdf is not a
    // portfolio, so the panel shows the convert/create affordances.
    expect(await invokeAppCommand('tools.open.portfolio')).toBe(true);
    await $('[data-testid="portfolio-not"]').waitForDisplayed({
      timeoutMsg: 'portfolio panel did not show the not-a-portfolio state',
    });

    // Create with injected paths (native pickers are undrivable), then the
    // create flow opens the new file through the one open funnel — and the
    // auto-open story must land the Portfolio tool open on it.
    const err = await browser.executeAsync(
      function (out: string, sources: string[], done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .portfolioCreateRun(out, sources, 'E2E Bundle')
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      OUT,
      [NOTE_V1, SAMPLE_PDF],
    );
    expect(err).toBeNull();

    await browser.waitUntil(
      async () => {
        const s = await getState();
        return s.activeFile?.path === OUT && s.activeToolId === 'portfolio';
      },
      { timeout: 15_000, timeoutMsg: 'opening the new portfolio did not auto-open the Portfolio tool' },
    );

    await $('[data-testid="portfolio-members"]').waitForDisplayed({
      timeoutMsg: 'member list did not render',
    });
    expect(await $('[data-testid="portfolio-count"]').getText()).toContain('2 files');
    const names = await memberNames();
    expect(names).toContain('e2e-note.txt');
    expect(names).toContain('sample.pdf');
  });

  it('opens a PDF member as a real document through the open funnel', async () => {
    const before = await getState();
    const beforeCount = before.fileCount;

    await $('[data-testid="portfolio-open-sample.pdf"]').click();
    await browser.waitUntil(
      async () => {
        const s = await getState();
        return (
          s.fileCount === beforeCount + 1 &&
          s.activeFile !== null &&
          s.activeFile.path.includes('portfolio-members') &&
          // The managed dir never clobbers: a re-run extracts "sample (2).pdf".
          /^sample( \(\d+\))?\.pdf$/.test(s.activeFile.name)
        );
      },
      { timeout: 15_000, timeoutMsg: 'the member did not open as a real document' },
    );

    // Back to the portfolio for the remaining legs.
    await focusTab({ doc: OUT });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === OUT, {
      timeoutMsg: 'could not refocus the portfolio tab',
    });
  });

  it('adds, updates (round-tripped through extract), and removes members', async () => {
    // Add: the panel is open on the portfolio; inject the source path.
    const addErr = await browser.executeAsync(
      function (source: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .portfolioAddRun(source)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      NOTE_V2,
    );
    expect(addErr).toBeNull();
    await browser.waitUntil(
      async () => (await $('[data-testid="portfolio-count"]').getText()).includes('3 files'),
      { timeoutMsg: 'add did not reach 3 members' },
    );

    // Update e2e-note.txt from NOTE_V2's contents, then save it back OUT and
    // prove the bytes round-tripped (update really replaced the payload).
    const updErr = await browser.executeAsync(
      function (name: string, source: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .portfolioUpdateRun(name, source)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      'e2e-note.txt',
      NOTE_V2,
    );
    expect(updErr).toBeNull();

    const saveErr = await browser.executeAsync(
      function (name: string, out: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .portfolioSaveMemberRun(name, out)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      'e2e-note.txt',
      SAVED,
    );
    expect(saveErr).toBeNull();
    expect(readFileSync(SAVED, 'utf-8')).toBe('portfolio note v2 — updated contents');

    // Remove the added duplicate-content member; back to 2.
    await $('[data-testid="portfolio-remove-e2e-note-v2.txt"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="portfolio-count"]').getText()).includes('2 files'),
      { timeoutMsg: 'remove did not return to 2 members' },
    );
  });

  it('members survive a committed page edit (the embedded-files carry)', async () => {
    // Rotate the cover page in the page tier, then COMMIT (awaited — the
    // harness resolves when the rebuild lands). Before the carry, this exact
    // flow stripped every member from the file: without ownBytes threaded
    // into buildPdf, the leg below fails on an empty member list.
    const ids = await getWorkspacePageIds();
    await selectCanvasPages([ids[0]]);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits();

    const after = await getWorkspacePageIds();
    expect(after.length).toBe(ids.length); // rebuild kept the page structure

    // The panel refreshes on buffer change; both members must still be there.
    await browser.waitUntil(
      async () => {
        const count = await $('[data-testid="portfolio-count"]').getText();
        return count.includes('2 files');
      },
      { timeout: 15_000, timeoutMsg: 'members were lost by the committed page edit' },
    );
    const names = await memberNames();
    expect(names).toContain('e2e-note.txt');
    expect(names).toContain('sample.pdf');
  });
});
