// What a launch reports once a window exists: the "Start with Windows"
// correction that could not be written, and the records the launch could not
// read (session.json, startup.json). Rust keeps each report until a window
// takes it, so one launch reports once; the next launch has nothing to take.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tChrome } from '../src/renderer/i18n';
import { reportLaunch, unreadableRecordNotice } from '../src/renderer/lib/launch-notices';
import type { UnreadableRecord } from '../src/renderer/lib/tauri-bridge';

const SESSION_ASIDE = 'C:\\data\\session.json.unreadable';
const STARTUP_ASIDE = 'C:\\data\\startup.json.unreadable';

describe('unreadableRecordNotice', () => {
  it('a session record moved aside names the lost restore and where the file went', () => {
    expect(unreadableRecordNotice({ record: 'session', keptAs: SESSION_ASIDE })).toEqual({
      title: tChrome('app.unreadableRecord.sessionTitle'),
      message: tChrome('app.unreadableRecord.session', { path: SESSION_ASIDE }),
    });
    expect(tChrome('app.unreadableRecord.session', { path: SESSION_ASIDE })).toContain(
      SESSION_ASIDE,
    );
  });

  it('a session record left in place names the lost restore and no path', () => {
    expect(unreadableRecordNotice({ record: 'session', keptAs: null })).toEqual({
      title: tChrome('app.unreadableRecord.sessionTitle'),
      message: tChrome('app.unreadableRecord.sessionInPlace'),
    });
  });

  it('a startup record moved aside names the lost settings and where the file went', () => {
    expect(unreadableRecordNotice({ record: 'startup', keptAs: STARTUP_ASIDE })).toEqual({
      title: tChrome('app.unreadableRecord.startupTitle'),
      message: tChrome('app.unreadableRecord.startup', { path: STARTUP_ASIDE }),
    });
  });

  it('a startup record left in place names the lost settings and no path', () => {
    expect(unreadableRecordNotice({ record: 'startup', keptAs: null })).toEqual({
      title: tChrome('app.unreadableRecord.startupTitle'),
      message: tChrome('app.unreadableRecord.startupInPlace'),
    });
  });

  it('the two records are told apart', () => {
    const session = unreadableRecordNotice({ record: 'session', keptAs: null });
    const startup = unreadableRecordNotice({ record: 'startup', keptAs: null });
    expect(session.title).not.toBe(startup.title);
    expect(session.message).not.toBe(startup.message);
  });
});

/** A launch whose Rust side answers with `entry` and `records`. `showNotice`
 * settles only when the test dismisses the notice. */
