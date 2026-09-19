// The output-folder claim of the folder runs (Batch OCR, disk redact, the four
// folder tools, Guided Actions folder runs). The claim belongs to one RUN: the
// arbiter refuses a second run of the same window on a conflicting folder, and
// a release names its own run's token, so it can never free another run's
// folders. What this module still owes is the order of one window's calls: a
// finished run's release that has not answered still holds its folders, so the
// next run's claim must not be processed ahead of it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tChrome } from '../src/renderer/i18n';

const claimRoots = vi.fn();
const releaseRoots = vi.fn();
vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  claims: {
    claim: vi.fn(),
    release: vi.fn(),
    claimOutputRoots: (paths: string[]) => claimRoots(paths),
    releaseOutputRoots: (token: number) => releaseRoots(token),
  },
}));

type ClaimModule = typeof import('../src/renderer/lib/output-root-claim');

// A fresh module per test: its call order is module state, as it is per window
// in the app.
let claimOutputRoots: ClaimModule['claimOutputRoots'];
let writtenRoots: ClaimModule['writtenRoots'];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const granted = (token: number) => ({
  granted: true,
  owner: '',
  sameWindow: false,
  folder: '',
  token,
});

const refused = (owner: string, sameWindow: boolean, folder: string) => ({
  granted: false,
  owner,
  sameWindow,
  folder,
  token: null,
});

beforeEach(async () => {
  vi.resetModules();
  ({ claimOutputRoots, writtenRoots } = await import('../src/renderer/lib/output-root-claim'));
  claimRoots.mockReset();
  releaseRoots.mockReset();
});

describe('claimOutputRoots', () => {
  it('claims every folder of one run in one call and skips empty entries', async () => {
    claimRoots.mockResolvedValue(granted(1));
    const run = await claimOutputRoots(['C:/out', '', 'C:/moved']);
    expect(run.granted).toBe(true);
    expect(claimRoots).toHaveBeenCalledTimes(1);
    expect(claimRoots).toHaveBeenCalledWith(['C:/out', 'C:/moved']);
  });

  it('a run with no folder to claim calls nothing, and neither does its release', async () => {
    const run = await claimOutputRoots(['', '']);
    expect(run.granted).toBe(true);
    await run.release();
    expect(claimRoots).not.toHaveBeenCalled();
    expect(releaseRoots).not.toHaveBeenCalled();
  });

  it('a refusal by another window names the folder the arbiter reports', async () => {
    claimRoots.mockResolvedValue(refused('doc-2', false, 'C:\\Out'));
    const run = await claimOutputRoots(['c:/out']);
    expect(run.granted).toBe(false);
    expect(run.message).toBe(tChrome('app.window.folderBusy', { folder: 'C:\\Out' }));
    await run.release();
    expect(releaseRoots).not.toHaveBeenCalled();
  });

  it('a refusal by a run of this window says that a run here is still writing', async () => {
    claimRoots.mockResolvedValue(refused('main', true, 'C:\\out\\sub'));
    const run = await claimOutputRoots(['C:/out/sub']);
    expect(run.granted).toBe(false);
    expect(run.message).toBe(tChrome('app.window.folderBusyHere', { folder: 'C:\\out\\sub' }));
    expect(run.message).not.toBe(tChrome('app.window.folderBusy', { folder: 'C:\\out\\sub' }));
  });

  it('a release gives back its own run by token, once', async () => {
    claimRoots.mockResolvedValueOnce(granted(7)).mockResolvedValueOnce(granted(8));
    releaseRoots.mockResolvedValue(undefined);
    const first = await claimOutputRoots(['C:/a']);
    const second = await claimOutputRoots(['C:/b']);
    await first.release();
    await first.release();
    expect(releaseRoots).toHaveBeenCalledTimes(1);
    expect(releaseRoots).toHaveBeenCalledWith(7);
    await second.release();
    expect(releaseRoots).toHaveBeenLastCalledWith(8);
  });

  it('a claim is not sent while an earlier release is unanswered, on the same folder', async () => {
    const sent: string[] = [];
    let answerRelease: () => void = () => {};
    claimRoots.mockImplementation(async (paths: string[]) => {
      sent.push(`claim ${paths.join(',')}`);
      return granted(sent.length);
    });
    releaseRoots.mockImplementation(
      (token: number) =>
        new Promise<void>((done) => {
          sent.push(`release ${token}`);
          answerRelease = done;
        }),
    );
    const run = await claimOutputRoots(['C:/out']);
    sent.length = 0;
    const releasing = run.release();
    await flush();
    const next = claimOutputRoots(['C:/out']);
    await flush();
    expect(sent).toEqual(['release 1']);
    answerRelease();
    await releasing;
    expect((await next).granted).toBe(true);
    expect(sent).toEqual(['release 1', 'claim C:/out']);
  });

  it('a claim is not sent while an earlier release is unanswered, on a nested folder', async () => {
    const sent: string[] = [];
    let answerRelease: () => void = () => {};
    claimRoots.mockImplementation(async (paths: string[]) => {
      sent.push(`claim ${paths.join(',')}`);
      return granted(sent.length);
    });
    releaseRoots.mockImplementation(
      (token: number) =>
        new Promise<void>((done) => {
          sent.push(`release ${token}`);
          answerRelease = done;
        }),
    );
    const run = await claimOutputRoots(['C:/out']);
    sent.length = 0;
    const releasing = run.release();
    await flush();
    // Nested folders conflict, so a queue keyed by folder would let this pass.
    const next = claimOutputRoots(['C:/out/sub']);
    await flush();
    expect(sent).toEqual(['release 1']);
    answerRelease();
    await releasing;
    await next;
    expect(sent).toEqual(['release 1', 'claim C:/out/sub']);
  });

  it('a failed release is swallowed and does not hold the next claim back', async () => {
    claimRoots.mockResolvedValue(granted(3));
    releaseRoots.mockRejectedValueOnce(new Error('window gone'));
    const run = await claimOutputRoots(['C:/out']);
    await expect(run.release()).resolves.toBeUndefined();
    await expect(claimOutputRoots(['C:/out'])).resolves.toMatchObject({ granted: true });
  });

  it('a claim that fails rejects, and keeps no later claim waiting', async () => {
    claimRoots.mockRejectedValueOnce(new Error('window gone'));
    await expect(claimOutputRoots(['C:/out'])).rejects.toThrow('window gone');
    claimRoots.mockResolvedValueOnce(granted(4));
    releaseRoots.mockResolvedValue(undefined);
    const later = await claimOutputRoots(['C:/out']);
    await later.release();
    expect(releaseRoots).toHaveBeenCalledWith(4);
  });
});

