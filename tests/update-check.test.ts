import { describe, it, expect, vi } from 'vitest';
import {
  classifyUpdateFailure,
  runLaunchCheck,
  runManualCheck,
} from '../src/renderer/lib/update-check';
import { DIALOG_STRINGS as chromeEn } from '../src/renderer/i18n-dialogs';

const NET = 'Could not fetch a valid release JSON from the remote';
const SIG = 'The signature abc could not be decoded, please check if it is a valid base64 string.';

describe('update check outcomes', () => {
  it('manual check failure is a failed state, never up to date', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await runManualCheck({
      isDisabled: async () => false,
      check: () => Promise.reject(NET),
    });
    expect(s).toEqual({ status: 'failed', kind: 'network' });
    expect(s.status).not.toBe('uptodate');
  });

  it('failed messages never claim the app is current', () => {
    for (const k of ['failedNetwork', 'failedOther', 'failedSignature']) {
      const msg = chromeEn[`dialog.update.${k}` as keyof typeof chromeEn];
      expect(msg).toMatch(/^Could not check for updates\./);
      expect(msg).not.toBe(chromeEn['dialog.update.upToDate']);
      expect(msg).not.toMatch(/up to date/i);
    }
  });

  it('launch check failure shows nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLaunchCheck(() => Promise.reject(new Error(NET)))).toEqual({ status: 'idle' });
    expect(await runLaunchCheck(() => Promise.reject(SIG))).toEqual({ status: 'idle' });
    expect(await runLaunchCheck(async () => null)).toEqual({ status: 'idle' });
  });

  it('signature failure is distinguishable from network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sig = await runManualCheck({ isDisabled: async () => false, check: () => Promise.reject(SIG) });
    const net = await runManualCheck({
      isDisabled: async () => false,
      check: () => Promise.reject('error sending request for url (https://example.invalid/latest.json)'),
    });
    expect(sig).toEqual({ status: 'failed', kind: 'signature' });
    expect(net).toEqual({ status: 'failed', kind: 'network' });
    expect(classifyUpdateFailure('Invalid encoding in minisign data')).toBe('signature');
    expect(classifyUpdateFailure('Unsupported OS')).toBe('other');
  });

  it('manual success paths are unchanged', async () => {
    expect(await runManualCheck({ isDisabled: async () => true, check: async () => null })).toEqual({ status: 'disabled' });
    expect(await runManualCheck({ isDisabled: async () => false, check: async () => null })).toEqual({ status: 'uptodate' });
    expect(await runManualCheck({ isDisabled: async () => false, check: async () => ({ version: '9.9.9' }) })).toEqual({
      status: 'available',
      version: '9.9.9',
    });
  });
});
