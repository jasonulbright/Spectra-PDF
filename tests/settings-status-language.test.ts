// The Preferences confirmation line must follow a language change made while
// it is shown. A translated string held in component state keeps the language
// it was translated in, so the panel holds the catalog KEY and translates it
// at render. There is no DOM environment, so the source is the evidence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';

const SOURCE = readFileSync(resolve(__dirname, '../src/renderer/panels/SettingsPanel.tsx'), 'utf8');

describe('Preferences status line', () => {
  it('never stores a translated string as its status', () => {
    expect(SOURCE).not.toMatch(/setStatus\(\s*tChrome\(/);
    expect(SOURCE).toMatch(/<StatusBar message=\{status \? tChrome\(status\) : ''\} \/>/);
  });

  it('stores only keys the catalog defines', () => {
    const keys = [...SOURCE.matchAll(/setStatus\('([^']+)'\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !(k in PANEL_STRINGS))).toEqual([]);
  });
});
