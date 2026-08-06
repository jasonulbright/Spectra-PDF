import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, invokeAppCommand, addAnnotation } from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Ops-tool panels open in the RIGHT DOCK beside an
// always-visible document. The Tools tab is GONE; the harness
// setView('operations') bridge — asserted in the last leg — is what keeps
// the legacy panel specs mechanical.
describe('right tool dock', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await setView('canvas');
    // The suite shares one workspace and an earlier spec may leave the board
    // (Organize) mode active; `document-view` exists only in the reading
    // view, so pin the mode instead of assuming it (order-dependence caught
    // by the full-suite gate — solo runs passed).
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  it('an ops tool opens in the dock with the document still visible', async () => {
    expect(await invokeAppCommand('tools.open.accessibility')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    // The whole point: the document did NOT go away.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Accessibility');

    // The owning tool's op switcher works inside the dock: Tags renders the
    // TagsPanel (sample.pdf is untagged — its honest empty state is the proof).
    await $('[data-testid="dock-op-tags"]').click();
    await $('[data-testid="tool-dock"] [data-testid="tags-untagged"]').waitForDisplayed({
      timeout: 10_000,
    });
  });

  it('the ⊞ grid is the dock-native all-tools view', async () => {
    await $('[data-testid="tool-dock-grid"]').click();
    await $('[data-testid="tool-dock"] [data-testid="tools-center"]').waitForDisplayed({
      timeout: 10_000,
    });
    await $('[data-testid="tool-dock"] [data-testid="tool-tile-optimize"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-dock-title"]').getText()) === 'Optimize',
      { timeout: 10_000, timeoutMsg: 'picking a tile never seated its tool in the dock' },
    );
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  // The optimizer opens on the AUDIT: which setting is worth changing is a
  // property of the document, and the rows adding up to the file size is what
  // makes the largest one trustworthy rather than decorative.
  it('the optimizer opens on a space breakdown that adds up to the file', async () => {
    expect(await invokeAppCommand('tools.panel.optimize')).toBe(true);
    await $('[data-testid="tool-dock"] [data-testid="space-audit-table"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'the Optimize panel never showed the space breakdown',
    });
    expect(await $('[data-testid="space-audit-inconsistent"]').isExisting()).toBe(false);

    // The rows account for the whole file — the reader can add the column up.
    const rows = (await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid^="space-audit-bytes-"]')).map((n) => ({
        id: n.getAttribute('data-testid') ?? '',
        bytes: Number(n.getAttribute('data-bytes')),
      })),
    )) as { id: string; bytes: number }[];
    const total = (await browser.execute(
      () =>
        Number(
          document.querySelector('[data-testid="space-audit-total"]')?.getAttribute('data-bytes'),
        ),
    )) as number;
    expect(rows.length).toBe(14);
    expect(total).toBe(statSync(SAMPLE).size);
    expect(rows.reduce((acc, r) => acc + r.bytes, 0)).toBe(total);
    expect(await $('[data-testid="space-audit-total"]').getText()).not.toBe('');

    // Largest first, and the file's biggest cost is content rather than slack.
    expect(rows[0].id).not.toBe('space-audit-bytes-overhead');
    expect(rows[0].bytes).toBeGreaterThanOrEqual(rows[rows.length - 1].bytes);
    expect(await $('[data-testid="space-audit-revisions"]').getText()).toContain('revision');
  });

  it('a menu panel command re-opens the closed dock on the doc tab', async () => {
    await $('[data-testid="tool-dock-close"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'the dock never closed',
    });
    expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Organize Pages');
    expect(await $('[data-testid="dock-op-rotate"]').getAttribute('aria-pressed')).toBe('true');
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  it('reading mode collapses the dock and restores it on exit', async () => {
    expect(await invokeAppCommand('view.readingMode')).toBe(true);
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'reading mode did not collapse the dock',
    });
    await browser.keys(['Escape']);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 5_000 });
  });

  // The status-bar toggle and the Comments TOOL now land on the SAME
  // panel. Before, they opened two different lists that both called themselves
  // "Comments" and disagreed about the count.
  it('the Comments toggle opens THE comments panel, and the tool opens the same one', async () => {
    // Give the list something to show, then drive the status-bar toggle.
    await addAnnotation({
      kind: 'highlight', x: 0.1, y: 0.1, w: 0.2, h: 0.08,
      color: '#ffd54a', note: 'dock comments leg',
    });
    await $('[data-testid="toggle-comments"]').click();
    await $('[data-testid="tool-dock"] [data-testid="comments-list"]').waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: 'the Comments toggle never showed the comments panel',
    });
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Comment');
    expect(await $('[data-testid="tool-dock"]').getText()).toContain('dock comments leg');
    // The document is still on screen — this is a dock panel, not an overlay.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);

    // The TOOL route lands on the very same panel — one comments surface.
    // Note the id: the review tool was FOLDED INTO `comment`, so there is
    // no `tools.open.comments` any more. Comment authors markup AND owns the
    // list; the grid no longer carries two tiles a plural apart.
    expect(await invokeAppCommand('tools.open.comment')).toBe(true);
    await $('[data-testid="tool-dock"] [data-testid="comments-list"]').waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: 'the Comments tool did not open the comments panel',
    });
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Comment');

    // Toggle again: the dock closes.
    await $('[data-testid="toggle-comments"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'the Comments toggle never closed the dock',
    });
  });

  // The concrete defect the fold removed: the status bar's old list filtered to
  // annotations carrying a NOTE (`if (!a.note) continue`), while the Comments
  // tool counted everything — so a highlight with no note was invisible in one
  // "Comments" and counted in the other. One list now, and it shows both.
  it('lists a comment that has no note (the old list silently hid these)', async () => {
    await addAnnotation({
      kind: 'highlight', x: 0.5, y: 0.5, w: 0.15, h: 0.06,
      color: '#2fbf71', note: '',
    });
    await $('[data-testid="toggle-comments"]').click();
    await $('[data-testid="tool-dock"] [data-testid="comments-list"]').waitForDisplayed({
      timeout: 15_000,
    });
    // Both are listed: the noted one from the previous leg and the note-less one.
    const items = await $$('[data-testid="tool-dock"] [data-testid="comment-item"]');
    expect(items.length).toBeGreaterThanOrEqual(2);
    // ...and the summary agrees with the list rather than reporting a different
    // number, which is what two surfaces reading two sources used to do.
    const summary = await $('[data-testid="tool-dock"] [data-testid="comments-summary"]').getText();
    expect(summary).toContain(`${items.length} comment`);
    await $('[data-testid="toggle-comments"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 5_000,
    });
  });

  it("the harness bridge: setView('operations') opens the dock", async () => {
    // The Tools tab is GONE; the name-compatible bridge keeps the ~30 legacy
    // panel specs mechanical — 'operations' now means "doc tab + dock open".
    // (The previous leg may have left the dock closed already.)
    if (await $('[data-testid="tool-dock"]').isExisting()) {
      await $('[data-testid="tool-dock-close"]').click();
      await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
        timeout: 5_000,
      });
    }
    await setView('operations');
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  // The dock is sized to what it HOLDS — the all-tools list contracts to
  // TOOL_DOCK_LIST_WIDTH, a tool panel expands to the user's width. Pinned by
  // MEASUREMENT, not by class name, because the failure mode is visual. The
  // no-wrap assertion is the one that earned its place: the list's tiles were
  // squeezed to 153px by a nested page-padding rule meant for Home, which
  // wrapped the longest tool names onto two lines.
  it('contracts for the tools list, expands for a tool, and fits the longest name', async () => {
    const dockWidth = async (): Promise<number> =>
      (await browser.execute(() => {
        const el = document.querySelector('[data-testid="tool-dock"]') as HTMLElement | null;
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      })) as number;

    // A tool panel: the resizable width.
    expect(await invokeAppCommand('tools.open.accessibility')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    const toolWidth = await dockWidth();
    expect(toolWidth).toBeGreaterThan(300);

    // The list: the fixed narrow width, and the header offers the way back.
    await $('[data-testid="tool-dock-grid"]').click();
    await $('[data-testid="tool-dock"] [data-testid="tools-center"]').waitForDisplayed({
      timeout: 10_000,
    });
    await browser.waitUntil(async () => (await dockWidth()) === 250, {
      timeout: 5_000,
      timeoutMsg: 'the tools list did not contract to its list width',
    });

    // No tool name wraps at that width — one line each.
    const wrapped = (await browser.execute(() => {
      const titles = Array.from(
        document.querySelectorAll('[data-testid="tool-dock"] .tool-tile-title'),
      ) as HTMLElement[];
      return titles
        .filter((t) => {
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 18;
          return Math.round(t.getBoundingClientRect().height / lh) > 1;
        })
        .map((t) => t.textContent);
    })) as string[];
    expect(wrapped).toEqual([]);

    // Back to the tool restores the panel width.
    await $('[data-testid="tool-dock-grid"]').click();
    await browser.waitUntil(async () => (await dockWidth()) === toolWidth, {
      timeout: 5_000,
      timeoutMsg: 'returning to the tool did not restore the panel width',
    });
  });

  // The dock shipped with a close X and no visible way back: closing it was a
  // one-way door unless you knew Shift+F4 or the View menu. The toolbar entry
  // existed all along but defaulted OFF — this pins it SHOWN, because the
  // regression is invisible (a boolean flip) and costs the user the pane.
  it('the toolbar Tools button ships visible and toggles the dock both ways', async () => {
    const btn = $('[data-testid="toolbar-tools-pane"]');
    await btn.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the tool-pane toggle is not on the default toolbar',
    });

    if (!(await $('[data-testid="tool-dock"]').isExisting())) {
      await btn.click();
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    }
    // Closes it...
    await btn.click();
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'the toolbar button did not close the dock',
    });
    // ...and brings it back, which is the whole point of the fix.
    await btn.click();
    await $('[data-testid="tool-dock"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the toolbar button did not re-open the dock',
    });
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });
});
