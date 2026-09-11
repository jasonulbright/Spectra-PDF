import { afterEach, describe, expect, it, vi } from 'vitest';
import { METADATA_DEADLINE_MS, transformMetadata } from '../src/renderer/lib/metadata-host';
import { METADATA_BYTES } from '../src/renderer/lib/metadata-stream';
const request = { input: { bytes: new Uint8Array([1]), filters: [] }, overrides: {} };
class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { ControlledWorker.instances.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); ControlledWorker.instances = []; });
const start = () => { vi.stubGlobal('Worker', ControlledWorker); const result = transformMetadata(request); return { result, worker: ControlledWorker.instances.at(-1)! }; };
describe('metadata worker host', () => {
  it('kills a silent worker at the bounded deadline without disturbing another request', async () => {
    vi.useFakeTimers(); const first = start(), rejected = expect(first.result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100); const second = start();
    second.worker.onmessage!({ data: { ok: true, result: { changed: false } } });
    await expect(second.result).resolves.toEqual({ changed: false });
    await vi.advanceTimersByTimeAsync(METADATA_DEADLINE_MS); await rejected;
    expect(first.worker.terminate).toHaveBeenCalledTimes(1); expect(second.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { ok: false }, { ok: true, result: {} }, { ok: true, result: { changed: false, bytes: [] } }, { ok: true, result: { changed: true, bytes: [] } }, { ok: true, result: { changed: true, bytes: new Uint8Array() } }])('rejects malformed reply %# and retires its worker', async data => {
    const { result, worker } = start(); worker.onmessage!({ data });
    await expect(result).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('refuses oversized replies, accepts a complete changed packet, ignores late replies', async () => {
    const first = start(); first.worker.onmessage!({ data: { ok: true, result: { changed: true, bytes: new Uint8Array(METADATA_BYTES + 1) } } }); await expect(first.result).rejects.toThrow();
    const second = start(), callback = second.worker.onmessage!, bytes = new Uint8Array([60, 114, 47, 62]);
    callback({ data: { ok: true, result: { changed: true, bytes } } }); callback({ data: { ok: false } });
    await expect(second.result).resolves.toEqual({ changed: true, bytes }); expect(second.worker.terminate).toHaveBeenCalledTimes(1);
  });
  it.each(['onerror', 'onmessageerror'] as const)('refuses %s', async name => { const { result, worker } = start(); worker[name]!(); await expect(result).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1); });
  it('does not fall back to main-thread parsing on unavailable worker or constructor/post failure', async () => {
    vi.stubGlobal('Worker', undefined); await expect(transformMetadata(request)).rejects.toThrow();
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } }); await expect(transformMetadata(request)).rejects.toThrow();
    const stop = vi.fn(); vi.stubGlobal('Worker', class { terminate = stop; postMessage() { throw new Error('clone'); } });
    await expect(transformMetadata(request)).rejects.toThrow(); expect(stop).toHaveBeenCalledTimes(1);
  });
});
