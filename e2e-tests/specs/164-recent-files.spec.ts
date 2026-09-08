import { expect } from '@wdio/globals';
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  closeAllFiles,
  focusTab,
  getState,
  invokeAppCommand,
  openByPaths,
  scrollIntoReach,
  startOpenByPaths,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

/**
 * Recent files: the removal a reader performs, and the cleanup a launch
 * performs for them.
 *
 * The storage layer underneath — tombstones, monotonic ordering, cross-window
 * merges — has its own exhaustive unit coverage, and the path classifier has
 * Rust unit tests for its boundaries. What neither can show is that a real
 * window wired to a real process actually reaches them: there is no DOM test
 * environment in this repo, so component rendering, keyboard reachability and
 * anything that spans two launches of the binary are only provable here.
 *
 * Five properties, in the order the cases below take them:
 *
 * 1. The remove control is VISIBLE and reachable without a pointer. Both
 *    controls in a row are real buttons — the row itself is not one — so Tab
 *    must reach the remove button as its own stop and Enter/Space must fire it.
 * 2. The context menu carries the same removal as its last item.
 * 3. Every surface reading the list follows immediately, the File menu's Open
 *    Recent submenu included: they render the same state, and nothing is
 *    re-read from storage to make them agree.
 * 4. Removal touches the LIST and nothing else — a row for an open document
 *    goes without disturbing the document.
 * 5. Automatic removal is reserved for a path positively proven gone. A file
 *    that exists but will not parse keeps its row; a file deleted while the app
 *    was closed is dropped by the launch sweep; a downloaded document's entry
 *    survives its temp copy — through a failed reveal as through a launch
 *    sweep — because the address is what re-opens it.
 *
 * The launch case is driven by RELOADING the window rather than by a second
 * process, and the reason is a property of the harness, not a shortcut: every
 * driver session gets a fresh WebView2 profile, so an app relaunched through
 * `reloadSession` hydrates an empty list and has nothing left to sweep. A
 * reload re-runs the same hydration and the same mount effects over storage the
 * app itself wrote, which is the whole of what a launch does to this list.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const MALFORMED_PDF = resolve(__dirname, '..', 'fixtures', 'malformed.pdf');
const ENCRYPTED_PDF = resolve(__dirname, '..', 'fixtures', 'encrypted.pdf');

/** The row names the Home list is showing, top to bottom.
 *
 * One in-page read rather than an element-per-row walk: the list re-renders on
 * every removal, and a resolved handle held across that render is the
 * stale-element round trip the suite's log inventory is full of. */
async function recentNames(): Promise<string[]> {
  return browser.execute(function () {
    return Array.from(document.querySelectorAll('.home-recents .home-recent .home-recent-name')).map(
      (n) => (n.textContent ?? '').trim(),
    );
  });
}

async function waitForRecents(
  predicate: (names: string[]) => boolean,
  what: string,
  timeout = 15_000,
): Promise<void> {
  let last: string[] = [];
  try {
    await browser.waitUntil(
      async () => {
        last = await recentNames();
        return predicate(last);
      },
      { timeout, interval: 150, timeoutMsg: what },
    );
  } catch {
    // The list AS IT STOOD is the whole diagnosis for one of these, and
    // waitUntil's own message is fixed before the last read happens.
    throw new Error(`${what} (list showed: ${last.join(', ') || 'nothing'})`);
  }
}

/** Require the list to HOLD STILL. An absence of change has no edge to wait
 * for, so it is watched for long enough to have happened. */
async function holdsRecents(expected: string[], what: string, ms = 2_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const names = await recentNames();
    if (names.join('|') !== expected.join('|')) {
      throw new Error(`${what} (list became: ${names.join(', ') || 'nothing'})`);
    }
    await browser.pause(200);
  }
}

/** Empty the list through the command that owns Clear Recent, so the storage
 * generation stamp is written the way the product writes it.
 *
 * The pause is load-bearing: the clear stamps `max(previous + 1, now)`, and an
 * entry opened inside that same millisecond does not outrank the stamp and is
 * filtered back out on the next mirror. */
async function clearRecents(): Promise<void> {
  await focusTab('home');
  if (await invokeAppCommand('file.clearRecent')) {
    await waitForRecents((names) => names.length === 0, 'Clear Recent never emptied the list');
  }
  await browser.pause(150);
}

