import { describe, expect, it, vi } from 'vitest';
import { watchOtherWindowWork } from '../src/renderer/lib/other-window-work';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('cross-window engine activity', () => {
  it('loads the current count after the event listener is ready', async () => {
    const listener = deferred<() => void>();
    const stop = vi.fn();
    const count = vi.fn();
    const watching = watchOtherWindowWork(
      {
        listen: () => listener.promise,
        snapshot: async () => 3,
      },
      count,
    );

    expect(count).not.toHaveBeenCalled();
    listener.resolve(stop);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toHaveBeenCalledWith(3);
    watching();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not let a delayed initial snapshot overwrite a newer event', async () => {
    const initial = deferred<number>();
    const snapshotStarted = deferred<void>();
    let emit!: (count: number) => void;
    const count = vi.fn();
    const watching = watchOtherWindowWork(
      {
        listen: async (onCount) => {
          emit = onCount;
          return () => {};
        },
        snapshot: () => {
          snapshotStarted.resolve();
          return initial.promise;
        },
      },
      count,
    );

    await snapshotStarted.promise;
    emit(4);
    initial.resolve(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(count.mock.calls.map(([value]) => value)).toEqual([4]);
    watching();
  });

  it('removes a listener that resolves after unmount without requesting a snapshot', async () => {
    const listener = deferred<() => void>();
    const stop = vi.fn();
    const count = vi.fn();
    const snapshot = vi.fn(() => Promise.resolve(5));
    const watching = watchOtherWindowWork(
      { listen: () => listener.promise, snapshot },
      count,
    );

    watching();
    listener.resolve(stop);
    await new Promise((done) => setTimeout(done, 0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('ignores a snapshot that resolves after unmount', async () => {
    const snapshot = deferred<number>();
    const snapshotStarted = deferred<void>();
    const stop = vi.fn();
    const count = vi.fn();
    const watching = watchOtherWindowWork(
      {
        listen: async () => stop,
        snapshot: () => {
          snapshotStarted.resolve();
          return snapshot.promise;
        },
      },
      count,
    );

    await snapshotStarted.promise;
    watching();
    expect(stop).toHaveBeenCalledTimes(1);
    snapshot.resolve(5);
    await new Promise((done) => setTimeout(done, 0));
    expect(count).not.toHaveBeenCalled();
  });
});
