// app-settings persistence, with the update preference as the case that
// matters. Uses a localStorage stub since vitest runs in node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, saveSettings, DEFAULTS } from '../src/renderer/lib/app-settings';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('app settings', () => {
  it('checks for updates on launch by default', () => {
    // Notify-only, so ON is the safe default: it can surface a release but
    // can never install one.
    expect(DEFAULTS.checkUpdatesOnLaunch).toBe(true);
    expect(loadSettings().checkUpdatesOnLaunch).toBe(true);
  });

  it('gives an EXISTING install the default rather than a silent off', () => {
    // The upgrade path for every copy already out there: their stored blob
    // predates this key. If the merge left it undefined, the launch check
    // would quietly never run again for anyone who had ever opened
    // Preferences -- a feature that ships already broken for existing users
    // and works only for new ones.
    store.set(
      'spectra-settings',
      JSON.stringify({ theme: 'dark', gsSource: 'builtin', minimizeToTray: false }),
    );
    const s = loadSettings();
    expect(s.checkUpdatesOnLaunch).toBe(true);
    expect(s.theme).toBe('dark'); // ...without discarding what they HAD set
  });

  it('round-trips an explicit opt-out', () => {
    saveSettings({ ...DEFAULTS, checkUpdatesOnLaunch: false });
    expect(loadSettings().checkUpdatesOnLaunch).toBe(false);
  });

  it('falls back to defaults on a corrupt blob instead of throwing', () => {
    store.set('spectra-settings', '{not json');
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});