/** Dismiss the shared notice dialog, asserting what it named. */
async function dismissNotice(contains: string): Promise<void> {
  await waitForDisplayedSelector('[data-testid="confirm-message"]', {
    timeout: 30_000,
    timeoutMsg: `no notice appeared for ${contains}`,
  });
  expect(await $('[data-testid="confirm-message"]').getText()).toContain(contains);
  await $('[data-testid="notice-ok"]').click();
  await waitForDisplayedSelector('[data-testid="confirm-message"]', {
    reverse: true,
    timeout: 15_000,
    timeoutMsg: 'the notice never closed',
  });
}

/** The remove button of the row currently showing `name`.
 *
 * Resolved by POSITION at call time rather than held: the index is read from
 * the list as it stands, and every removal renumbers what follows it. */
async function removeSelectorFor(name: string): Promise<string> {
  const names = await recentNames();
  const index = names.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return `.home-recents > .home-recent:nth-child(${index + 1}) [data-testid="home-recent-remove"]`;
}

async function openSelectorFor(name: string): Promise<string> {
  const names = await recentNames();
  const index = names.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return `.home-recents > .home-recent:nth-child(${index + 1}) [data-testid="home-recent-item"]`;
}

/** What has focus, and which row it belongs to. */
async function focusProbe(): Promise<{ testid: string | null; row: string | null; desc: string }> {
  return browser.execute(function () {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { testid: null, row: null, desc: 'BODY' };
    const row = el.closest('.home-recent');
    const testid = el.getAttribute('data-testid');
    return {
      testid,
      row: row ? ((row.querySelector('.home-recent-name')?.textContent ?? '').trim() || null) : null,
      desc: `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ''}`,
    };
  });
}

/** Walk forward with Tab until `hit` accepts the focused element.
 *
 * Coverage of the tab ring, not of an order: the shell's chrome (menubar,
 * toolbar, tab strip) stands ahead of the Home content, and what is under test
 * is that focus REACHES the row's controls, not where in the ring they sit. */
async function tabUntil(
  hit: (probe: Awaited<ReturnType<typeof focusProbe>>) => boolean,
  what: string,
  limit = 250,
): Promise<void> {
  await browser.execute(function () {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const walked: string[] = [];
  for (let step = 0; step < limit; step++) {
    await browser.keys(['Tab']);
    const probe = await focusProbe();
    walked.push(probe.desc);
    if (hit(probe)) return;
  }
  throw new Error(
    `${what} was never reached by Tab in ${limit} steps.\nUnique stops:\n${[...new Set(walked)].join('\n')}`,
  );
}

/** Open the File menu and its Open Recent submenu, then read what it lists.
 *
 * Both triggers are re-issued rather than clicked once: a menu that is CLOSED
 * is not a menu that is slow, and the shell's own focus changes can dismiss one
 * opened a moment too early (the reason `openMenuItem` in the harness has this
 * shape). */
async function openRecentMenuNames(): Promise<string[]> {
  const fileTrigger = '[data-testid="menu-file"]';
  const subTrigger = '[data-testid="submenu-file-recent"]';
  await browser.waitUntil(
    async () => {
      if (await $(subTrigger).isDisplayed().catch(() => false)) return true;
      if ((await $(fileTrigger).getAttribute('aria-expanded')) !== 'true') {
        await $(fileTrigger).click();
      }
      return await $(subTrigger).isDisplayed().catch(() => false);
    },
    { timeout: 20_000, interval: 250, timeoutMsg: 'the File menu never opened' },
  );
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="menuitem-recent"]').isDisplayed().catch(() => false)) return true;
      await $(subTrigger).click();
      return await $('[data-testid="menuitem-recent"]').isDisplayed().catch(() => false);
    },
    { timeout: 20_000, interval: 250, timeoutMsg: 'the Open Recent submenu never opened' },
  );
  const names = await browser.execute(function () {
    return Array.from(document.querySelectorAll('[data-testid="menuitem-recent"]')).map((n) =>
      (n.textContent ?? '').trim(),
    );
  });
  // Two levels are open, and Escape closes one of them per press. The menu is
  // left CLOSED rather than merely un-submenued: a File menu still standing
  // swallows the next case's clicks.
  await browser.waitUntil(
    async () => {
      if ((await $(fileTrigger).getAttribute('aria-expanded')) !== 'true') return true;
      await browser.keys(['Escape']);
      return (await $(fileTrigger).getAttribute('aria-expanded')) !== 'true';
    },
    { timeout: 10_000, interval: 200, timeoutMsg: 'Escape never closed the File menu' },
  );
  await waitForDisplayedSelector('[data-testid="menuitem-file-open"]', {
    reverse: true,
    timeout: 10_000,
    timeoutMsg: 'the File menu content stayed on screen after it reported itself closed',
  });
  return names;
}

