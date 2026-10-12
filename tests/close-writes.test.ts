import { describe, expect, it, vi } from 'vitest';
import {
  closeLeavingDocuments, closeOverDocumentWrites, closeThroughWrites, readyToClose, waitForDocumentWrites,
  waitForWrites, withdrawRequest,
  type CloseOutcome, type GatedClose, type WriteWait,
} from '../src/renderer/lib/close-writes';
import { beginDocumentWrite } from '../src/renderer/lib/document-writes';

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

  it('does not ask again after a gesture was refused during the wait', async () => {
    const close = vi.fn(async (): Promise<CloseOutcome> => 'writing');
    let refused = false;
    const wait = async (): Promise<WriteWait> => { refused = true; return 'drained'; };
    await expect(closeThroughWrites(close, wait, () => refused)).resolves.toBe('refused');
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

describe('waitForDocumentWrites', () => {
  const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  it('closes the wait by itself when the writes of its documents finish', async () => {
    const write = beginDocumentWrite('work-A');
    const other = beginDocumentWrite('work-B');
    const withdraw = vi.fn();
    const ask = vi.fn(() => new Promise<boolean>(() => {}));
    const run = waitForDocumentWrites(['work-A'], ask, withdraw);
    await turn();
    expect(ask).toHaveBeenCalledOnce();
    expect(withdraw).not.toHaveBeenCalled();
    write();
    await expect(run).resolves.toBe('drained');
    expect(withdraw).toHaveBeenCalledOnce();
    other();
  });

  it('reports Close Now and Cancel', async () => {
    const write = beginDocumentWrite('work-A');
    await expect(waitForDocumentWrites(['work-A'], async () => true, () => {})).resolves.toBe('quit');
    await expect(waitForDocumentWrites(['work-A'], async () => false, () => {})).resolves.toBe('stay');
    write();
  });

  it('sees writes that finished before it subscribed', async () => {
    const withdraw = vi.fn();
    const run = waitForDocumentWrites(['work-A'], () => new Promise<boolean>(() => {}), withdraw);
    await expect(run).resolves.toBe('drained');
    expect(withdraw).toHaveBeenCalledOnce();
  });
});

describe('readyToClose', () => {
  function steps(pending: number, wait: WriteWait, confirm = true) {
    const order: string[] = [];
    return {
      order,
      steps: {
        pending: () => pending,
        wait: async () => { order.push('wait'); return wait; },
        confirm: async () => { order.push('confirm'); return confirm; },
      },
    };
  }

  it('waits for recorded writes, then asks about the bytes they produced', async () => {
    const s = steps(1, 'drained');
    await expect(readyToClose(() => false, s.steps)).resolves.toBe('go');
    expect(s.order).toEqual(['wait', 'confirm']);
  });

  it('asks at once when nothing is recorded', async () => {
    const s = steps(0, 'drained');
    await expect(readyToClose(() => false, s.steps)).resolves.toBe('go');
    expect(s.order).toEqual(['confirm']);
  });

  it('goes on to the prompt after Close Now', async () => {
    const s = steps(2, 'quit');
    await expect(readyToClose(() => false, s.steps)).resolves.toBe('go');
    expect(s.order).toEqual(['wait', 'confirm']);
  });

  it('keeps the documents on Cancel in the wait or in the prompt', async () => {
    const waitCancel = steps(1, 'stay');
    await expect(readyToClose(() => false, waitCancel.steps)).resolves.toBe('stayed');
    expect(waitCancel.order).toEqual(['wait']);
    const promptCancel = steps(0, 'drained', false);
    await expect(readyToClose(() => false, promptCancel.steps)).resolves.toBe('stayed');
  });

  it('calls the close off for a gesture refused during the wait or during the prompt', async () => {
    const duringWait = steps(1, 'drained');
    await expect(readyToClose(() => true, duringWait.steps)).resolves.toBe('refused');
    expect(duringWait.order).toEqual(['wait']);

    let refused = false;
    const duringPrompt = {
      pending: () => 0,
      wait: async (): Promise<WriteWait> => 'drained',
      confirm: async () => { refused = true; return true; },
    };
    await expect(readyToClose(() => refused, duringPrompt)).resolves.toBe('refused');
  });
});

describe('closeOverDocumentWrites', () => {
  function documents(pending: number[], waits: WriteWait[], confirms: boolean[] = []) {
    const order: string[] = [];
    return {
      order,
      steps: {
        pending: () => pending.shift() ?? 0,
        wait: async () => { order.push('wait'); return waits.shift()!; },
        confirm: async () => { order.push('confirm'); return confirms.shift() ?? true; },
      },
      close: async (): Promise<GatedClose> => { order.push('close'); return 'closed'; },
    };
  }

  it('closes at once when no write of the documents is recorded', async () => {
    const d = documents([0], []);
    await expect(closeOverDocumentWrites(() => false, d.steps, d.close)).resolves.toBe('closed');
    expect(d.order).toEqual(['close']);
  });

  it('waits again for a write that started after the prompt, and asks about each result', async () => {
    // A write running at the close step, then another one started while the
    // prompt about the first result was open.
    const d = documents([1, 1, 0], ['drained', 'drained']);
    await expect(closeOverDocumentWrites(() => false, d.steps, d.close)).resolves.toBe('closed');
    expect(d.order).toEqual(['wait', 'confirm', 'wait', 'confirm', 'close']);
  });

  it('keeps the window on Cancel in the wait or in the prompt', async () => {
    const waitCancel = documents([1], ['stay']);
    await expect(closeOverDocumentWrites(() => false, waitCancel.steps, waitCancel.close)).resolves.toBe('stayed');
    expect(waitCancel.order).toEqual(['wait']);
    const promptCancel = documents([1], ['drained'], [false]);
    await expect(closeOverDocumentWrites(() => false, promptCancel.steps, promptCancel.close)).resolves.toBe('stayed');
    expect(promptCancel.order).toEqual(['wait', 'confirm']);
  });

  it('closes on Close Now without asking about a result that has not landed', async () => {
    const d = documents([1], ['quit']);
    await expect(closeOverDocumentWrites(() => false, d.steps, d.close)).resolves.toBe('closed');
    expect(d.order).toEqual(['wait', 'close']);
  });

  it('calls the close off for a gesture refused during a wait, a prompt, or before the close', async () => {
    let refused = false;

    const duringWait = documents([1], ['drained']);
    const waitSteps = {
      ...duringWait.steps,
      wait: async (): Promise<WriteWait> => { refused = true; return 'drained'; },
    };
    await expect(closeOverDocumentWrites(() => refused, waitSteps, duringWait.close)).resolves.toBe('refused');
    expect(duringWait.order).toEqual([]);

    refused = false;
    const duringPrompt = documents([1, 0], ['drained']);
    const promptSteps = { ...duringPrompt.steps, confirm: async () => { refused = true; return true; } };
    await expect(closeOverDocumentWrites(() => refused, promptSteps, duringPrompt.close)).resolves.toBe('refused');
    expect(duringPrompt.order).toEqual(['wait']);

    const afterCloseNow = documents([1], ['quit']);
    await expect(closeOverDocumentWrites(() => true, afterCloseNow.steps, afterCloseNow.close))
      .resolves.toBe('refused');
    expect(afterCloseNow.order).toEqual(['wait']);

    const nothingRecorded = documents([0], []);
    await expect(closeOverDocumentWrites(() => true, nothingRecorded.steps, nothingRecorded.close))
      .resolves.toBe('refused');
    expect(nothingRecorded.order).toEqual([]);
  });

  it('passes what the close reports through', async () => {
    const d = documents([0], []);
    await expect(closeOverDocumentWrites(() => false, d.steps, async () => 'stayed')).resolves.toBe('stayed');
  });
});

describe('closeLeavingDocuments', () => {
  const noDocumentWrites = {
    pending: () => 0,
    wait: async (): Promise<WriteWait> => 'drained',
    confirm: async () => true,
  };

  it('keeps the window for a gesture refused during the engine-write wait, and says so once', async () => {
    // A write that is not a document write (a folder run) holds the close;
    // during its wait a gesture on a closing document is refused.
    const close = vi.fn(async (): Promise<CloseOutcome> => 'writing');
    let refusedGesture = false;
    const waitForEngine = vi.fn(async (): Promise<WriteWait> => { refusedGesture = true; return 'drained'; });
    const notice = vi.fn();
    await expect(closeLeavingDocuments(() => refusedGesture, noDocumentWrites, close, waitForEngine, notice))
      .resolves.toBe('stayed');
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(false);
    expect(waitForEngine).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledOnce();
  });

  it('keeps the window for a gesture refused during the document-write wait, and says so once', async () => {
    const close = vi.fn(async (): Promise<CloseOutcome> => 'closed');
    let refusedGesture = false;
    let pending = 1;
    const steps = {
      pending: () => pending,
      wait: async (): Promise<WriteWait> => { pending = 0; refusedGesture = true; return 'drained'; },
      confirm: async () => true,
    };
    const notice = vi.fn();
    await expect(closeLeavingDocuments(() => refusedGesture, steps, close, async () => 'drained', notice))
      .resolves.toBe('stayed');
    expect(close).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
  });

  it('closes after the engine writes drain when nothing was refused', async () => {
    const outcomes: CloseOutcome[] = ['writing', 'closed'];
    const close = vi.fn(async () => outcomes.shift()!);
    const notice = vi.fn();
    await expect(closeLeavingDocuments(() => false, noDocumentWrites, close, async () => 'drained', notice))
      .resolves.toBe('closed');
    expect(close.mock.calls).toEqual([[false], [false]]);
    expect(notice).not.toHaveBeenCalled();
  });
});
