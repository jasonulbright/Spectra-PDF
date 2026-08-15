// The droplet — a profile over a folder.
//
// The assertions that matter are the ones a unit test cannot make, because
// they are about a real tree on disk and a real engine run:
//   · a CHECK run writes one report per document and NOT ONE BYTE of any
//     source changes,
//   · a FIX run mirrors the repaired copies, its report is the state AFTER
//     the fixups, and a source outside the destination is untouched,
//   · the localized text and HTML reports land beside every JSON one — the
//     half a command-line run does not have,
//   · and the run log carries the prefix the retention sweep matches.
//
// It also drives the guided-action export at a path OUTSIDE the app's own
// temp tree, which is where the capability-scoped filesystem plugin stops.
// Spec 78 exports inside that tree deliberately, so nothing had ever driven
// the real destination a user picks.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  invokeAppCommand,
  closeAllFiles,
  openByPaths,
  getState,
  folderPreflightSetFolders,
  folderPreflightSetProfile,
  folderPreflightSetMode,
  folderPreflightRun,
  folderPreflightSnapshot,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

/** A document with an embedded file and no trim box — two findings a profile
 * can carry doors for, authored here so the spec owns what it asserts on. */
async function buildSource(path: string, withAttachment: boolean): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Droplet fixture', { x: 40, y: 700, size: 14, font });
  if (withAttachment) {
    await doc.attach(new Uint8Array([1, 2, 3, 4]), 'notes.bin', {
      mimeType: 'application/octet-stream',
    });
  }
  // A trim box on every page, so the only difference between the two
  // documents is the attachment the fix run removes.
  page.node.set(PDFName.of('TrimBox'), doc.context.obj([18, 18, 594, 774]));
  writeFileSync(path, await doc.save());
}

function digest(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else out[`${prefix}${entry}`] = readFileSync(full).byteLength;
    }
  };
  walk(root, '');
  return out;
}