/** Attach a download's PROVENANCE to a path, the way a download does.
 *
 * A downloaded document's local copy is a temp path; its origin is recorded on
 * the Rust side and recovered by the open, which is what puts `sourceUrl` on
 * the recent entry. Registered rather than fetched: what these cases are about
 * is the entry, not the download. */
async function registerWebOrigin(filePath: string, address: string): Promise<void> {
  const failure = await browser.executeAsync<string | null, [string, string]>(
    function (path, url, done) {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        done('no ipc');
        return;
      }
      invoke('register_web_origin', { path, url })
        .then(() => done(null))
        .catch((err: unknown) => done(String(err)));
    },
    filePath,
    address,
  );
  expect(failure).toBe(null);
}

/** The provenance a row is SHOWING, for the row named `name`.
 *
 * A downloaded entry names its host where a local one names its folder, so the
 * folder line is the renderer's own report of whether `sourceUrl` survived the
 * trip — read before a case leans on that exemption. */
async function folderLineFor(name: string): Promise<string> {
  const lines = await browser.execute(function () {
    return Array.from(document.querySelectorAll('.home-recents .home-recent')).map((r) => ({
      name: (r.querySelector('.home-recent-name')?.textContent ?? '').trim(),
      folder: (r.querySelector('.home-recent-folder')?.textContent ?? '').trim(),
    }));
  });
  return lines.find((f) => f.name === name)?.folder ?? '';
}

/** Right-click one row through a real `contextmenu` event — the menu itself is
 * ordinary fixed-position DOM, positioned from the event's own coordinates. */
async function openRowMenu(name: string): Promise<void> {
  await browser.execute(function (rowName: string) {
    const row = Array.from(document.querySelectorAll('.home-recents .home-recent')).find(
      (r) => ((r.querySelector('.home-recent-name')?.textContent ?? '').trim()) === rowName,
    ) as HTMLElement | undefined;
    if (!row) throw new Error(`no recent row named ${rowName}`);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2),
      }),
    );
  }, name);
  await waitForDisplayedSelector('[data-testid="context-menu"]', {
    timeout: 10_000,
    timeoutMsg: `right-clicking ${name} opened no context menu`,
  });
}