function launch(entry: string, records: UnreadableRecord[]) {
  const shown: string[] = [];
  const dismissals: (() => void)[] = [];
  const deps = {
    startupEntryNotice: vi.fn(async () => entry),
    takeUnreadableRecords: vi.fn(async () => records),
    saveStartupFlags: vi.fn(),
    showNotice: vi.fn(
      (title: string) =>
        new Promise<void>((done) => {
          shown.push(title);
          dismissals.push(done);
        }),
    ),
  };
  const dismiss = async (): Promise<void> => {
    dismissals.shift()?.();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { deps, shown, dismiss };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('reportLaunch', () => {
  it('shows one notice at a time, the startup entry first', async () => {
    const { deps, shown, dismiss } = launch('Access is denied.', [
      { record: 'session', keptAs: SESSION_ASIDE },
      { record: 'startup', keptAs: null },
    ]);
    const done = reportLaunch(deps);
    await flush();
    expect(shown).toEqual([tChrome('app.startupEntry.staleTitle')]);
    await dismiss();
    expect(shown).toEqual([
      tChrome('app.startupEntry.staleTitle'),
      tChrome('app.unreadableRecord.sessionTitle'),
    ]);
    await dismiss();
    expect(shown.at(-1)).toBe(tChrome('app.unreadableRecord.startupTitle'));
    await dismiss();
    await done;
    expect(deps.showNotice).toHaveBeenCalledTimes(3);
  });

  it('a lost startup record writes the flags back once, before any notice is dismissed', async () => {
    const { deps, dismiss } = launch('', [
      { record: 'startup', keptAs: STARTUP_ASIDE },
      { record: 'startup', keptAs: null },
    ]);
    const done = reportLaunch(deps);
    await flush();
    expect(deps.saveStartupFlags).toHaveBeenCalledTimes(1);
    await dismiss();
    await dismiss();
    await done;
    expect(deps.saveStartupFlags).toHaveBeenCalledTimes(1);
  });

  it('a lost session record alone does not rewrite the startup flags', async () => {
    const { deps, dismiss } = launch('', [{ record: 'session', keptAs: SESSION_ASIDE }]);
    const done = reportLaunch(deps);
    await flush();
    await dismiss();
    await done;
    expect(deps.saveStartupFlags).not.toHaveBeenCalled();
    expect(deps.showNotice).toHaveBeenCalledWith(
      tChrome('app.unreadableRecord.sessionTitle'),
      tChrome('app.unreadableRecord.session', { path: SESSION_ASIDE }),
    );
  });

  it('a launch with nothing to report shows nothing and writes nothing', async () => {
    const { deps } = launch('', []);
    await reportLaunch(deps);
    expect(deps.showNotice).not.toHaveBeenCalled();
    expect(deps.saveStartupFlags).not.toHaveBeenCalled();
  });

  it('a failed read of one report still shows the other', async () => {
    const records = launch('', [{ record: 'session', keptAs: null }]);
    records.deps.startupEntryNotice.mockRejectedValue(new Error('no window'));
    const withRecords = reportLaunch(records.deps);
    await flush();
    await records.dismiss();
    await expect(withRecords).resolves.toBeUndefined();
    expect(records.deps.showNotice).toHaveBeenCalledTimes(1);

    const entry = launch('Access is denied.', []);
    entry.deps.takeUnreadableRecords.mockRejectedValue(new Error('no window'));
    const withEntry = reportLaunch(entry.deps);
    await flush();
    await entry.dismiss();
    await expect(withEntry).resolves.toBeUndefined();
    expect(entry.deps.showNotice).toHaveBeenCalledWith(
      tChrome('app.startupEntry.staleTitle'),
      tChrome('app.startupEntry.stale', { detail: 'Access is denied.' }),
    );
  });
});

describe('App reports the launch once, from mount', () => {
  const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('takes both reports through reportLaunch', () => {
    expect(app).toContain('void reportLaunch({');
    expect(app).toContain('startupEntryNotice: () => app.startupEntryNotice(),');
    expect(app).toContain('takeUnreadableRecords: () => app.takeUnreadableRecords(),');
    // The startup entry notice goes through reportLaunch only, so it shows
    // before the record notices.
    expect(app).not.toMatch(/\.startupEntryNotice\(\)\s*\.then\(/);
  });

  it('takes the records through the command Rust registers', () => {
    // A command the bridge names and Rust does not register rejects, and the
    // launch report swallows that rejection: the notice would never show.
    const read = (path: string): string =>
      readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
    expect(read('src/renderer/lib/tauri-bridge.ts')).toContain(
      "invoke<UnreadableRecord[]>('take_unreadable_records')",
    );
    expect(read('src-tauri/src/commands.rs')).toContain('pub async fn take_unreadable_records(');
    expect(read('src-tauri/src/lib.rs')).toContain('commands::take_unreadable_records,');
  });

  it('writes the startup flags back from this window’s preferences', () => {
    const effect = app.slice(app.indexOf('void reportLaunch({'));
    const save = effect.slice(0, effect.indexOf('showNotice,'));
    expect(save).toContain('const settings = getSettings();');
    expect(save).toContain('app.setStartMinimized(settings.startMinimized)');
    expect(save).toContain('app.setRestoreWindowsOnLaunch(settings.restoreWindowsOnLaunch)');
  });
});
