// The renderer's ONE Ghostscript answer (lib/gs-capability), and the
// decisions the 25 gs-bearing surfaces take from it.
//
// Ghostscript is a user-supplied prerequisite: the distribution ships none.
// Three resolvers used to answer this question independently and each
// returned a PATH — a string a spawn can fail on rather than an answer a
// surface can render. What is tested here is the collapse: one probe per
// session, one refusal, one live answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { gsCapability: vi.fn(), refreshGsCapability: vi.fn() },
}));

import { app } from '../src/renderer/lib/tauri-bridge';
import {
  GS_NOT_CONFIGURED,
  GS_NOT_EXECUTABLE,
  GS_PROBE_FAILED,
  GS_UNRESOLVED,
  GS_VERSION_BELOW_MINIMUM,
  GsUnavailableError,
  ensureGsCapability,
  gsBlocked,
  gsCapability,
  gsPathIfAvailable,
  gsStateKey,
  openGsSetup,
  refreshGsCapability,
  registerGsSetupOpener,
  requireGsPath,
  resetGsCapability,
  subscribeGsCapability,
} from '../src/renderer/lib/gs-capability';

const probe = vi.mocked(app.gsCapability);
const reprobe = vi.mocked(app.refreshGsCapability);

const ready = {
  available: true,
  path: 'C:\\Program Files\\gs\\gs10.07.1\\bin\\gswin64c.exe',
  version: '10.07.1',
  reason: '',
  detail: '',
};
const absent = { available: false, path: '', version: '', reason: GS_NOT_CONFIGURED, detail: '' };

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  resetGsCapability();
  probe.mockReset();
  reprobe.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('the session answer', () => {
  it('starts UNRESOLVED, and unresolved is not a refusal', () => {
    // A surface disabled on a pending answer flashes disabled on every
    // launch and then ungrays — so pending must not read as absent.
    expect(gsCapability().pending).toBe(true);
    expect(gsCapability().reason).toBe(GS_UNRESOLVED);
    expect(gsBlocked()).toBe(false);
    expect(gsStateKey()).toBeNull();
  });

  it('probes ONCE for a whole session, however many surfaces ask', async () => {
    probe.mockResolvedValue(ready);
    const answers = await Promise.all([
      ensureGsCapability(),
      ensureGsCapability(),
      ensureGsCapability(),
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    for (const a of answers) expect(a.available).toBe(true);
    expect(await ensureGsCapability()).toBe(gsCapability()); // settled: no IPC
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('RETRIES after a failed probe rather than caching the failure', async () => {
    // The fixed regression this inherits: one early IPC hiccup used to leave
    // a permanently rejected promise that killed every gs feature for the
    // rest of the session.
    probe.mockRejectedValueOnce(new Error('ipc died'));
    expect((await ensureGsCapability()).pending).toBe(true);
    probe.mockResolvedValueOnce(ready);
    expect((await ensureGsCapability()).available).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('asks about the CONFIGURED path, and about discovery when there is none', async () => {
    probe.mockResolvedValue(ready);
    await ensureGsCapability();
    // '' is "find one", never "use the bundled copy" — there is no bundled
    // copy to fall back to.
    expect(probe).toHaveBeenLastCalledWith(undefined);

    resetGsCapability();
    store.set('spectra-settings', JSON.stringify({ gsPath: 'D:\\gs\\gswin64c.exe' }));
    await ensureGsCapability();
    expect(probe).toHaveBeenLastCalledWith('D:\\gs\\gswin64c.exe');
  });
});

describe('the refusal', () => {
  it('requireGsPath throws a NAMED refusal carrying the reason', async () => {
    probe.mockResolvedValue({ ...absent, reason: GS_NOT_EXECUTABLE });
    await expect(requireGsPath()).rejects.toBeInstanceOf(GsUnavailableError);
    await requireGsPath().catch((e: GsUnavailableError) => {
      expect(e.reason).toBe(GS_NOT_EXECUTABLE);
      expect(e.message).toContain('Ghostscript');
    });
  });

  it('requireGsPath returns the PROBED path when there is one', async () => {
    probe.mockResolvedValue(ready);
    expect(await requireGsPath()).toBe(ready.path);
  });

  it("gsPathIfAvailable is '' rather than a throw — the PARTIAL doors", async () => {
    // Create PDF's images, Compare's text mode, Preflight's structural
    // checks: the operation runs, and only its gs leg is refused.
    probe.mockResolvedValue(absent);
    expect(await gsPathIfAvailable()).toBe('');
    resetGsCapability();
    probe.mockResolvedValue(ready);
    expect(await gsPathIfAvailable()).toBe(ready.path);
  });

  it('names each failure state with its OWN key', async () => {
    const key = async (reason: string): Promise<string | null> => {
      resetGsCapability();
      probe.mockResolvedValue({ ...absent, reason });
      return gsStateKey(await ensureGsCapability());
    };
    expect(await key(GS_NOT_CONFIGURED)).toBe('panel.common.gsRequired');
    expect(await key(GS_NOT_EXECUTABLE)).toBe('panel.common.gsNotExecutable');
    expect(await key(GS_PROBE_FAILED)).toBe('panel.common.gsProbeFailed');
    expect(await key(GS_VERSION_BELOW_MINIMUM)).toBe('panel.common.gsTooOld');
  });

  it('blocks only a SETTLED absence', async () => {
    probe.mockResolvedValue(absent);
    await ensureGsCapability();
    expect(gsBlocked()).toBe(true);
    expect(gsStateKey()).toBe('panel.common.gsRequired');
  });
});

describe('the answer is LIVE', () => {
  it('a refresh publishes to every subscriber — no restart', async () => {
    probe.mockResolvedValue(absent);
    await ensureGsCapability();
    expect(gsBlocked()).toBe(true);

    const seen: boolean[] = [];
    const stop = subscribeGsCapability(() => seen.push(gsCapability().available));
    reprobe.mockResolvedValue(ready);
    // Installing Ghostscript and pointing the setting at it lights the
    // disabled surfaces up in place.
    await refreshGsCapability(ready.path);
    expect(seen).toEqual([true]);
    expect(gsBlocked()).toBe(false);
    expect(gsCapability().version).toBe('10.07.1');

    stop();
    reprobe.mockResolvedValue(absent);
    await refreshGsCapability('');
    expect(seen).toEqual([true]); // unsubscribed
    expect(gsBlocked()).toBe(true); // ...and it can go BACK
  });

  it('a refresh with no argument re-reads the configured path', async () => {
    store.set('spectra-settings', JSON.stringify({ gsPath: 'E:\\gs.exe' }));
    reprobe.mockResolvedValue(ready);
    await refreshGsCapability();
    expect(reprobe).toHaveBeenLastCalledWith('E:\\gs.exe');
  });

  it('a refresh whose IPC fails reports a probe failure, not a pending answer', async () => {
    reprobe.mockRejectedValue(new Error('no'));
    const answer = await refreshGsCapability('X:\\nothing.exe');
    expect(answer.pending).toBe(false);
    expect(answer.reason).toBe(GS_PROBE_FAILED);
  });
});

describe('the set-up affordance', () => {
  it('routes every disabled surface to the ONE opener App registers', () => {
    const open = vi.fn();
    registerGsSetupOpener(open);
    openGsSetup();
    expect(open).toHaveBeenCalledTimes(1);
    registerGsSetupOpener(null);
    openGsSetup(); // an unmounted App is a no-op, never a throw
    expect(open).toHaveBeenCalledTimes(1);
  });
});