describe('writtenRoots', () => {
  it('a mirror run writes its destination', () => {
    expect(writtenRoots({ source: 'C:/in', dest: 'C:/out', inPlace: false })).toEqual(['C:/out']);
  });

  it('an in-place run writes its source tree and has no destination', () => {
    expect(writtenRoots({ source: 'C:/in', dest: 'C:/out', inPlace: true })).toEqual(['C:/in']);
    expect(
      writtenRoots({ source: 'C:/in', dest: '', inPlace: true, filing: ['C:/errors'] }),
    ).toEqual(['C:/in', 'C:/errors']);
  });

  it('a mirror run that moves or replaces originals writes its source tree too', () => {
    expect(
      writtenRoots({ source: 'C:/in', dest: 'C:/out', inPlace: false, changesSource: true }),
    ).toEqual(['C:/out', 'C:/in']);
  });

  it('every folder originals move into is written, and empty ones are skipped', () => {
    expect(
      writtenRoots({
        source: 'C:/in',
        dest: 'C:/out',
        inPlace: false,
        filing: ['C:/moved', null, undefined, '', 'C:/errors'],
        changesSource: true,
      }),
    ).toEqual(['C:/out', 'C:/in', 'C:/moved', 'C:/errors']);
  });
});

describe('the folder runs claim what they write', () => {
  const source = (path: string): string =>
    readFileSync(resolve(__dirname, '../src/renderer', path), 'utf8').replace(/\r\n/g, '\n');

  /** The text of one function, from its declaration to the next marker. */
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    expect(start, `missing: ${from}`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start + from.length);
    expect(end, `missing: ${to}`).toBeGreaterThan(start);
    return text.slice(start, end);
  };

  // Reads every renderer source file; the default timeout fails it on a loaded
  // machine.
  it('no renderer file calls a single-folder claim or release', { timeout: 30_000 }, () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    const stale = walk(resolve(__dirname, '../src/renderer')).filter((path) =>
      /claimOutputRoot\(|releaseOutputRoot\(/.test(readFileSync(path, 'utf8')),
    );
    expect(stale).toEqual([]);
  });

  it('the mirror-only folder tools claim their destination', () => {
    for (const dialog of ['components/FolderExportDialog.tsx', 'components/FolderCreatePdfDialog.tsx']) {
      expect(source(dialog), dialog).toContain('const root = await claimOutputRoots([dest]);');
    }
  });

  it('disk redact and form prep claim the source tree when they write in place', () => {
    for (const dialog of ['components/DiskRedactDialog.tsx', 'components/FolderFormPrepDialog.tsx']) {
      expect(source(dialog), dialog).toContain(
        "writtenRoots({ source: source ?? '', dest: dest ?? '', inPlace }),",
      );
    }
  });

  it('a preflight fix that files originals claims the source tree and the filing folder', () => {
    const run = between(source('components/FolderPreflightDialog.tsx'), 'const run = useCallback(', 'setPhase(\'running\');');
    expect(run).toContain(
      "const moving = settings.mode === 'fix' && !settings.inPlace && settings.movedRoot !== '';",
    );
    expect(run).toContain('inPlace: settings.inPlace,');
    expect(run).toContain('filing: moving ? [settings.movedRoot] : [],');
    expect(run).toContain('changesSource: moving,');
  });

  it('batch OCR claims before it writes, in place and mirrored, and releases after', () => {
    const dialog = source('components/BatchOcrDialog.tsx');
    const inPlace = between(dialog, 'const startInPlace = async', 'const start = async');
    expect(inPlace.indexOf('claimOutputRoots(')).toBeGreaterThanOrEqual(0);
    expect(inPlace.indexOf('claimOutputRoots(')).toBeLessThan(inPlace.indexOf("callRaw('batch_ocr'"));
    expect(inPlace.indexOf('claimOutputRoots(')).toBeLessThan(inPlace.indexOf("setPhase('running')"));
    expect(inPlace).toContain("writtenRoots({ source, dest: '', inPlace: true, filing: [errorRoot] })");
    expect(inPlace).toMatch(/\} finally \{\n\s+await root\.release\(\);/);

    const mirror = between(dialog, 'const start = async', 'const cancel = ');
    expect(mirror).toContain('filing: [movedRoot, errorRoot],');
    expect(mirror).toContain(
      'changesSource: Boolean(movedRoot) || Boolean(errorRoot) || (repairDamaged && replaceRepaired),',
    );
    expect(mirror).toMatch(/\} finally \{\n\s+cancelOcrRef\.current = null;\n\s+await root\.release\(\);/);
  });

  it('a Guided Actions folder run claims before its engine call and releases after', () => {
    const run = between(
      source('panels/GuidedActionsPanel.tsx'),
      'const executeFolderRun = useCallback(',
      'const runActionOnFolder = useCallback(',
    );
    const claim = run.indexOf('root = await claimOutputRoots(writtenRoots({ source, dest, inPlace }));');
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(run.indexOf("callRaw('run_action'"));
    expect(run).toContain('if (!root.granted) throw new Error(root.message);');
    expect(run).toMatch(/\} finally \{\n\s+setRunning\(false\);\n\s+await root\?\.release\(\);/);
  });
});

