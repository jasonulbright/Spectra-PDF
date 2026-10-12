import { describe, expect, it, vi } from 'vitest';
import { UNRESTRICTED } from '../src/renderer/lib/document-permissions';
import { readerRevisionIn, recordReadRevision, withReaderCopies, type ReaderCopyIo } from '../src/renderer/lib/reader-copy';
import { visualResultStanding } from '../src/renderer/lib/visual-compare';
import type { AppState, OpenFile } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({}));

const A = 'C:\\work\\a.1\\a.pdf';
const B = 'C:\\work\\b.1\\b.pdf';

type LiveState = Pick<AppState, 'files' | 'pageDirtyPaths'>;

function liveState(): LiveState {
  const files = new Map<string, OpenFile>();
  for (const workingPath of [A, B]) {
    const path = `D:\\docs\\${workingPath.slice(workingPath.lastIndexOf('\\') + 1)}`;
    files.set(path, { path, workingPath, buffer: new Uint8Array(1), editRevision: 0 } as unknown as OpenFile);
  }
  return { files, pageDirtyPaths: [] };
}

function changed(state: LiveState, workingPath: string, change: Partial<OpenFile>): void {
  const files = new Map(state.files);
  for (const [path, file] of files) {
    if (file.workingPath === workingPath) files.set(path, { ...file, ...change });
  }
  state.files = files;
}

function closed(state: LiveState, workingPath: string): void {
  state.files = new Map([...state.files].filter(([, file]) => file.workingPath !== workingPath));
}

function pathOf(state: LiveState, workingPath: string): string {
  return [...state.files.values()].find((file) => file.workingPath === workingPath)!.path;
}

/** A window with A and B open. `during` runs while the engine step reads its copies. */
async function compareVisual(live: LiveState, during: () => void = () => {}): Promise<object> {
  let n = 0;
  const io: ReaderCopyIo = {
    fileAt: (path) => ([A, B].includes(path) ? { workingPath: path, security: { ...UNRESTRICTED, opener: 'recipient' as const } } : undefined),
    create: async (path) => `${path.slice(0, path.lastIndexOf('\\'))}\\r42-${(++n).toString(16).padStart(8, '0')}${path.slice(path.lastIndexOf('\\'))}`,
    remove: async () => true,
    lend: async () => true,
    giveBack: async () => {},
    revision: (path) => readerRevisionIn(live, path),
  };
  return withReaderCopies(
    'compare_visual',
    { file_a: A, file_b: B, gs_path: 'gs' },
    [{ key: A, mode: 'shared' }, { key: B, mode: 'shared' }],
    io,
    async () => {
      during();
      return { summary: { identical: false }, pages: [{ page: 1, identical: false, regions: [{ x: 1, y: 1, w: 2, h: 2 }] }] };
    },
  );
}

describe('a visual comparison against the live documents', () => {
  it('is live while neither document moved since the read', async () => {
    const live = liveState();
    const result = await compareVisual(live);
    expect(visualResultStanding(result, live, A, B)).toBe('live');
  });

  it('is stale when the first document was committed during the comparison', async () => {
    // A page deleted and committed while the engine read the copies: page 1 of
    // the result is not page 1 on screen.
    const live = liveState();
    const result = await compareVisual(live, () => changed(live, A, { buffer: new Uint8Array(2) }));
    expect(visualResultStanding(result, live, A, B)).toBe('stale');
  });

  it('is stale when the second document was committed during the comparison', async () => {
    const live = liveState();
    const result = await compareVisual(live, () => changed(live, B, { buffer: new Uint8Array(2) }));
    expect(visualResultStanding(result, live, A, B)).toBe('stale');
  });

  it('turns stale after a later commit or a pending page edit of either document', async () => {
    const live = liveState();
    const result = await compareVisual(live);
    live.pageDirtyPaths = [pathOf(live, B)];
    expect(visualResultStanding(result, live, A, B)).toBe('stale');
    live.pageDirtyPaths = [];
    expect(visualResultStanding(result, live, A, B)).toBe('live');
    changed(live, A, { editRevision: 1 });
    expect(visualResultStanding(result, live, A, B)).toBe('stale');
  });

  it('reports a closed document apart from a changed one', async () => {
    const live = liveState();
    const result = await compareVisual(live);
    closed(live, B);
    expect(visualResultStanding(result, live, A, B)).toBe('closed');
  });

  it('a result that recorded only one of the two documents is never live', () => {
    const live = liveState();
    const revision = readerRevisionIn(live, A);
    const result = recordReadRevision({}, A, revision, revision);
    expect(visualResultStanding(result, live, A, B)).toBe('stale');
    expect(visualResultStanding({}, live, A, B)).toBe('stale');
  });
});
