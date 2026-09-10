import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withHealthInput, type HealthInputIO } from '../src/renderer/lib/doc-health-input';
import { runHealthSweep } from '../src/renderer/lib/doc-health-engine';
import { resetEngineIdleLane, submitIdle } from '../src/renderer/lib/engine-idle-lane';

const gate = <T,>(send: () => Promise<T>) => send();
function inputIO() {
  const files = new Map<string, Uint8Array>();
  const io: HealthInputIO = {
    allocate: vi.fn(async () => '/private/health.pdf'),
    write: vi.fn(async (path, bytes) => { files.set(path, bytes.slice()); }),
    remove: vi.fn(async (path) => { files.delete(path); }),
  };
  return { io, files };
}

describe('private health input ownership', () => {
  beforeEach(resetEngineIdleLane);

  it('inspects exactly the displayed typed view without detaching shared bytes', async () => {
    const buffer = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4);
    const { io, files } = inputIO();
    const result = await withHealthInput(buffer, gate, io, async (path) => {
      expect(path).toBe('/private/health.pdf');
      expect([...files.get(path)!]).toEqual([1, 2, 3]);
      expect([...buffer]).toEqual([1, 2, 3]);
      return 'collected';
    });
    expect(result).toBe('collected');
    expect(files.size).toBe(0);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith('/private/health.pdf');
  });

  it.each([new Uint8Array([1, 2]).buffer, [1, 2]])('also accepts the other state buffer shape', async (buffer) => {
    const { io, files } = inputIO();
    await withHealthInput(buffer, gate, io, async (path) => {
      expect([...files.get(path)!]).toEqual([1, 2]);
    });
    expect(files.size).toBe(0);
  });

  it('does not allocate for a superseded queued revision', async () => {
    const { io } = inputIO();
    expect(await submitIdle((g) => withHealthInput([1], g, io, vi.fn()), () => false)).toBeNull();
    expect(io.allocate).not.toHaveBeenCalled();
  });

  it.each(['allocate', 'write'] as const)('cleans when superseded during %s without starting inspection', async (phase) => {
    const { io, files } = inputIO();
    let current = true;
    if (phase === 'allocate') io.allocate = vi.fn(async () => { current = false; return '/private/health.pdf'; });
    else io.write = vi.fn(async (path, bytes) => { files.set(path, bytes); current = false; });
    const inspect = vi.fn();
    expect(await submitIdle((g) => withHealthInput([1], g, io, inspect), () => current)).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith('/private/health.pdf');
  });

  it.each(['write', 'inspect'] as const)('cleans partial input after %s fails', async (phase) => {
    const { io, files } = inputIO();
    if (phase === 'write') io.write = async (path) => { files.set(path, new Uint8Array([1])); throw new Error('disk full'); };
    const inspect = async () => { throw new Error('worker killed'); };
    await expect(withHealthInput([1], gate, io, inspect)).rejects.toThrow(phase === 'write' ? 'disk full' : 'worker killed');
    expect(files.size).toBe(0);
  });

  it.each(['rejected begin', 'rejected step', 'superseded step'])('waits for the worker to close a %s before deleting input', async (scenario) => {
    const { io, files } = inputIO();
    let current = true;
    let endStarted!: () => void;
    const started = new Promise<void>((resolve) => { endStarted = resolve; });
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const dispatch = async (method: string) => {
      if (method === 'document_health_begin') {
        if (scenario === 'superseded step') current = false;
        return { token: 'run', pages: 1, status: 'collected', facts: [],
          ...(scenario === 'rejected begin' ? {} : { done: false }) };
      }
      if (method === 'document_health_step') return {};
      endStarted();
      await closed;
      return { ended: true };
    };
    const result = submitIdle((g) => withHealthInput([1], g, io, (path) => runHealthSweep(dispatch, path, g)), () => current);
    await started;
    expect(files.size).toBe(1);
    expect(io.remove).not.toHaveBeenCalled();
    close();
    const reply = await result;
    if (scenario === 'superseded step') expect(reply).toBeNull();
    else expect(reply?.ok).toBe(false);
    expect(files.size).toBe(0);
  });
});
