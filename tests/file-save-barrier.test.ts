import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerFileSaveBarrier, withFileSave } from '../src/renderer/lib/file-save-barrier';
import { withFileLock, __lockedCount } from '../src/renderer/lib/engine-lock';

it('barriers may publish without deadlock; detached providers are not retained', async () => {
  const events: string[] = [];
  const barrier = vi.fn(async (path: string) => {
    expect(__lockedCount()).toBe(0);
    await withFileLock([path], async () => { events.push('publish'); });
  });
  const off = registerFileSaveBarrier(barrier);
  try { await withFileSave('work', 'dest', async () => { events.push('save'); }); }
  finally { off(); }
  await withFileSave('work', 'dest', async () => { events.push('detached'); });
  expect(events).toEqual(['publish', 'save', 'detached']); expect(barrier).toHaveBeenCalledOnce();
});

it('a refusing barrier neither copies nor holds a file lock', async () => {
  const off = registerFileSaveBarrier(async () => { throw Error('publication refused'); });
  const save = vi.fn(async () => {});
  try { await expect(withFileSave('work', 'dest', save)).rejects.toThrow('publication refused'); }
  finally { off(); }
  expect(save).not.toHaveBeenCalled(); expect(__lockedCount()).toBe(0);
});

it('the actual file bridge and window provider use the shared barrier', () => {
  const bridge = readFileSync(new URL('../src/renderer/lib/tauri-bridge.ts', import.meta.url), 'utf8');
  expect(bridge).toMatch(/saveAs:[\s\S]*?withFileSave\(workingPath, destPath, \(\) => invoke\('save_as'/);
  const provider = readFileSync(new URL('../src/renderer/state/AppStateProvider.tsx', import.meta.url), 'utf8');
  expect(provider).toContain('useEffect(() => registerFileSaveBarrier(bookmarkDrafts.beforeSave), [bookmarkDrafts])');
});
