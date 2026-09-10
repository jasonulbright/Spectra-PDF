import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  listen: vi.fn(), request: vi.fn(), health: vi.fn(), start: vi.fn(),
}));
vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  engine: { onResponse: mocked.listen, request: mocked.request, healthRequest: mocked.health, start: mocked.start },
  dialog: {}, batch: {}, file: {},
}));

type Reply = { id: number; result?: unknown; error?: { message: string } };
let receive: (reply: Reply) => void;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('window-owned engine response routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocked.listen.mockImplementation(async (callback) => { receive = callback; return vi.fn(); });
    mocked.request.mockResolvedValue(undefined);
    mocked.health.mockResolvedValue(undefined);
  });

  it('waits for listener registration before handing over a fast request', async () => {
    let register!: (unlisten: () => void) => void;
    mocked.listen.mockImplementation((callback) => {
      receive = callback;
      return new Promise(resolve => { register = resolve; });
    });
    const { dispatchEngineRequest } = await import('../src/renderer/hooks/useEngine');
    const request = dispatchEngineRequest('read_form_fields', { file: 'a.pdf' });
    await flush();
    expect(mocked.request).not.toHaveBeenCalled();
    register(vi.fn());
    await flush();
    const sent = mocked.request.mock.calls[0][0];
    receive({ id: sent.id, result: { fields: ['name'] } });
    expect(await request).toEqual({ fields: ['name'] });
  });

  it('shares one listener across callers and keeps both sidecar IDs distinct', async () => {
    const { dispatchEngineRequest } = await import('../src/renderer/hooks/useEngine');
    const read = dispatchEngineRequest('read_form_fields', { file: 'a.pdf' });
    const health = dispatchEngineRequest('document_health_begin', { file: 'private.pdf' });
    await flush();
    expect(mocked.listen).toHaveBeenCalledTimes(1);
    const a = mocked.request.mock.calls[0][0], b = mocked.health.mock.calls[0][0];
    expect(a.id).not.toBe(b.id);
    receive({ id: b.id, result: { token: 'health' } });
    receive({ id: a.id, result: { fields: [] } });
    expect(await read).toEqual({ fields: [] });
    expect(await health).toEqual({ token: 'health' });
  });

  it('retains the pending reader and releases its file lock only on the actual reply', async () => {
    const { dispatchEngineRequest } = await import('../src/renderer/hooks/useEngine');
    const { withFileLock } = await import('../src/renderer/lib/engine-lock');
    const read = withFileLock(['a.pdf'], () => dispatchEngineRequest('read_form_fields', { file: 'a.pdf' }));
    const publish = vi.fn(async () => undefined);
    const write = withFileLock(['a.pdf'], publish);
    await flush();
    expect(publish).not.toHaveBeenCalled();
    const unlisten = await mocked.listen.mock.results[0].value;
    expect(unlisten).not.toHaveBeenCalled();
    receive({ id: mocked.request.mock.calls[0][0].id, result: { fields: [] } });
    await Promise.all([read, write]);
    expect(publish).toHaveBeenCalledTimes(1);
    // The next panel reuses this same transport; component disposal has no
    // subscription handle with which to strand the old caller's promise.
    const next = dispatchEngineRequest('read_form_fields', { file: 'a.pdf' });
    await flush();
    expect(mocked.listen).toHaveBeenCalledTimes(1);
    receive({ id: mocked.request.mock.calls[1][0].id, result: { fields: ['next'] } });
    expect(await next).toEqual({ fields: ['next'] });
  });

  it('refuses failed sends and routes named worker errors to the right caller', async () => {
    const { dispatchEngineRequest } = await import('../src/renderer/hooks/useEngine');
    mocked.request.mockRejectedValueOnce(new Error('send failed'));
    await expect(dispatchEngineRequest('read_form_fields', { file: 'a.pdf' })).rejects.toThrow('send failed');
    const next = dispatchEngineRequest('document_health_step', { token: 'run' });
    await flush();
    receive({ id: mocked.health.mock.calls[0][0].id, error: { message: 'worker deadline' } });
    await expect(next).rejects.toThrow('worker deadline');
  });

  it('retries failed listener registration without sending into an absent listener', async () => {
    const { dispatchEngineRequest } = await import('../src/renderer/hooks/useEngine');
    mocked.listen.mockRejectedValueOnce(new Error('listen failed'));
    await expect(dispatchEngineRequest('read_form_fields', {})).rejects.toThrow('listen failed');
    expect(mocked.request).not.toHaveBeenCalled();
    const next = dispatchEngineRequest('read_form_fields', {});
    await flush();
    receive({ id: mocked.request.mock.calls[0][0].id, result: {} });
    await next;
    expect(mocked.listen).toHaveBeenCalledTimes(2);
  });
});