describe('Preflight a folder', function () {
  // A sweep is one engine call over a whole tree, and the fix arm runs
  // Ghostscript per document — longer than the suite default by construction.
  this.timeout(180_000);

  let dir: string;
  let source: string;
  let outside: string;

  before(async () => {
    await waitForHarness();
    dir = mkdtempSync(resolve(tmpdir(), 'spectra-droplet-'));
    source = resolve(dir, 'in');
    outside = resolve(dir, 'outside');
    mkdirSync(resolve(source, 'inner'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    await buildSource(resolve(source, 'catalogue.pdf'), true);
    await buildSource(resolve(source, 'clean.pdf'), false);
    await buildSource(resolve(source, 'inner', 'insert.pdf'), true);
    // The one that must never be read: it is not under the source root.
    await buildSource(resolve(outside, 'untouched.pdf'), true);
    // The rule the fix run measures against, in the store the picker reads.
    // It goes in BEFORE the dialog first mounts: the picker reads the user
    // store once, at mount, and the droplet needs no open document to author
    // a rule through.
    await browser.execute(function () {
      localStorage.setItem('spectra-preflight-profiles', JSON.stringify([{
        schema: 1,
        id: 'droplet_rule',
        name: 'Droplet rule',
        checks: {
          ink_coverage_max: { enabled: false },
          embedded_files: { severity: 'fail', allow: false },
        },
        fixups: [{ id: 'remove_attachments', params: {} }],
      }]));
    });
  });

  after(async () => {
    await browser.execute(() => {
      localStorage.removeItem('guided-actions');
      localStorage.removeItem('spectra-preflight-profiles');
    });
    await closeAllFiles();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Shut the modal so the next thing this spec opens is reachable. */
  async function closeDialog(): Promise<void> {
    const shut = await $('[data-testid="folder-preflight-x"]');
    if (await shut.isDisplayed()) await shut.click();
    await $('[data-testid="folder-preflight-dialog"]').waitForDisplayed({
      timeout: 10000,
      reverse: true,
    });
  }

  async function openDialog(): Promise<void> {
    expect(await invokeAppCommand('tools.folderPreflight')).toBe(true);
    await $('[data-testid="folder-preflight-dialog"]').waitForDisplayed({
      timeout: 15000,
    });
  }

  async function runInto(dest: string, mode: string, profile: string): Promise<void> {
    await folderPreflightSetFolders(source, dest);
    await browser.waitUntil(
      async () => (await folderPreflightSnapshot())?.fileCount === 3,
      { timeout: 20000, timeoutMsg: 'the source never enumerated three documents' },
    );
    // The shipped profiles are an ENGINE read. Selecting one before it lands
    // silently falls back to whatever the picker already had, which is a run
    // against a rule nobody chose.
    await browser.waitUntil(
      async () => !!(await folderPreflightSnapshot())?.profiles.includes(profile),
      { timeout: 20000, timeoutMsg: `the picker never offered ${profile}` },
    );
    await folderPreflightSetProfile(profile);
    await folderPreflightSetMode(mode);
    expect(await folderPreflightRun()).toBeNull();
    await browser.waitUntil(
      async () => (await folderPreflightSnapshot())?.phase === 'done',
      { timeout: 180000, timeoutMsg: 'the sweep never finished' },
    );
  }

  it('checks a folder without touching one byte of it', async () => {
    await openDialog();
    const before = digest(source);
    const dest = resolve(dir, 'check-out');
    await runInto(dest, 'check', 'office_print');

    const snapshot = (await folderPreflightSnapshot())!;
    expect(snapshot.report!.mode).toBe('check');
    expect(snapshot.report!.total).toBe(3);
    expect(snapshot.report!.ok).toBe(3);
    // Nothing in the tree it read changed, and the tree next to it was never
    // opened at all.
    expect(digest(source)).toEqual(before);
    expect(existsSync(resolve(outside, 'untouched.pdf'))).toBe(true);
    // A check writes reports, never documents.
    expect(existsSync(resolve(dest, 'catalogue.pdf'))).toBe(false);
    expect(existsSync(resolve(dest, 'catalogue.pdf.preflight.json'))).toBe(true);
    expect(existsSync(resolve(dest, 'inner', 'insert.pdf.preflight.json'))).toBe(true);
  });

  it('writes the localized reports beside every JSON one', async () => {
    const dest = resolve(dir, 'check-out');
    const snapshot = (await folderPreflightSnapshot())!;
    expect(snapshot.reportsWritten).toBe(3);
    for (const rel of ['catalogue.pdf', 'clean.pdf']) {
      expect(existsSync(resolve(dest, `${rel}.preflight.txt`))).toBe(true);
      expect(existsSync(resolve(dest, `${rel}.preflight.html`))).toBe(true);
    }
    const html = readFileSync(resolve(dest, 'catalogue.pdf.preflight.html'), 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
    // The report carries the check ids and the rule each row was measured
    // against, exactly as the panel's export does.
    expect(html).toContain('image_min_dpi_contone');
    const text = readFileSync(resolve(dest, 'catalogue.pdf.preflight.txt'), 'utf8');
    expect(text).toContain('fonts_embedded');
  });

  it('records a run log the retention sweep matches', async () => {
    const snapshot = (await folderPreflightSnapshot())!;
    const logPath = snapshot.report!.log_path;
    if (logPath) {
      expect(logPath).toContain('preflight-run-');
      expect(readFileSync(logPath, 'utf8')).toContain('Preflight sweep');
    }
  });

  it('fixes a mirrored copy and re-checks it, leaving the sources alone', async () => {
    // `droplet_rule` carries exactly one fixup — the one these documents
    // need — so the assertion is about the pass rather than about Ghostscript.
    const before = digest(source);
    const dest = resolve(dir, 'fix-out');
    await runInto(dest, 'fix', 'droplet_rule');

    const report = (await folderPreflightSnapshot())!.report!;
    expect(report.mode).toBe('fix');
    expect(report.in_place).toBe(false);
    expect(report.total).toBe(3);
    expect(report.failed).toBe(0);

    // The mirror carries the repaired documents at their own tree positions.
    expect(existsSync(resolve(dest, 'catalogue.pdf'))).toBe(true);
    expect(existsSync(resolve(dest, 'inner', 'insert.pdf'))).toBe(true);
    // The sources are read at their own paths and never written back.
    expect(digest(source)).toEqual(before);

    // The re-check is not optional: the report is the state AFTER the fixups.
    const row = report.results.find((r) => r.rel === 'catalogue.pdf')!;
    expect(row.applied).toEqual(['remove_attachments']);
    expect(row.after!.failed).toBeLessThan(row.before!.failed);
    const written = JSON.parse(readFileSync(row.report!, 'utf8'));
    const status = Object.fromEntries(
      (written.checks as { id: string; status: string }[]).map((c) => [c.id, c.status]),
    );
    // The row the fixup answers is clear, and the ones it does not carry a
    // door for are untouched — a pass this document did not earn is the
    // wrongness the whole round exists to end.
    expect(status.embedded_files).toBe('pass');
    expect(status.fonts_embedded).toBe('fail');
    const clean = report.results.find((r) => r.rel === 'clean.pdf')!;
    expect(clean.applied).toEqual([]);
  });

  it('produces the same sweep from the command line', async () => {
    const dest = resolve(dir, 'cli-out');
    execFileSync(
      APP_EXE,
      ['preflight-sweep', source, '--dest', dest, '--profile', 'office_print'],
      { encoding: 'utf-8' },
    );
    expect(existsSync(resolve(dest, 'catalogue.pdf.preflight.json'))).toBe(true);
    // A command line has no locale, so it stops at the JSON — deliberately.
    expect(existsSync(resolve(dest, 'catalogue.pdf.preflight.txt'))).toBe(false);
  });

  it('writes a guided action to a path outside the app’s own temp tree', async () => {
    // The capability-scoped filesystem plugin reaches `$TEMP/spectrapdf/**`
    // and nothing else, and this app's pickers are its own Rust commands, so
    // no runtime scope extension ever reaches a path a user chose. The
    // negative is asserted first, against the very plugin the export used to
    // go through.
    const target = resolve(dir, 'travel-kit.json');
    const refusal = (await browser.executeAsync(function (path: string, done: (r: string) => void) {
      (window as any).__TAURI_INTERNALS__
        .invoke('plugin:fs|read_file', { path, options: {} })
        .then(() => done('NO REFUSAL'))
        .catch((err: unknown) => done(String(err)));
    }, resolve(source, 'clean.pdf'))) as string;
    expect(refusal).not.toBe('NO REFUSAL');
    expect(refusal.toLowerCase()).toContain('forbidden path');

    await closeDialog();
    // The actions panel is a document surface: it needs one open to sit on.
    await openByPaths([resolve(source, 'clean.pdf')]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeout: 20000,
      timeoutMsg: 'opening the fixture did not land on canvas',
    });
    expect(await invokeAppCommand('tools.open.actions')).toBe(true);
    await $('[data-testid="action-new"]').waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="action-new"]').click();
    await browser.execute(function () {
      const input = document.querySelector(
        '[data-testid="action-name"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'Travel Kit 141');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await browser.execute(function () {
      const select = document.querySelector(
        '[data-testid="action-add-op"]',
      ) as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setter.call(select, 'strip_metadata');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();

    const actions = (await browser.execute(() =>
      JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
    )) as { id: string; name: string }[];
    const action = actions.find((a) => a.name === 'Travel Kit 141')!;
    expect(action).toBeDefined();

    const failure = (await browser.executeAsync(
      function (id: string, path: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .guidedExportToPath(id, path)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      action.id,
      target,
    )) as string | null;
    expect(failure).toBeNull();
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).name).toBe('Travel Kit 141');

    // And it reads back from there too — the import side went through the
    // same scoped plugin.
    const imported = (await browser.executeAsync(
      function (path: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .guidedImportFromPath(path)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      target,
    )) as string | null;
    expect(imported).toBeNull();

    await browser.execute(() => localStorage.removeItem('guided-actions'));
    await invokeAppCommand('tools.close');
  });
});
