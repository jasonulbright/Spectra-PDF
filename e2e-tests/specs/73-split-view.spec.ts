import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
} from '../support/harness.js';

// Split view uses two stacked panes over the
// SAME document, each with its own scroll/zoom; the ACTIVE pane owns the
// page readout and the camera commands. Split state is session-scoped and
// this file toggles it off at the end (specs share one workspace per file —
// the cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function paneSpacerHeight(pane: 'a' | 'b'): Promise<number> {
  return await browser.execute(function (p: string) {
    const el = document.querySelector(
      `[data-testid="doc-pane-${p}"] .docview-spacer`,
    ) as HTMLElement | null;
    return el ? el.offsetHeight : -1;
  }, pane);
}

describe('split view (§ I.6)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    // Never leak split state into the next spec file.
    if ((await getState()).splitView) await invokeAppCommand('window.split');
  });

  it('Window ▸ Split shows two panes over the same document', async () => {
    expect((await getState()).splitView).toBe(false);
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitView, {
      timeoutMsg: 'window.split did not set ui.splitView',
    });

    await $('[data-testid="doc-pane-a"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="doc-pane-b"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[data-testid="split-divider"]')).toBeDisplayed();
    // Both panes render a full reading view of the SAME document.
    await expect($('[data-testid="doc-pane-a"] [data-testid="document-view"]')).toBeDisplayed();
    await expect($('[data-testid="doc-pane-b"] [data-testid="document-view"]')).toBeDisplayed();
    // Pane A starts active.
    expect(await $('[data-testid="doc-pane-a"]').getAttribute('data-active')).toBe('true');
  });

  it('the inactive pane scrolls silently; activating it takes over the readout', async () => {
    const before = (await getState()).currentPageId;
    expect(before).not.toBeNull();

    // Scroll pane B (inactive) to its far end — a real scroll event stream.
    await browser.execute(function () {
      const el = document.querySelector(
        '[data-testid="doc-pane-b"] .docview-scroll',
      ) as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await browser.pause(400); // give scroll-tracking a beat to (not) publish
    expect((await getState()).currentPageId).toBe(before);

    // Click pane B → it becomes active and its page takes the readout.
    await $('[data-testid="doc-pane-b"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="doc-pane-b"]').getAttribute('data-active')) === 'true',
      { timeoutMsg: 'clicking pane B did not activate it' },
    );
    await browser.waitUntil(
      async () => (await getState()).currentPageId !== before,
      { timeout: 10_000, timeoutMsg: 'activating pane B did not move the page readout' },
    );
  });

  it('camera commands land in the ACTIVE pane only', async () => {
    // Pane B is active from the previous leg. Zooming must grow B's spacer
    // and leave A's untouched (zoom is per-pane state).
    const aBefore = await paneSpacerHeight('a');
    const bBefore = await paneSpacerHeight('b');
    expect(aBefore).toBeGreaterThan(0);
    expect(bBefore).toBeGreaterThan(0);

    expect(await invokeAppCommand('view.zoomIn')).toBe(true);
    await browser.waitUntil(
      async () => (await paneSpacerHeight('b')) > bBefore,
      { timeoutMsg: 'zoom did not reach the active pane' },
    );
    expect(await paneSpacerHeight('a')).toBe(aBefore);
  });

  it('toggling split off returns the single view, readout back on pane A', async () => {
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => !(await getState()).splitView, {
      timeoutMsg: 'window.split did not clear ui.splitView',
    });
    await $('[data-testid="doc-pane-b"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'pane B survived toggling split off',
    });
    const views = await $$('[data-testid="document-view"]');
    expect(views.length).toBe(1);
  });
});
