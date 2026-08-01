import { describe, it, expect } from 'vitest';
import { lockKeysFor, withFileLock, __lockedCount } from '../src/renderer/lib/engine-lock';

/** A promise plus its resolver, so a test can hold an operation open. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('lockKeysFor', () => {
  it('collects every path key the engine signatures use', () => {
    expect(lockKeysFor({ file: 'C:\\a.pdf', output: 'C:\\b.pdf' })).toEqual([
      'C:\\a.pdf',
      'C:\\b.pdf',
    ]);
    expect(lockKeysFor({ files: ['C:\\b.pdf', 'C:\\a.pdf'], output: 'C:\\c.pdf' })).toEqual([
      'C:\\a.pdf',
      'C:\\b.pdf',
      'C:\\c.pdf',
    ]);
  });

  it('deduplicates in-place operations, where file === output', () => {
    expect(lockKeysFor({ file: 'C:\\a.pdf', output: 'C:\\a.pdf' })).toEqual(['C:\\a.pdf']);
  });

  it('ignores non-path params and empty strings', () => {
    expect(lockKeysFor({ page: 3, text: 'hello', file: '' })).toEqual([]);
    expect(lockKeysFor({ files: ['C:\\a.pdf', 7, null] })).toEqual(['C:\\a.pdf']);
  });
});

describe('withFileLock', () => {
  it('serializes two operations on the same file', async () => {
    const order: string[] = [];
    const first = deferred();
    const a = withFileLock(['C:\\a.pdf'], async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = withFileLock(['C:\\a.pdf'], async () => {
      order.push('b:start');
    });
    // b must not have started: a still holds the file.
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('lets operations on DIFFERENT files run concurrently', async () => {
    const order: string[] = [];
    const hold = deferred();
    const a = withFileLock(['C:\\a.pdf'], async () => {
      order.push('a:start');
      await hold.promise;
    });
    const b = withFileLock(['C:\\b.pdf'], async () => {
      order.push('b:start');
    });
    await b;
    expect(order).toEqual(['a:start', 'b:start']);
    hold.resolve();
    await a;
  });

  it('waits on EVERY overlapping path, not just the first', async () => {
    // The merge case: an operation reading a.pdf + b.pdf must not start
    // while an unrelated operation is still rewriting b.pdf.
    const order: string[] = [];
    const hold = deferred();
    const rewrite = withFileLock(['C:\\b.pdf'], async () => {
      order.push('rewrite:start');
      await hold.promise;
      order.push('rewrite:end');
    });
    const merge = withFileLock(['C:\\a.pdf', 'C:\\b.pdf'], async () => {
      order.push('merge');
    });
    await Promise.resolve();
    expect(order).toEqual(['rewrite:start']);
    hold.resolve();
    await Promise.all([rewrite, merge]);
    expect(order).toEqual(['rewrite:start', 'rewrite:end', 'merge']);
  });

  it('a FAILED operation releases its lock and does not reject the next', async () => {
    const a = withFileLock(['C:\\a.pdf'], async () => {
      throw new Error('compress failed');
    });
    await expect(a).rejects.toThrow('compress failed');
    await expect(withFileLock(['C:\\a.pdf'], async () => 'ok')).resolves.toBe('ok');
    expect(__lockedCount()).toBe(0);
  });

  it('releases every key it claimed, including on failure', async () => {
    await expect(
      withFileLock(['C:\\a.pdf', 'C:\\b.pdf'], async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(__lockedCount()).toBe(0);
  });

  it('runs straight through when the call names no file', async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock([], async () => {
        order.push('one');
      }),
      withFileLock([], async () => {
        order.push('two');
      }),
    ]);
    expect(order.sort()).toEqual(['one', 'two']);
  });

  it('a three-deep queue on one file runs in arrival order', async () => {
    const order: number[] = [];
    const gate = deferred();
    const runs = [1, 2, 3].map((n) =>
      withFileLock(['C:\\a.pdf'], async () => {
        if (n === 1) await gate.promise;
        order.push(n);
      }),
    );
    gate.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
    expect(__lockedCount()).toBe(0);
  });
});