describe('recent files: removing an entry, and the launch that prunes dead ones', () => {
  let tmp = '';
  const copies = new Map<string, string>();
  const copy = (name: string): string => {
    const dest = resolve(tmp, name);
    copyFileSync(SAMPLE_PDF, dest);
    copies.set(name, dest);
    return dest;
  };

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'recent-files-'));
    await waitForHarness();
    await closeAllFiles();
    await clearRecents();
  });

  after(async () => {
    // The list is machine state shared by every launch on this box: leaving
    // scratch rows in it would hand the next spec a Home tab full of paths
    // that no longer exist.
    try {
      await clearRecents();
    } catch {
      /* a list nobody can reach any more is already as clear as it can be */
    }
    try {
      if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a still-open working copy is the OS temp dir's own cleanup story */
    }
  });

  describe('removing one entry by hand', () => {
    before(async function () {
      this.timeout(180_000);
      // Opened one at a time so the list order is the open order reversed, not
      // whatever order a batch's claims happened to be granted in.
      for (const name of ['alpha.pdf', 'bravo.pdf', 'charlie.pdf', 'delta.pdf', 'echo.pdf', 'foxtrot.pdf']) {
        await openByPaths([copy(name)]);
      }
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents(
        (names) => names.length === 6 && names[0] === 'foxtrot.pdf' && names[5] === 'alpha.pdf',
        'the six opened documents never appeared as recents, newest first',
      );
    });

    it('the row carries a visible remove button that drops exactly that entry', async () => {
      const selector = await removeSelectorFor('charlie.pdf');
      await scrollIntoReach(selector);
      await $(selector).click();

      await waitForRecents(
        (names) => !names.includes('charlie.pdf'),
        'the remove button did not drop its row',
      );
      // Its neighbours are untouched: the control names one path, never a range.
      expect(await recentNames()).toEqual([
        'foxtrot.pdf',
        'echo.pdf',
        'delta.pdf',
        'bravo.pdf',
        'alpha.pdf',
      ]);
    });

    it('Tab reaches both controls in a row, and Enter on the remove button removes it', async () => {
      await tabUntil(
        (p) => p.testid === 'home-recent-item' && p.row === 'foxtrot.pdf',
        "foxtrot.pdf's open control",
      );
      // The remove button is the very next stop — a row's two controls are
      // siblings, not a control with a pointer-only affordance beside it.
      await browser.keys(['Tab']);
      const onRemove = await focusProbe();
      expect(onRemove.testid).toBe('home-recent-remove');
      expect(onRemove.row).toBe('foxtrot.pdf');

      await browser.keys(['Enter']);
      await waitForRecents(
        (names) => !names.includes('foxtrot.pdf'),
        'Enter on the remove button did not remove the row',
      );
      expect(await recentNames()).toEqual(['echo.pdf', 'delta.pdf', 'bravo.pdf', 'alpha.pdf']);
    });

    it('and Space fires it too — it is a real button, not a div wearing a role', async () => {
      await tabUntil(
        (p) => p.testid === 'home-recent-remove' && p.row === 'echo.pdf',
        "echo.pdf's remove button",
      );
      await browser.keys([' ']);
      await waitForRecents(
        (names) => !names.includes('echo.pdf'),
        'Space on the remove button did not remove the row',
      );
      expect(await recentNames()).toEqual(['delta.pdf', 'bravo.pdf', 'alpha.pdf']);
    });

    it('the context menu offers the same removal as its last item', async () => {
      await openRowMenu('delta.pdf');
      const items = await browser.execute(function () {
        return Array.from(document.querySelectorAll('[data-testid="context-menu"] button')).map((b) =>
          (b.textContent ?? '').trim(),
        );
      });
      expect(items).toEqual(['Open', 'Show in folder', 'Copy full path', 'Remove from list']);

      const buttons = await $$('[data-testid="context-menu"] button').getElements();
      await buttons[3].click();
      await waitForDisplayedSelector('[data-testid="context-menu"]', {
        reverse: true,
        timeout: 10_000,
        timeoutMsg: 'the context menu never closed',
      });
      await waitForRecents(
        (names) => !names.includes('delta.pdf'),
        'the context menu removal did not drop the row',
      );
      expect(await recentNames()).toEqual(['bravo.pdf', 'alpha.pdf']);
    });

    it('File ▸ Open Recent shows the same list, with no round trip to make it agree', async () => {
      const listed = await openRecentMenuNames();
      expect(listed).toEqual(['bravo.pdf', 'alpha.pdf']);
      for (const gone of ['charlie.pdf', 'foxtrot.pdf', 'echo.pdf', 'delta.pdf']) {
        expect(listed).not.toContain(gone);
      }
    });
  });

  describe('a removal that must not reach the document', () => {
    it('drops the row for an OPEN document and leaves the document alone', async () => {
      await openByPaths([copies.get('alpha.pdf')!]);
      await browser.waitUntil(async () => (await getState()).activeFile !== null, {
        timeout: 20_000,
        timeoutMsg: 'alpha.pdf never became the active document',
      });
      const before = await getState();
      expect(before.fileCount).toBe(1);
      expect(before.activeFile?.path.toLowerCase()).toBe(copies.get('alpha.pdf')!.toLowerCase());

      await focusTab('home');
      await waitForRecents((names) => names[0] === 'alpha.pdf', 'the re-open never moved alpha.pdf to the front');
      const selector = await removeSelectorFor('alpha.pdf');
      await scrollIntoReach(selector);
      await $(selector).click();
      await waitForRecents(
        (names) => !names.includes('alpha.pdf'),
        'removing an open document’s row did nothing',
      );

      // The list is the only thing that changed: the tab still stands, over the
      // same document, still clean.
      const after = await getState();
      expect(after.fileCount).toBe(1);
      expect(after.activeFile?.path.toLowerCase()).toBe(copies.get('alpha.pdf')!.toLowerCase());
      expect(after.activeFile?.dirty).toBe(false);
      expect(await $('[data-testid="tab-doc-0"]').getText()).toContain('alpha.pdf');
    });

    it('and opening that path again brings the entry back', async () => {
      // A removal records a tombstone against the path; a later open has to
      // outrank it, or a reader could never get a removed document back.
      await closeAllFiles();
      await openByPaths([copies.get('alpha.pdf')!]);
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents(
        (names) => names[0] === 'alpha.pdf',
        'a fresh open never restored the removed entry',
      );
    });
  });

  describe('an open that fails', () => {
    it('adds no entry for a file that never opened, nor for a path that is not there', async () => {
      await clearRecents();
      await openByPaths([copies.get('bravo.pdf')!]);
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents((names) => names.length === 1, 'the baseline entry never appeared');
      const baseline = await recentNames();

      // Structurally broken: refused at the seam that mints the working copy.
      await openByPaths([MALFORMED_PDF]);
      await dismissNotice('malformed.pdf');

      // And a path with nothing at it at all.
      const absent = resolve(tmp, 'never-existed.pdf');
      expect(existsSync(absent)).toBe(false);
      await openByPaths([absent]);
      await dismissNotice('never-existed.pdf');

      // Recents record what OPENED. A refusal that left a row behind would
      // offer the reader a door that has never worked.
      expect(await recentNames()).toEqual(baseline);
    });

    it('adds no entry for an encrypted file whose password prompt is cancelled', async () => {
      const baseline = await recentNames();
      // NOT awaited: the open does not resolve until the prompt is answered,
      // and awaiting it here would deadlock against the very dialog it raised.
      await startOpenByPaths([ENCRYPTED_PDF]);
      await waitForDisplayedSelector('[data-testid="password-input"]', {
        timeout: 20_000,
        timeoutMsg: 'no password prompt for the encrypted fixture',
      });
      await browser.keys(['Escape']);
      await waitForDisplayedSelector('[data-testid="password-input"]', {
        reverse: true,
        timeout: 15_000,
        timeoutMsg: 'Escape never dismissed the password prompt',
      });

      // A cancel is not a failure and raises no notice, so the list holding
      // still is the whole verdict — and the branch that returns here is a
      // different one from the refusal above.
      expect((await getState()).fileCount).toBe(0);
      await holdsRecents(baseline, 'a cancelled password prompt added a recent entry');
    });
  });

  describe('a file that goes missing while the app is running', () => {
    before(async function () {
      this.timeout(120_000);
      await clearRecents();
      for (const name of ['battered.pdf', 'vanished.pdf', 'vanished-reveal.pdf']) {
        await openByPaths([copy(name)]);
      }
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents((names) => names.length === 3, 'the three scratch documents never appeared');

      // battered.pdf keeps its NAME and its place on disk; only its bytes are
      // replaced, so the path still resolves to a file.
      copyFileSync(MALFORMED_PDF, copies.get('battered.pdf')!);
      unlinkSync(copies.get('vanished.pdf')!);
      unlinkSync(copies.get('vanished-reveal.pdf')!);
    });

    it('drops the entry once an Open positively proves the file is gone', async () => {
      const selector = await openSelectorFor('vanished.pdf');
      await scrollIntoReach(selector);
      await $(selector).click();
      await dismissNotice('vanished.pdf');
      await waitForRecents(
        (names) => !names.includes('vanished.pdf'),
        'opening a deleted file left its entry in the list',
      );
    });

    it('drops it on a failed Show in Folder as well', async () => {
      await openRowMenu('vanished-reveal.pdf');
      const buttons = await $$('[data-testid="context-menu"] button').getElements();
      await buttons[1].click(); // Show in folder
      await dismissNotice('could not be shown');
      await waitForRecents(
        (names) => !names.includes('vanished-reveal.pdf'),
        'a failed Show in Folder left the entry in the list',
      );
    });

    it('but KEEPS the entry for a file that exists and merely will not parse', async () => {
      // The two cases above prove the removal path is live in this session, so
      // this one is a real exemption rather than an absence of machinery: an
      // unopenable file that is still there is the reader's only route back to
      // a document they may yet repair.
      const selector = await openSelectorFor('battered.pdf');
      await scrollIntoReach(selector);
      await $(selector).click();
      await dismissNotice('battered.pdf');
      await holdsRecents(['battered.pdf'], 'a file that is still on disk lost its recent entry');
    });

    it('and KEEPS a downloaded document’s entry when Show in Folder fails on its temp copy', async function () {
      this.timeout(120_000);
      // A downloaded document is reached by its ADDRESS; the local copy is a
      // temp path that anything may sweep away, so its absence says nothing
      // about the entry. Dropping the row here would delete the only record of
      // the address — the document would have no way back at all.
      //
      // The same reveal, on a local path, drops its row two cases up, so this
      // is a real exemption rather than an absence of machinery: the probe and
      // the removal it feeds are both live in this session.
      const address = 'https://example.test/downloads/reveal-me.pdf';
      const downloaded = copy('web-reveal.pdf');
      await registerWebOrigin(downloaded, address);
      await openByPaths([downloaded]);
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents(
        (names) => names[0] === 'web-reveal.pdf',
        'the downloaded document never appeared at the front of the list',
      );
      // Its provenance travelled: the row names a host, not a temp folder.
      expect(await folderLineFor('web-reveal.pdf')).toContain('example.test');

      // The local copy goes, exactly as a temp cleanup would take it.
      unlinkSync(downloaded);

      await openRowMenu('web-reveal.pdf');
      const buttons = await $$('[data-testid="context-menu"] button').getElements();
      await buttons[1].click(); // Show in folder
      // The reveal still FAILS, and still says so — the exemption is about what
      // the failure is allowed to remove, not about hiding it.
      await dismissNotice('could not be shown');
      await holdsRecents(
        ['web-reveal.pdf', 'battered.pdf'],
        'a failed Show in Folder removed a downloaded document’s entry',
      );

      // And the row still WORKS: it re-opens through the dialog, pre-filled
      // with the address, which is the whole reason it was kept.
      const selector = await openSelectorFor('web-reveal.pdf');
      await scrollIntoReach(selector);
      await $(selector).click();
      await waitForDisplayedSelector('[data-testid="open-web-dialog"]', {
        timeout: 20_000,
        timeoutMsg: 'a kept web entry did not re-open through the open-from-web dialog',
      });
      expect(await $('[data-testid="open-web-url"]').getValue()).toBe(address);

      await $('[data-testid="open-web-cancel"]').click();
      await waitForDisplayedSelector('[data-testid="open-web-dialog"]', {
        reverse: true,
        timeout: 15_000,
        timeoutMsg: 'Cancel never closed the open-from-web dialog',
      });
    });
  });

  describe('a file that goes missing while nothing is watching it', () => {
    const WEB_ADDRESS = 'https://example.test/downloads/from-the-web.pdf';

    before(async function () {
      this.timeout(120_000);
      await clearRecents();
      const survivor = copy('sweep-survivor.pdf');
      const doomed = copy('sweep-doomed.pdf');
      const downloaded = copy('sweep-from-web.pdf');

      await registerWebOrigin(downloaded, WEB_ADDRESS);

      for (const path of [survivor, doomed, downloaded]) await openByPaths([path]);
      await closeAllFiles();
      await focusTab('home');
      await waitForRecents(
        (names) =>
          names.includes('sweep-survivor.pdf') &&
          names.includes('sweep-doomed.pdf') &&
          names.includes('sweep-from-web.pdf'),
        'the three sweep documents never appeared as recents',
      );

      // The provenance really did attach — otherwise the web case below would
      // be asserting nothing about a web entry at all.
      expect(await folderLineFor('sweep-from-web.pdf')).toContain('example.test');

      // Both local copies go while the app is closed; the surviving one stays.
      unlinkSync(doomed);
      unlinkSync(downloaded);
    });

    it('the launch prunes it, keeps the file that is still there, and never touches a web entry', async function () {
      this.timeout(120_000);
      // A RELOAD, not a second process. The launch sweep is a mount effect over
      // the list hydration reads, and this re-runs both against storage the app
      // itself wrote — the whole path, from `readRecent` through the Rust
      // classifier to the dispatch.
      //
      // A second process is not available to ask: msedgedriver hands every
      // driver session a fresh WebView2 profile, so an app relaunched through
      // `reloadSession` hydrates an EMPTY list and has nothing to sweep. That is
      // measured, not assumed — `probe-recent-relaunch.local.ts` reports it —
      // and it is the same reason `149-exit-session` reads the Rust-side
      // `session.json` rather than anything the renderer stored.
      await browser.refresh();
      await waitForHarness(30_000);
      await focusTab('home');

      // The rehydrated list first: an EMPTY one satisfies every absence below
      // for the wrong reason, and an empty list is exactly what a lost store
      // looks like.
      await waitForRecents(
        (names) => names.includes('sweep-survivor.pdf'),
        'the reloaded window never rehydrated the list it had stored',
        30_000,
      );
      // The sweep is one probe and one removal, so the doomed row disappearing
      // is the sweep having COMPLETED — the other two are judged against a
      // finished pass, not against a race.
      await waitForRecents(
        (names) => !names.includes('sweep-doomed.pdf'),
        'the launch never removed the recent entry whose file had been deleted',
        30_000,
      );
      const names = await recentNames();
      expect(names).toContain('sweep-survivor.pdf');
      // Its local copy is gone too — and it still stands, because the address
      // is what re-opens one of these, not the path.
      expect(names).toContain('sweep-from-web.pdf');
    });
  });
});
