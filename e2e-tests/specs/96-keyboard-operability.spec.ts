// P21, keyboard half — the app's chrome must be OPERABLE from the keyboard
// (WCAG 2.1.1), and modal surfaces must be leavable (2.1.2). The axe sweep
// (spec 95) covers names/roles/contrast; what it cannot prove is that focus
// actually reaches the regions and that key handling works — that is this
// spec. The keymap itself (accelerators against the industry-standard
// table) has its own coverage; this is about reachability and escape.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  closeAllFiles,
  invokeAppCommand,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function activeDescriptor(): Promise<string> {
  return browser.execute(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const t = el.getAttribute('data-testid');
    return `${el.tagName.toLowerCase()}${t ? `[${t}]` : ''}#${el.className.toString().slice(0, 40)}`;
  });
}

describe('keyboard operability (P21)', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');
    await browser.waitUntil(async () => (await getState()).activeFile !== null, {
      timeout: 15_000,
      timeoutMsg: 'document never became active',
    });
    // The dock only exists once a tool is open — the walk must cover the
    // dock WITH a real panel in it, or "dock reachable" tests nothing.
    expect(await invokeAppCommand('tools.open.watermark')).toBe(true);
    await browser.pause(300);
  });

  it('Tab reaches every chrome region — menubar, toolbar, tab strip, nav rail, dock', async () => {
    // Park focus at the top of the document, then walk.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    const visited = new Set<string>();
    const regions = await browser.execute(() => ({
      menubar: !!document.querySelector('.app-menubar'),
      dock: !!document.querySelector('.tool-dock'),
    }));
    expect(regions.menubar).toBe(true);
    const regionHits = { menubar: false, toolbar: false, tabstrip: false, rail: false, dock: false, statusbar: false };
    const probe = () =>
      browser.execute(() => {
        const el = document.activeElement;
        if (!el || el === document.body) {
          return {
            desc: 'BODY',
            inMenubar: false,
            inToolbar: false,
            inTabstrip: false,
            inRail: false,
            inDock: false,
            inStatusbar: false,
          };
        }
        return {
          desc:
            el.tagName.toLowerCase() +
            (el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : '') +
            `@${el.className.toString().slice(0, 30)}`,
          inMenubar: !!el.closest('.app-menubar'),
          inToolbar: !!el.closest('.app-toolbar'),
          inTabstrip: !!el.closest('.app-tabstrip'),
          inRail: !!el.closest('.nav-icon-strip'),
          inDock: !!el.closest('.tool-dock'),
          inStatusbar: !!el.closest('.canvas-status-bar'),
        };
      });
    const record = (hit: Awaited<ReturnType<typeof probe>>) => {
      if (!hit || hit.desc === 'BODY') return;
      visited.add(hit.desc);
      if (hit.inMenubar) regionHits.menubar = true;
      if (hit.inToolbar) regionHits.toolbar = true;
      if (hit.inTabstrip) regionHits.tabstrip = true;
      if (hit.inRail) regionHits.rail = true;
      if (hit.inDock) regionHits.dock = true;
      if (hit.inStatusbar) regionHits.statusbar = true;
    };
    // One forward walk, bounded generously: the tab ring runs menubar →
    // toolbar → tab strip → nav rail → nav panel → canvas → dock → status
    // bar → queue and wraps. 200 steps is more than two full cycles of
    // every focusable the shell can hold with one 5-page document open —
    // if a region is still missing after that, focus genuinely cannot
    // reach it (a trap or a dead zone), which is exactly the defect.
    const walked: string[] = [];
    for (let i = 0; i < 200; i++) {
      await browser.keys(['Tab']);
      const hit = await probe();
      record(hit);
      if (hit) walked.push(hit.desc);
      if (Object.values(regionHits).every(Boolean)) break;
    }
    // Coverage, not order: every chrome region must be tab-reachable, and
    // the walk must visit a real spread of controls.
    expect(visited.size).toBeGreaterThanOrEqual(12);
    for (const [region, reached] of Object.entries(regionHits)) {
      if (!reached) {
        throw new Error(
          `chrome region "${region}" was never reached by Tab (${walked.length} steps).\nUnique stops:\n${[...new Set(walked)].join('\n')}\nLast 25 raw steps:\n${walked.slice(-25).join('\n')}`,
        );
      }
    }
  });

  it('the menubar operates by keyboard: open, walk items, close', async () => {
    await browser.execute(() => {
      (document.querySelector('[data-testid="menu-file"]') as HTMLElement).focus();
    });
    await browser.keys(['Enter']);
    await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
      timeout: 5_000,
      timeoutMsg: 'Enter on the File trigger did not open the menu',
    });
    // Arrow to another item — the highlighted item must move.
    await browser.keys(['ArrowDown']);
    await browser.keys(['ArrowDown']);
    const highlighted = await browser.execute(() =>
      document.querySelector('[role="menuitem"][data-highlighted]')?.getAttribute('data-testid') ?? null,
    );
    expect(highlighted).not.toBe(null);
    await browser.keys(['Escape']);
    await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: 'Escape did not close the menu',
    });
  });

  it('Ctrl+F lands focus IN the find input; Escape leaves it', async () => {
    await browser.keys(['Control', 'f']);
    await browser.waitUntil(
      async () => (await activeDescriptor()).includes('find-input'),
      { timeout: 5_000, timeoutMsg: `Ctrl+F did not focus the find input (active: ${await activeDescriptor()})` },
    );
    await browser.keys(['Escape']);
    await $('[data-testid="find-input"]').waitForDisplayed({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: 'Escape did not close the find bar',
    });
  });

  it('a modal opens and closes from the keyboard alone', async () => {
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'Ctrl+K did not open Preferences',
    });
    await browser.keys(['Escape']);
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: 'Escape did not close Preferences — a keyboard user is trapped',
    });
  });
});
