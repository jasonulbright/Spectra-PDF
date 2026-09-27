// One path, one open. The open funnel asks whether a path is open, then
// awaits its bytes (and, for an encrypted file, the password) before
// OPEN_FILE lands. A second open of the same path in that gap must wait for
// the first and take its verdict: never a second prompt, never a second
// OPEN_FILE that resets the page-edit history.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenFlights, createPathOperationLock, openPathOnce } from '../src/renderer/lib/open-flights';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The funnel's view of one window: which paths are open, and what ran. */
function funnel() {
  const open = new Set<string>();
  const log: string[] = [];
  const flights = createOpenFlights();
  const gates: ReturnType<typeof deferred<boolean>>[] = [];
  const run = (path: string, caller: string) =>
    openPathOnce(flights, path, {
      isOpen: () => open.has(path),
      reactivate: async () => {
        log.push(`${caller} reactivate ${path}`);
      },
      open: async () => {
        log.push(`${caller} prepare ${path}`);
        const gate = deferred<boolean>();
        gates.push(gate);
        const opened = await gate.promise;
        if (opened) {
          open.add(path);
          log.push(`${caller} OPEN_FILE ${path}`);
        }
        return opened;
      },
    });
  return { open, log, flights, gates, run };
}

describe('openPathOnce', () => {
  it('two opens of one unopened path prepare once and land one OPEN_FILE', async () => {
    const f = funnel();
    const first = f.run('a.pdf', 'first');
    const second = f.run('a.pdf', 'second');
    await tick();
    expect(f.log).toEqual(['first prepare a.pdf']);
    f.gates[0].resolve(true);
    expect(await first).toBe('opened');
    expect(await second).toBe('reactivated');
    expect(f.log).toEqual(['first prepare a.pdf', 'first OPEN_FILE a.pdf', 'second reactivate a.pdf']);
  });

  it('the second open takes a cancelled first open’s verdict and asks nothing', async () => {
    const f = funnel();
    const first = f.run('a.pdf', 'first');
    const second = f.run('a.pdf', 'second');
    await tick();
    f.gates[0].resolve(false);
    expect(await first).toBe('refused');
    expect(await second).toBe('deferred');
    expect(f.log).toEqual(['first prepare a.pdf']);
  });

  it('a first open that throws still lets the waiting open go', async () => {
    const f = funnel();
    const first = f.run('a.pdf', 'first');
    const second = f.run('a.pdf', 'second');
    await tick();
    f.gates[0].reject(new Error('engine died'));
    await expect(first).rejects.toThrow('engine died');
    expect(await second).toBe('deferred');
    expect(f.flights.pending('a.pdf')).toBeUndefined();
  });

  it('opens of different paths do not wait for each other', async () => {
    const f = funnel();
    const a = f.run('a.pdf', 'first');
    const b = f.run('b.pdf', 'second');
    await tick();
    expect(f.log).toEqual(['first prepare a.pdf', 'second prepare b.pdf']);
    f.gates[1].resolve(true);
    expect(await b).toBe('opened');
    f.gates[0].resolve(true);
    expect(await a).toBe('opened');
  });

  it('an open after the first one settled opens again when the first opened nothing', async () => {
    const f = funnel();
    const first = f.run('a.pdf', 'first');
    await tick();
    f.gates[0].resolve(false);
    expect(await first).toBe('refused');
    const later = f.run('a.pdf', 'later');
    await tick();
    f.gates[1].resolve(true);
    expect(await later).toBe('opened');
  });

  it('an open path is brought forward without a flight', async () => {
    const f = funnel();
    f.open.add('a.pdf');
    expect(await f.run('a.pdf', 'only')).toBe('reactivated');
    expect(f.log).toEqual(['only reactivate a.pdf']);
  });
});

describe('createOpenFlights', () => {
  it('settles only its own flight', async () => {
    const flights = createOpenFlights();
    const settleFirst = flights.begin('a.pdf');
    const first = flights.pending('a.pdf')!;
    const settleSecond = flights.begin('a.pdf');
    const second = flights.pending('a.pdf')!;
    settleFirst();
    await first;
    // A newer flight of the path is not cleared by an older one settling.
    expect(flights.pending('a.pdf')).toBe(second);
    settleSecond();
    await second;
    expect(flights.pending('a.pdf')).toBeUndefined();
  });
});

describe('createPathOperationLock', () => {
  it('keeps an import source stable until its page references land before an open', async () => {
    const locks = createPathOperationLock();
    const order: string[] = [];
    const importGate = deferred<void>();
    const importing = locks.run(['source.pdf'], async () => {
      order.push('import starts');
      await importGate.promise;
      order.push('import registers source');
      order.push('import publishes page references');
    });
    await tick();
    const opening = locks.run(['source.pdf'], async () => {
      order.push('open checks source');
      order.push('open commits imported pages');
      order.push('open replaces source bytes');
    });
    await tick();
    expect(order).toEqual(['import starts']);
    importGate.resolve();
    await Promise.all([importing, opening]);
    expect(order).toEqual([
      'import starts',
      'import registers source',
      'import publishes page references',
      'open checks source',
      'open commits imported pages',
      'open replaces source bytes',
    ]);
  });

  it('lets concurrent imports prepare a missing source only once', async () => {
    const locks = createPathOperationLock();
    const ready = deferred<void>();
    const adoptedBuffers: object[] = [];
    let sourceBuffer: object | null = null;
    let prepared = 0;
    const importSource = () => locks.run(['source.pdf'], async () => {
      if (!sourceBuffer) {
        prepared += 1;
        await ready.promise;
        sourceBuffer = {};
      }
      adoptedBuffers.push(sourceBuffer);
    });

    const first = importSource();
    await tick();
    const second = importSource();
    await tick();
    expect(prepared).toBe(1);
    ready.resolve();
    await Promise.all([first, second]);
    expect(prepared).toBe(1);
    expect(adoptedBuffers).toHaveLength(2);
    expect(adoptedBuffers[0]).toBe(adoptedBuffers[1]);
  });

  it('does not serialize unrelated source paths and avoids multi-path deadlock', async () => {
    const locks = createPathOperationLock();
    const firstGate = deferred<void>();
    const order: string[] = [];
    const first = locks.run(['b.pdf', 'a.pdf'], async () => {
      order.push('first batch');
      await firstGate.promise;
    });
    await tick();
    const unrelated = locks.run(['other.pdf'], async () => { order.push('unrelated'); });
    const second = locks.run(['a.pdf', 'b.pdf'], async () => { order.push('second batch'); });
    await tick();
    expect(order).toEqual(['first batch', 'unrelated']);
    firstGate.resolve();
    await Promise.all([first, unrelated, second]);
    expect(order).toEqual(['first batch', 'unrelated', 'second batch']);
  });
});

describe('the open funnel', () => {
  it('opens every path through openPathOnce and releases, guarded, every path it did not open', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toContain('const step = await openPathOnce(openFlights.current, filePath, {');
    expect(app).toContain("if (step === 'opened' || step === 'reactivated') unopened.delete(filePath);");
    expect(app).toContain('if (unopened.size > 0) void releasePaths([...unopened], pathInUse);');
    // An open and a page import of the same path share one local lock. This
    // keeps a source buffer stable from import indexing through its reducer
    // dispatch, and makes an open re-check whether an import registered it.
    expect(app).toContain('sourcePathOperations.current.run([filePath], async () => {');
    expect(app).toContain('sourcePathOperations.current.run(filePaths, async () => {');
    expect(app).not.toContain('await openFlights.current.pending(filePath);');
  });
});
