import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  barView,
  classifyUpdateFailure,
  runInstallClick,
  runManualCheck,
  shouldPrepareAutomatically,
  type BarInputs,
  type UpdateDeps,
  type UpdatePrefs,
  type UpdateStatus,
} from '../src/renderer/lib/update-check';
import { DIALOG_STRINGS as chromeEn } from '../src/renderer/i18n-dialogs';

const BOTH_ON: UpdatePrefs = { checkOnLaunch: true, applyAutomatically: true };
const APPLY_OFF: UpdatePrefs = { checkOnLaunch: true, applyAutomatically: false };

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return { policyDisabled: false, container: 'installed', phase: 'idle', ...over };
}

function deps(s: UpdateStatus, found: { version: string } | null | Error = { version: '2026.1020.160' }) {
  const d = {
    status: vi.fn(async () => s),
    check: vi.fn(async () => {
      if (found instanceof Error) throw found;
      return found;
    }),
    prepare: vi.fn(async () => {}),
  };
  return d satisfies UpdateDeps;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('preference precedence', () => {
  it('the policy outranks the preferences', () => {
    expect(shouldPrepareAutomatically(status({ policyDisabled: true }), BOTH_ON)).toBe(false);
    expect(shouldPrepareAutomatically(status(), APPLY_OFF)).toBe(false);
  });

  it('notify-only containers never prepare', () => {
    expect(shouldPrepareAutomatically(status({ container: 'unsupported' }), BOTH_ON)).toBe(false);
    expect(shouldPrepareAutomatically(status({ container: 'portable' }), BOTH_ON)).toBe(true);
  });

  it('a version whose apply failed waits for an Install click', async () => {
    const failed = status({ failedVersion: '2026.1020.160' });
    expect(shouldPrepareAutomatically(failed, BOTH_ON, '2026.1020.160')).toBe(false);
    expect(shouldPrepareAutomatically(failed, BOTH_ON, '2026.1027.161')).toBe(true);
    const d = deps(failed);
    expect(await runManualCheck(d, BOTH_ON)).toEqual({ status: 'available', version: '2026.1020.160', preparing: false });
    expect(d.prepare).not.toHaveBeenCalled();
    const base: BarInputs = {
      status: status({ phase: 'available', version: '2026.1020.160', failedVersion: '2026.1020.160' }),
      prefs: BOTH_ON,
      manual: null,
      dismissedPhase: null,
      showLastApply: false,
      failedFrom: null,
    };
    expect(barView(base)).toEqual({ kind: 'available', version: '2026.1020.160', install: true });
  });
});

describe('manual check', () => {
  it('ignores the launch preference', async () => {
    const d = deps(status());
    const outcome = await runManualCheck(d, { checkOnLaunch: false, applyAutomatically: false });
    expect(d.check).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'available', version: '2026.1020.160', preparing: false });
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it('starts the download when automatic apply is on', async () => {
    const d = deps(status());
    const outcome = await runManualCheck(d, BOTH_ON);
    expect(outcome).toEqual({ status: 'available', version: '2026.1020.160', preparing: true });
    expect(d.prepare).toHaveBeenCalledTimes(1);
    expect(d.prepare).toHaveBeenCalledWith(true);
  });

  it('reports the policy without asking the network', async () => {
    const d = deps(status({ policyDisabled: true }));
    expect(await runManualCheck(d, BOTH_ON)).toEqual({ status: 'disabled' });
    expect(d.check).not.toHaveBeenCalled();
  });

  it('reports up to date and every failure kind', async () => {
    expect(await runManualCheck(deps(status(), null), BOTH_ON)).toEqual({ status: 'uptodate' });
    const net = deps(status());
    net.check.mockRejectedValueOnce({ kind: 'network' });
    expect(await runManualCheck(net, BOTH_ON)).toEqual({ status: 'failed', kind: 'network' });
    const sig = deps(status());
    sig.check.mockRejectedValueOnce({ kind: 'signature' });
    expect(await runManualCheck(sig, BOTH_ON)).toEqual({ status: 'failed', kind: 'signature' });
    const disabled = deps(status());
    disabled.check.mockRejectedValueOnce({ kind: 'disabled' });
    expect(await runManualCheck(disabled, BOTH_ON)).toEqual({ status: 'disabled' });
  });

  it('a notify-only container never prepares', async () => {
    const d = deps(status({ container: 'unsupported' }));
    expect(await runManualCheck(d, BOTH_ON)).toEqual({ status: 'available', version: '2026.1020.160', preparing: false });
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it('classifies only typed errors', () => {
    expect(classifyUpdateFailure({ kind: 'network' })).toBe('network');
    expect(classifyUpdateFailure({ kind: 'bogus' })).toBe('other');
    expect(classifyUpdateFailure('error sending request')).toBe('other');
    expect(classifyUpdateFailure(null)).toBe('other');
  });

  it('failed messages never claim the app is current', () => {
    for (const k of ['failedNetwork', 'failedOther', 'failedSignature']) {
      const msg = chromeEn[`dialog.update.${k}` as keyof typeof chromeEn];
      expect(msg).toMatch(/^Could not check for updates\./);
      expect(msg).not.toMatch(/up to date/i);
    }
  });
});

describe('install click', () => {
  it('prepares only when the click asks', async () => {
    const d = deps(status({ phase: 'available', version: '2026.1020.160' }));
    expect(await runInstallClick(d)).toBe(true);
    expect(d.prepare).toHaveBeenCalledTimes(1);
    expect(d.prepare).toHaveBeenCalledWith(false);
  });

  it('refuses under the policy and in a notify-only container', async () => {
    const managed = deps(status({ policyDisabled: true }));
    expect(await runInstallClick(managed)).toBe(false);
    const linux = deps(status({ container: 'unsupported' }));
    expect(await runInstallClick(linux)).toBe(false);
    expect(managed.prepare).not.toHaveBeenCalled();
    expect(linux.prepare).not.toHaveBeenCalled();
  });
});

describe('bar view', () => {
  const base: BarInputs = {
    status: status(),
    prefs: BOTH_ON,
    manual: null,
    dismissedPhase: null,
    showLastApply: false,
    failedFrom: null,
  };

  it('shows nothing when idle', () => {
    expect(barView(base)).toEqual({ kind: 'none' });
  });

  it('shows download progress', () => {
    expect(barView({ ...base, status: status({ phase: 'downloading', received: 25, total: 100 }) })).toEqual({
      kind: 'downloading',
      version: undefined,
      percent: 25,
    });
    expect(barView({ ...base, status: status({ phase: 'downloading' }) })).toMatchObject({ percent: null });
  });

  it('offers a restart when ready', () => {
    expect(barView({ ...base, status: status({ phase: 'ready', version: '1.0.1' }) })).toEqual({ kind: 'ready', version: '1.0.1' });
  });

  it('offers Install only with automatic apply off', () => {
    const available = status({ phase: 'available', version: '1.0.1' });
    expect(barView({ ...base, status: available, prefs: APPLY_OFF })).toEqual({ kind: 'available', version: '1.0.1', install: true });
    expect(barView({ ...base, status: available })).toEqual({ kind: 'available', version: '1.0.1', install: false });
  });

  it('keeps notify-only for an unsupported container', () => {
    const available = status({ phase: 'available', version: '1.0.1', container: 'unsupported' });
    expect(barView({ ...base, status: available, prefs: APPLY_OFF })).toEqual({ kind: 'available', version: '1.0.1', install: false });
  });

  it('a failed check stays silent unless the user asked', () => {
    const failed = status({ phase: 'failed', failure: 'network' });
    expect(barView({ ...base, status: failed, failedFrom: 'checking' })).toEqual({ kind: 'none' });
    expect(barView({ ...base, status: failed, failedFrom: null })).toEqual({ kind: 'none' });
    expect(barView({ ...base, status: failed, failedFrom: 'checking', manual: { status: 'failed', kind: 'network' } })).toEqual({
      kind: 'checkFailed',
      failure: 'network',
    });
  });

  it('a dismissed phase stays hidden until the phase changes', () => {
    const failed = status({ phase: 'failed', failure: 'network' });
    expect(barView({ ...base, status: failed, failedFrom: 'downloading' })).toEqual({ kind: 'prepareFailed' });
    expect(barView({ ...base, status: failed, failedFrom: 'verifying', dismissedPhase: 'failed' })).toEqual({ kind: 'none' });
    expect(barView({ ...base, status: status({ phase: 'downloading' }), dismissedPhase: 'failed' }).kind).toBe('downloading');
  });

  it('shows a manual outcome while the status is idle', () => {
    expect(barView({ ...base, manual: 'checking' })).toEqual({ kind: 'checking' });
    expect(barView({ ...base, manual: { status: 'uptodate' } })).toEqual({ kind: 'uptodate' });
    expect(barView({ ...base, manual: { status: 'disabled' } })).toEqual({ kind: 'managed' });
    expect(barView({ ...base, manual: { status: 'failed', kind: 'signature' } })).toEqual({ kind: 'checkFailed', failure: 'signature' });
  });

  it('shows the last apply outcome once, behind any live state', () => {
    const applied = status({ lastApply: { outcome: 'deferred', version: '1.0.1' } });
    expect(barView({ ...base, status: applied, showLastApply: true })).toEqual({ kind: 'applied', outcome: 'deferred', version: '1.0.1' });
    expect(barView({ ...base, status: applied, showLastApply: false })).toEqual({ kind: 'none' });
    const busy = status({ phase: 'downloading', lastApply: { outcome: 'installed', version: '1.0.1' } });
    expect(barView({ ...base, status: busy, showLastApply: true }).kind).toBe('downloading');
  });
});
