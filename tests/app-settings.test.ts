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

  it('logs batch runs by default, kept for 30 days', () => {
    // The people this serves run batches unattended and will never open
    // Preferences to switch a log on, so OFF-by-default would mean the feature
    // effectively does not exist for them.
    expect(DEFAULTS.batchLogEnabled).toBe(true);
    expect(DEFAULTS.batchLogRetentionDays).toBe(30);
  });

  it('gives an EXISTING install the batch-log defaults too', () => {
    // Same upgrade path as the update check: a stored blob predating these
    // keys must resolve to logging ON at 30 days, not to `undefined` — which
    // the Rust sweep reads as 0, i.e. keep forever, and which the dialog reads
    // as "do not log at all".
    store.set('spectra-settings', JSON.stringify({ theme: 'dark', gsSource: 'builtin' }));
    const s = loadSettings();
    expect(s.batchLogEnabled).toBe(true);
    expect(s.batchLogRetentionDays).toBe(30);
    expect(s.batchLogDir).toBe('');
  });

  it('defaults the log location to empty, meaning the app data folder', () => {
    // Empty is the sentinel Rust resolves to app-data. It must never come back
    // as `undefined`: `dir || null` would still work, but an explicit '' is
    // what the settings UI renders "Default" from.
    expect(DEFAULTS.batchLogDir).toBe('');
    expect(loadSettings().batchLogDir).toBe('');
  });

  it('round-trips a configured log location and a reset back to default', () => {
    saveSettings({ ...DEFAULTS, batchLogDir: 'D:\\shared\\ocr-logs' });
    expect(loadSettings().batchLogDir).toBe('D:\\shared\\ocr-logs');
    saveSettings({ ...DEFAULTS, batchLogDir: '' });
    expect(loadSettings().batchLogDir).toBe('');
  });

  it('round-trips a retention change and an opt-out', () => {
    saveSettings({ ...DEFAULTS, batchLogRetentionDays: 90 });
    expect(loadSettings().batchLogRetentionDays).toBe(90);
    saveSettings({ ...DEFAULTS, batchLogEnabled: false });
    expect(loadSettings().batchLogEnabled).toBe(false);
  });

  it('falls back to defaults on a corrupt blob instead of throwing', () => {
    store.set('spectra-settings', '{not json');
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});
