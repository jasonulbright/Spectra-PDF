import { describe, expect, it, vi } from 'vitest';
import { closeThroughWrites, waitForWrites, withdrawRequest, type CloseOutcome } from '../src/renderer/lib/close-writes';

describe('closeThroughWrites', () => {
  it('closes at once when nothing is writing', async () => {
    const close = vi.fn(async (): Promise<CloseOutcome> => 'closed');
    const wait = vi.fn();
    await expect(closeThroughWrites(close, wait)).resolves.toBe('closed');
    expect(close).toHaveBeenCalledWith(false);
    expect(wait).not.toHaveBeenCalled();
  });

  it('asks again without force when the writes finished', async () => {
    const outcomes: CloseOutcome[] = ['writing', 'closed'];
    const close = vi.fn(async () => outcomes.shift()!);
    await expect(closeThroughWrites(close, async () => 'drained')).resolves.toBe('closed');
    expect(close.mock.calls).toEqual([[false], [false]]);
  });

  it('forces the close only when the user chose to quit anyway', async () => {
    const outcomes: CloseOutcome[] = ['writing', 'closed'];
    const close = vi.fn(async () => outcomes.shift()!);
    await expect(closeThroughWrites(close, async () => 'quit')).resolves.toBe('closed');
    expect(close.mock.calls).toEqual([[false], [true]]);
  });

  it('keeps the window when the user cancels', async () => {
    const close = vi.fn(async (): Promise<CloseOutcome> => 'writing');
    await expect(closeThroughWrites(close, async () => 'stay')).resolves.toBe('stayed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes an aborted session capture through', async () => {
    await expect(closeThroughWrites(async () => 'aborted', async () => 'drained')).resolves.toBe('aborted');
  });
});

describe('waitForWrites', () => {
  function deps(current: number) {
    let answer: (quit: boolean) => void = () => {};
    let emit: (count: number) => void = () => {};
    const withdraw = vi.fn();
    const unlisten = vi.fn();
    return {
      answer: (quit: boolean) => answer(quit),
      emit: (count: number) => emit(count),
      withdraw,
      unlisten,
      deps: {
        ask: () => new Promise<boolean>((resolve) => { answer = resolve; }),
        withdraw,
        listen: async (onCount: (count: number) => void) => { emit = onCount; return unlisten; },
        current: async () => current,
      },
    };
  }

  it('ends by itself when the writes finish, withdrawing the choice', async () => {
    const d = deps(1);
    const run = waitForWrites(d.deps);
    await Promise.resolve();
    await Promise.resolve();
    d.emit(1);
    d.emit(0);
    await expect(run).resolves.toBe('drained');
    expect(d.withdraw).toHaveBeenCalledOnce();
    expect(d.unlisten).toHaveBeenCalledOnce();
  });

  it('sees a finish that landed before it subscribed', async () => {
    const d = deps(0);
    await expect(waitForWrites(d.deps)).resolves.toBe('drained');
    expect(d.withdraw).toHaveBeenCalledOnce();
  });

  it('reports the choice when the user answers first', async () => {
    const quit = deps(2);
    const run = waitForWrites(quit.deps);
    quit.answer(true);
    await expect(run).resolves.toBe('quit');
    const stay = deps(2);
    const kept = waitForWrites(stay.deps);
    stay.answer(false);
    await expect(kept).resolves.toBe('stay');
    stay.emit(0);
    expect(stay.withdraw).not.toHaveBeenCalled();
  });
});

describe('withdrawRequest', () => {
  it('withdraws only the finishing dialog, on screen or queued', async () => {
    const { createConfirmQueue } = await import('../src/renderer/lib/confirm-queue');
    const shown: (number | null)[] = [];
    const queue = createConfirmQueue<{ id: number }>((head) => shown.push(head?.id ?? null));
    queue.push({ id: 1 });
    queue.push({ id: 2 });
    withdrawRequest(queue, 1);
    expect(shown).toEqual([1, 2]);
    queue.push({ id: 3 });
    queue.push({ id: 4 });
    withdrawRequest(queue, 3);
    expect(shown).toEqual([1, 2]);
    expect(queue.answer(2)).toEqual({ id: 2 });
    expect(shown).toEqual([1, 2, 4]);
  });
});
