// The one confirm dialog of a window, and the requests waiting for it.
//
// A request that replaces the open one leaves the first caller awaiting an
// answer that never comes. Most callers await the answer (open refusals, open
// failures, the exit prompts), so a replaced flow hangs for the rest of the
// session. There is no DOM test environment, so the queue is a pure module and
// App's use of it is pinned by source.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConfirmQueue } from '../src/renderer/lib/confirm-queue';

interface Request {
  id: number;
  message: string;
}

function harness() {
  const shown: (Request | null)[] = [];
  const queue = createConfirmQueue<Request>((head) => shown.push(head));
  const request = (id: number): Request => ({ id, message: `request ${id}` });
  return { shown, queue, request };
}

describe('createConfirmQueue', () => {
  it('shows the first request at once', () => {
    const { shown, queue, request } = harness();
    queue.push(request(1));
    expect(shown).toEqual([request(1)]);
  });

  it('a request made while another is open waits instead of replacing it', () => {
    const { shown, queue, request } = harness();
    queue.push(request(1));
    queue.push(request(2));
    expect(shown).toEqual([request(1)]);
  });

  it('answering the open request closes it and shows the next, in order', () => {
    const { shown, queue, request } = harness();
    queue.push(request(1));
    queue.push(request(2));
    queue.push(request(3));
    expect(queue.answer(1)).toEqual(request(1));
    expect(queue.answer(2)).toEqual(request(2));
    expect(queue.answer(3)).toEqual(request(3));
    expect(shown).toEqual([request(1), request(2), request(3), null]);
  });

  it('a second answer to the same request does not close the one shown after it', () => {
    // Escape closes the dialog and reports a dismissal as well.
    const { shown, queue, request } = harness();
    queue.push(request(1));
    queue.push(request(2));
    expect(queue.answer(1)).toEqual(request(1));
    expect(queue.answer(1)).toBeUndefined();
    expect(shown).toEqual([request(1), request(2)]);
  });

  it('an answer to a request that is not on screen changes nothing', () => {
    const { shown, queue, request } = harness();
    queue.push(request(1));
    queue.push(request(2));
    expect(queue.answer(2)).toBeUndefined();
    expect(queue.answer(9)).toBeUndefined();
    expect(shown).toEqual([request(1)]);
  });

  it('an answer with nothing open changes nothing', () => {
    const { shown, queue } = harness();
    expect(queue.answer(1)).toBeUndefined();
    expect(shown).toEqual([]);
  });

  it('a request made after the queue emptied shows at once', () => {
    const { shown, queue, request } = harness();
    queue.push(request(1));
    queue.answer(1);
    queue.push(request(2));
    expect(shown).toEqual([request(1), null, request(2)]);
  });

  it('two notices raised together both reach their callers, in order', async () => {
    // The shape App gives every request: a promise the dialog's answer settles.
    const queue = createConfirmQueue<Request & { resolve: () => void }>(() => {});
    let next = 0;
    const notice = (message: string): Promise<string> =>
      new Promise((done) => {
        next += 1;
        queue.push({ id: next, message, resolve: () => done(message) });
      });
    const settled: string[] = [];
    const first = notice('open failed').then((m) => settled.push(m));
    const second = notice('startup settings not applied').then((m) => settled.push(m));
    queue.answer(1)?.resolve();
    queue.answer(2)?.resolve();
    await Promise.all([first, second]);
    expect(settled).toEqual(['open failed', 'startup settings not applied']);
  });
});

describe('App routes every confirm request through the queue', () => {
  const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('no request sets the dialog state directly', () => {
    expect(app).not.toContain('setConfirmState({');
    expect(app).toContain(
      'const [confirmQueue] = useState(() => createConfirmQueue<ConfirmRequest>(setConfirmState));',
    );
  });

  it('each of the four request helpers queues its request', () => {
    const helpers = app.match(/requestConfirm\(\{/g) ?? [];
    expect(helpers.length).toBe(4);
  });

  it('an answer closes the request on screen, by id, and settles that request', () => {
    expect(app).toContain('if (confirmState) confirmQueue.answer(confirmState.id)?.resolve(result);');
  });

  it('each request opens the dialog fresh', () => {
    expect(app).toContain('key={confirmState?.id ?? 0}');
  });
});
