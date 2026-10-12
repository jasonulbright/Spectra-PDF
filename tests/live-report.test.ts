import { describe, expect, it } from 'vitest';
import { liveOrRefuse } from '../src/renderer/lib/live-report';
import { readerRevisionIn, recordReadRevision } from '../src/renderer/lib/reader-copy';
import { tChrome } from '../src/renderer/i18n';
import type { AppState, OpenFile } from '../src/renderer/state/types';

type LiveState = Pick<AppState, 'files' | 'pageDirtyPaths'>;

function stateWith(buffer: Uint8Array, editRevision: number, pageDirty: boolean): LiveState {
  const file = { path: 'a.pdf', workingPath: 'a.work.pdf', buffer, editRevision } as unknown as OpenFile;
  return { files: new Map([['a.pdf', file]]), pageDirtyPaths: pageDirty ? ['a.pdf'] : [] };
}

describe('a report read outside a reader copy', () => {
  const buffer = new Uint8Array([1]);
  const steady = stateWith(buffer, 3, false);

  function read(before: LiveState, after: LiveState): object {
    return recordReadRevision({}, 'a.work.pdf', readerRevisionIn(before, 'a.work.pdf'), readerRevisionIn(after, 'a.work.pdf'));
  }

  it('is live while nothing has changed since the read', () => {
    const notices: string[] = [];
    expect(liveOrRefuse(read(steady, steady), steady, 'a.work.pdf', (m) => notices.push(m))).toBe(true);
    expect(notices).toEqual([]);
  });

  it('refuses by name once a page edit is pending', () => {
    const notices: string[] = [];
    const report = read(steady, steady);
    expect(liveOrRefuse(report, stateWith(buffer, 4, true), 'a.work.pdf', (m) => notices.push(m))).toBe(false);
    expect(notices).toEqual([tChrome('panel.common.documentChanged')]);
  });

  it('refuses after a commit replaced the bytes', () => {
    const report = read(steady, steady);
    expect(liveOrRefuse(report, stateWith(new Uint8Array([2]), 3, false), 'a.work.pdf', () => {})).toBe(false);
  });

  it('a read the document moved under is never live', () => {
    const report = read(steady, stateWith(buffer, 4, false));
    expect(liveOrRefuse(report, stateWith(buffer, 4, false), 'a.work.pdf', () => {})).toBe(false);
  });

  it('a read over a pending page edit is never live', () => {
    const dirty = stateWith(buffer, 3, true);
    expect(liveOrRefuse(read(dirty, dirty), steady, 'a.work.pdf', () => {})).toBe(false);
  });

  it('refuses with no document', () => {
    expect(liveOrRefuse(read(steady, steady), steady, null, () => {})).toBe(false);
  });
});