describe('the bridge sends what the arbiter declares', () => {
  const read = (path: string): string =>
    readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

  /** The parameter list of one Rust command. */
  const parameters = (rust: string, command: string): string => {
    const start = rust.indexOf(`pub async fn ${command}(`);
    expect(start, `missing command: ${command}`).toBeGreaterThanOrEqual(0);
    return rust.slice(start, rust.indexOf(') -> ', start));
  };

  it('the run-claim commands keep one name and one argument key on both sides', () => {
    // An invoke whose name or argument key Rust does not declare rejects at
    // run time only: a claim that cannot be sent stops every folder run, and a
    // release that cannot be sent keeps its folders claimed until the window
    // closes.
    const bridge = read('src/renderer/lib/tauri-bridge.ts');
    expect(bridge).toContain("invoke<RunClaimResult>('claim_output_roots', { paths })");
    expect(bridge).toContain("invoke<void>('release_output_roots', { token })");
    const arbiter = read('src-tauri/src/app_windows.rs');
    expect(parameters(arbiter, 'claim_output_roots')).toContain('paths: Vec<String>,');
    expect(parameters(arbiter, 'release_output_roots')).toContain('token: u64,');
    const handlers = read('src-tauri/src/lib.rs');
    expect(handlers).toContain('app_windows::claim_output_roots,');
    expect(handlers).toContain('app_windows::release_output_roots,');
  });
});
