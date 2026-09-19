// The Ghostscript messages send the user to the Engine category of the
// Preferences dialog. Every shipped catalog names that route with its own
// title for the dialog (`app.prefs.title`) and its own label for the category
// (`panel.settings.catEngine`), so the message names the words the screen
// shows. The engine's own refusals separate the two with `>`, the renderer's
// with `▸`.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES_DIR = resolve(__dirname, '../src/renderer/locales');

const ROUTES: Record<string, number> = {
  'dialog.gsMissing.route': 1,
  'panel.common.gsRequired': 1,
  'panel.common.gsNotExecutable': 1,
  'panel.common.gsProbeFailed': 2,
  'panel.common.gsTooOld': 1,
  'refusal.action.needsGhostscript': 1,
  'refusal.action.needsGhostscriptOne': 1,
  'engine.gs_capability.ghostscriptDidPassCapability': 1,
  'engine.gs_capability.ghostscriptOlderThanBuild': 1,
  'engine.gs_capability.ghostscriptRequiredOperationNone': 1,
  'engine.gs_capability.ghostscriptRequiredOperationThere': 1,
};

const catalogs = readdirSync(LOCALES_DIR).filter((locale) =>
  existsSync(resolve(LOCALES_DIR, locale, 'chrome.json')),
);

describe('the route to the Ghostscript setting', () => {
  it('reads every shipped catalog', () => {
    expect(catalogs.length).toBe(28);
  });

  for (const locale of catalogs) {
    it(`${locale} names the dialog and the category by their own labels`, () => {
      const catalog = JSON.parse(
        readFileSync(resolve(LOCALES_DIR, locale, 'chrome.json'), 'utf8'),
      ) as Record<string, string>;
      const title = catalog['app.prefs.title'];
      const engine = catalog['panel.settings.catEngine'];
      expect(title, `${locale} app.prefs.title`).toBeTruthy();
      expect(engine, `${locale} panel.settings.catEngine`).toBeTruthy();
      for (const [key, times] of Object.entries(ROUTES)) {
        const separator = key.startsWith('engine.') ? '>' : '▸';
        const route = `${title} ${separator} ${engine}`;
        const text = catalog[key] ?? '';
        expect(text.split(route).length - 1, `${locale} ${key}: ${text}`).toBe(times);
      }
    });
  }
});
