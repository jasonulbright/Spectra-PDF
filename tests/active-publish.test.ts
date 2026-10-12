import { describe, expect, it, vi } from 'vitest';
import { publishToShownDocument } from '../src/renderer/lib/active-publish';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState } from '../src/renderer/state/types';

function twoDocuments(): AppState {
  let s = appReducer(initialState, {
    type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf', pageCount: 1, buffer: [1],
  });
  s = appReducer(s, {
    type: 'OPEN_FILE', path: 'b.pdf', workingPath: 'b.w', name: 'b.pdf', pageCount: 1, buffer: [2],
  });
  return appReducer(s, { type: 'SET_ACTIVE_FILE', path: 'a.pdf' });
}

/** A placement that finishes only when the test says so, with the state
 * changes the test makes while it is pending. */
function heldPlacement(start: AppState) {
  let state = start;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  return {
    readState: () => state,
    dispatch: (action: AppAction) => { state = appReducer(state, action); },
    place: async () => { await held; return ['candidate of a.pdf']; },
    finish: () => finish(),
  };
}

describe('publishing a result into the shown document', () => {
  it('commits when the document is still shown after placing', async () => {
    const run = heldPlacement(twoDocuments());
    const commit = vi.fn();
    const outcome = publishToShownDocument('a.pdf', run.readState, run.place, commit);
    run.finish();
    expect(await outcome).toEqual({ stale: false, placed: ['candidate of a.pdf'] });
    expect(commit).toHaveBeenCalledExactlyOnceWith(['candidate of a.pdf']);
  });

  it('drops a result whose document stopped being shown while it was placed', async () => {
    const run = heldPlacement(twoDocuments());
    const commit = vi.fn();
    const outcome = publishToShownDocument('a.pdf', run.readState, run.place, commit);
    run.dispatch({ type: 'SET_ACTIVE_FILE', path: 'b.pdf' });
    run.finish();
    expect(await outcome).toEqual({ stale: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('drops a result whose document closed while it was placed', async () => {
    const run = heldPlacement(twoDocuments());
    const commit = vi.fn();
    const outcome = publishToShownDocument('a.pdf', run.readState, run.place, commit);
    run.dispatch({ type: 'CLOSE_FILE', path: 'a.pdf' });
    run.finish();
    expect(await outcome).toEqual({ stale: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits when the user switched away and back before placing finished', async () => {
    const run = heldPlacement(twoDocuments());
    const commit = vi.fn();
    const outcome = publishToShownDocument('a.pdf', run.readState, run.place, commit);
    run.dispatch({ type: 'SET_ACTIVE_FILE', path: 'b.pdf' });
    run.dispatch({ type: 'SET_ACTIVE_FILE', path: 'a.pdf' });
    run.finish();
    expect(await outcome).toEqual({ stale: false, placed: ['candidate of a.pdf'] });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('drops a result for a document that was never shown', async () => {
    const run = heldPlacement(twoDocuments());
    const commit = vi.fn();
    const outcome = publishToShownDocument('b.pdf', run.readState, run.place, commit);
    run.finish();
    expect(await outcome).toEqual({ stale: true });
    expect(commit).not.toHaveBeenCalled();
  });
});
