// One path, one open. The open funnel asks whether a path is open, then
// awaits its bytes (and, for an encrypted file, the password) before
// OPEN_FILE lands. A second open of the same path in that gap must wait for
// the first and take its verdict: never a second prompt, never a second
// OPEN_FILE that resets the page-edit history.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenFlights, openPathOnce } from '../src/renderer/lib/open-flights';

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

describe('the open funnel', () => {
  it('opens every path through openPathOnce and releases, guarded, every path it did not open', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toContain('const step = await openPathOnce(openFlights.current, filePath, {');
    expect(app).toContain("if (step === 'opened' || step === 'reactivated') unopened.delete(filePath);");
    expect(app).toContain('if (unopened.size > 0) void releasePaths([...unopened], pathInUse);');
    // An import of a path being opened waits for that open.
    expect(app).toContain('await openFlights.current.pending(filePath);');
  });
});
