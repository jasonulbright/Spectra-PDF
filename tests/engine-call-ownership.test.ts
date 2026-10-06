import { describe, expect, it, vi } from 'vitest';
import { engineClosures } from './helpers/engine-closures';

describe('engine dispatch ownership', () => {
  it.each(['entry', 'recovery', 'gate', 'chain', 'lock', 'queue', 'read-lock', 'read-current', 'current'])('checks the actual dispatch boundary: %s', async boundary => {
    let current = boundary !== 'entry';
    const raw = vi.fn(async () => ({ output: 'copy.pdf' })), release = vi.fn();
    const gate = vi.fn(async () => { if (boundary === 'gate') current = false; });
    const env = {
      isTrackableMethod: () => !boundary.startsWith('read-'), beginInteractive: () => release,
      runCommitGate: gate,
      restoreLostCredentials: vi.fn(async () => { if (boundary === 'recovery') current = false; }),
      lockKeysFor: () => [{ key: 'work.pdf', mode: 'exclusive' }],
      exclusiveKeys: (claims: { key: string }[]) => claims.map(claim => claim.key),
      beginDocumentWrites: () => () => {},
      withWriteChain: async (_paths: string[], run: () => Promise<unknown>) => {
        if (boundary === 'chain') current = false;
        return run();
      },
      withFileLock: async (_keys: unknown[], run: () => Promise<unknown>) => {
        if (boundary === 'lock' || boundary === 'read-lock') current = false;
        return run();
      },
      track: async (_method: string, _params: unknown, run: () => Promise<unknown>) => {
        if (boundary === 'queue') current = false;
        return run();
      }, rawCall: raw,
    };
    const { call } = engineClosures(env);
    const result = call('grayscale', { file: 'work.pdf' }, { assertCurrent: () => {
      if (!current) throw new Error('owner changed');
    } });
    if (boundary === 'current' || boundary === 'read-current') { await expect(result).resolves.toEqual({ output: 'copy.pdf' }); expect(raw).toHaveBeenCalledOnce(); }
    else { await expect(result).rejects.toThrow('owner changed'); expect(raw).not.toHaveBeenCalled(); }
    if (boundary.startsWith('read-')) { expect(gate).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); }
    else if (boundary !== 'entry') expect(release).toHaveBeenCalledOnce();
  });
});
