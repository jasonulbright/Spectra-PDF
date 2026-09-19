// The output-root claim of the folder runs (Batch OCR, disk redact, the four
// folder tools). The arbiter's root claim is idempotent per window and its
// release drops the window's claim whatever preceded it. A dialog shows its
// finished phase before the run's release answers, so the next run's claim
// must not be processed ahead of that release: the release would then drop
// the claim the new run is writing under.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimRoot = vi.fn();
const releaseRoot = vi.fn();
vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  claims: {
    claim: vi.fn(),
    release: vi.fn(),
    claimOutputRoot: (path: string) => claimRoot(path),
    releaseOutputRoot: (path: string) => releaseRoot(path),
  },
}));

// A fresh module per test: its call order and its run holds are module state,
// as they are per window in the app.
let claimOutputRoot: typeof import('../src/renderer/lib/output-root-claim').claimOutputRoot;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A runtime that answers the newest call first, the order a busy one may pick. */
function arbiter() {
  const held = new Set<string>();
  const arrived: { name: string; process: () => void }[] = [];
  claimRoot.mockImplementation((root: string) => new Promise((resolve) => {
    arrived.push({ name: `claim ${root}`, process: () => { held.add(root); resolve({ granted: true, owner: '' }); } });
  }));
  releaseRoot.mockImplementation((root: string) => new Promise<void>((resolve) => {
    arrived.push({ name: `release ${root}`, process: () => { held.delete(root); resolve(); } });
  }));
  const drain = async (): Promise<string[]> => {
    const order: string[] = [];
    await flush();
    while (arrived.length > 0) {
      const call = arrived.pop()!;
      order.push(call.name);
      call.process();
      await flush();
    }
    return order;
  };
  return { held, drain };
}

beforeEach(async () => {
  vi.resetModules();
  ({ claimOutputRoot } = await import('../src/renderer/lib/output-root-claim'));
  claimRoot.mockReset();
  releaseRoot.mockReset();
});

describe('claimOutputRoot', () => {
  it('a new run’s claim is sent only after the finished run’s release answered', async () => {
    const { held, drain } = arbiter();
    const first = claimOutputRoot('C:/out');
    await drain();
    const run = await first;
    expect(run.granted).toBe(true);
    // The dialog shows "done" with the release in flight; the user starts the
    // next run before it answers.
    const releasing = run.release();
    await flush();
    const next = claimOutputRoot('C:/out');
    const order = await drain();
    await releasing;
    expect((await next).granted).toBe(true);
    expect(order).toEqual(['release C:/out', 'claim C:/out']);
    expect(held.has('C:/out')).toBe(true);
  });

  it('a release whose turn comes after the next run started is not sent', async () => {
    const { held, drain } = arbiter();
    const first = claimOutputRoot('C:/out');
    await drain();
    const run = await first;
    // The next run starts in the same turn as the release: it holds the root
    // by the time the release would go out.
    const releasing = run.release();
    const next = claimOutputRoot('C:/out');
    expect(await drain()).toEqual(['claim C:/out']);
    await releasing;
    expect((await next).granted).toBe(true);
    expect(held.has('C:/out')).toBe(true);
  });

  it('a claim is not sent while the release before it is unanswered', async () => {
    const sent: string[] = [];
    let answerRelease: () => void = () => {};
    claimRoot.mockImplementation(async (root: string) => {
      sent.push(`claim ${root}`);
      return { granted: true, owner: '' };
    });
    releaseRoot.mockImplementation((root: string) => new Promise<void>((resolve) => {
      sent.push(`release ${root}`);
      answerRelease = resolve;
    }));
    const run = await claimOutputRoot('C:/out');
    sent.length = 0;
    const releasing = run.release();
    await flush();
    const next = claimOutputRoot('C:/out');
    await flush();
    expect(sent).toEqual(['release C:/out']);
    answerRelease();
    await releasing;
    expect((await next).granted).toBe(true);
    expect(sent).toEqual(['release C:/out', 'claim C:/out']);
  });

  it('a run still stopping after its dialog closed does not take the next run’s claim with it', async () => {
    const { held, drain } = arbiter();
    const stopping = claimOutputRoot('C:/out');
    await drain();
    const first = await stopping;
    // Another dialog of the same window starts a run on the same folder.
    const starting = claimOutputRoot('C:/out');
    await drain();
    const second = await starting;
    // The stopping run ends, twice over: its release is kept both times.
    const ending = first.release();
    const endingAgain = first.release();
    expect(await drain()).toEqual([]);
    await Promise.all([ending, endingAgain]);
    expect(held.has('C:/out')).toBe(true);
    const done = second.release();
    expect(await drain()).toEqual(['release C:/out']);
    await done;
    expect(held.has('C:/out')).toBe(false);
  });

  it('calls on different roots do not wait for each other', async () => {
    const { drain } = arbiter();
    const a = claimOutputRoot('C:/a');
    const b = claimOutputRoot('C:/b');
    expect(await drain()).toEqual(['claim C:/b', 'claim C:/a']);
    await Promise.all([a, b]);
  });

  it('a failed release does not hold the next claim of that root back', async () => {
    claimRoot.mockResolvedValue({ granted: true, owner: '' });
    releaseRoot.mockRejectedValueOnce(new Error('window gone'));
    const run = await claimOutputRoot('C:/out');
    await run.release();
    await expect(claimOutputRoot('C:/out')).resolves.toMatchObject({ granted: true });
  });

  it('a refused claim names the folder and holds nothing to release', async () => {
    claimRoot.mockResolvedValueOnce({ granted: false, owner: 'doc-2' });
    const run = await claimOutputRoot('C:/out');
    expect(run.granted).toBe(false);
    expect(run.message).toContain('C:/out');
    await run.release();
    expect(releaseRoot).not.toHaveBeenCalled();
    // Nor does it keep a later run's release from going out.
    claimRoot.mockResolvedValueOnce({ granted: true, owner: '' });
    releaseRoot.mockResolvedValue(undefined);
    const later = await claimOutputRoot('C:/out');
    await later.release();
    expect(releaseRoot).toHaveBeenCalledTimes(1);
  });

  it('a claim that fails keeps no later run’s release from going out', async () => {
    claimRoot.mockRejectedValueOnce(new Error('window gone'));
    await expect(claimOutputRoot('C:/out')).rejects.toThrow('window gone');
    claimRoot.mockResolvedValueOnce({ granted: true, owner: '' });
    releaseRoot.mockResolvedValue(undefined);
    const later = await claimOutputRoot('C:/out');
    await later.release();
    expect(releaseRoot).toHaveBeenCalledTimes(1);
  });

  it('an in-place run owns no root and calls nothing', async () => {
    const run = await claimOutputRoot('');
    expect(run.granted).toBe(true);
    await run.release();
    expect(claimRoot).not.toHaveBeenCalled();
    expect(releaseRoot).not.toHaveBeenCalled();
  });
});
