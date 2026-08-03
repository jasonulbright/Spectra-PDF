// The ONE walk of every major UI surface, shared by the axe sweep (spec 95)
// and the theme-consistency audit (spec 97) so the two gates can never
// diverge on what "every surface" means. The walker drives; the visitor
// measures.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { openByPaths, setView, getState, closeAllFiles, invokeAppCommand } from './harness.js';

export const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

export const WALK_THEMES = ['dark', 'light', 'high-contrast'] as const;
export type WalkTheme = (typeof WALK_THEMES)[number];

// Mirrors TOOL_DEFS in src/renderer/commands/tools.ts — every tool AND every
// op panel it hosts, because the dock shows one op panel at a time and a
// sweep of first-panels-only leaves the rest unexercised. Hardcoded because
// the e2e project does not compile renderer sources; drift is self-detecting
// — invokeAppCommand returns false for an unknown command id and the walk
// fails loudly on it.
export const TOOL_OPS: readonly (readonly [string, readonly string[]])[] = [
  ['organize', ['rotate', 'delete', 'split']],
  ['comment', ['comments']],
  ['edit', []],
  ['fillsign', ['signatures']],
  ['prepareform', ['forms', 'document_js']],
  ['redact', []],
  ['measure', []],
  ['actions', ['actions']],
  ['ocr', []],
  ['compare', ['compare']],
  ['protect', ['encrypt', 'decrypt']],
  ['optimize', ['compress', 'optimize', 'grayscale', 'convert_cmyk', 'pdfa', 'pdf_version']],
  ['repair', ['repair', 'rebuild', 'recover']],
  ['watermark', ['watermark']],
  ['headerfooter', ['headerfooter']],
  ['pagebox', ['pagebox']],
  ['pagelabels', ['pagelabels']],
  ['attachments', ['attachments']],
  ['portfolio', ['portfolio']],
  ['layers', ['layers']],
  ['accessibility', ['accessibility', 'tags', 'readingorder']],
  ['preflight', ['preflight']],
  ['links', ['links']],
  ['export', ['extract_text']],
] as const;

// Mirrors NAV_PANEL_IDS in src/renderer/commands/navpanels.ts.
export const NAV_PANEL_IDS = [
  'pages', 'bookmarks', 'attachments', 'layers', 'tags', 'search', 'signatures',
] as const;

/** Stamp a theme the way the product does (theme-boot.ts at boot,
 * SettingsPanel.applyTheme on change): the attribute IS the mechanism. */
export async function stampTheme(theme: WalkTheme): Promise<void> {
  await browser.execute((t: string) => document.documentElement.setAttribute('data-theme', t), theme);
  await browser.pause(150);
  const now = await browser.execute(() => document.documentElement.getAttribute('data-theme'));
  expect(now).toBe(theme);
}

export type SurfaceVisitor = (theme: WalkTheme, surface: string) => Promise<void>;

/** Walk every surface under one theme, calling the visitor at each stop:
 * home, the open document, every tool and op panel, every nav panel, the
 * find bar, an open menu, the Properties dialog, and every Preferences
 * category. */
export async function walkSurfaces(theme: WalkTheme, visit: SurfaceVisitor): Promise<void> {
  await stampTheme(theme);

  // Home (welcome view — no document).
  await closeAllFiles();
  await browser.pause(250);
  await visit(theme, 'home');

  // The open document.
  await openByPaths([SAMPLE_PDF]);
  await setView('canvas');
  await browser.waitUntil(async () => (await getState()).activeFile !== null, {
    timeout: 15_000,
    timeoutMsg: `document never became active (${theme})`,
  });
  await browser.pause(250);
  await visit(theme, 'document');

  // Every tool, and every op panel inside it. `tools.open` seats the FIRST
  // op's panel; the rest are reached the way the dock's own op strip does.
  for (const [id, ops] of TOOL_OPS) {
    expect(await invokeAppCommand(`tools.open.${id}`)).toBe(true);
    await browser.pause(250);
    await visit(theme, `tool:${id}`);
    for (const op of ops.slice(1)) {
      expect(await invokeAppCommand(`tools.panel.${op}`)).toBe(true);
      await browser.pause(250);
      await visit(theme, `op:${op}`);
    }
  }

  // Every nav panel.
  for (const id of NAV_PANEL_IDS) {
    expect(await invokeAppCommand(`view.navPanel.${id}`)).toBe(true);
    await browser.pause(250);
    await visit(theme, `nav:${id}`);
  }

  // Find bar.
  await browser.keys(['Control', 'f']);
  await browser.pause(250);
  await visit(theme, 'findbar');
  await browser.keys(['Escape']);

  // An OPEN menu — the menubar's popups never render otherwise.
  await $('[data-testid="menu-file"]').click();
  await browser.pause(250);
  await visit(theme, 'menu:file');
  await browser.keys(['Escape']);
  await browser.pause(150);

  // Document Properties dialog.
  expect(await invokeAppCommand('file.properties')).toBe(true);
  await browser.pause(300);
  await visit(theme, 'dialog:properties');
  await browser.keys(['Escape']);
  await browser.pause(200);

  // Preferences — every category the dialog offers, discovered from its own
  // DOM so a new category cannot dodge the walk.
  await browser.keys(['Control', 'k']);
  await $('[data-testid^="prefs-cat-"]').waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: `Preferences did not open (${theme})`,
  });
  const cats = await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid^="prefs-cat-"]')).map((el) =>
      (el as HTMLElement).dataset.testid!.replace('prefs-cat-', ''),
    ),
  );
  expect(cats.length).toBeGreaterThan(0);
  for (const cat of cats) {
    await $(`[data-testid="prefs-cat-${cat}"]`).click();
    await browser.pause(200);
    await visit(theme, `prefs:${cat}`);
  }
  await $('[data-testid="prefs-close"]').click();
  await browser.pause(200);
}
