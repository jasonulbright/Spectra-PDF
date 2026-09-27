import { describe, expect, it } from 'vitest';
import { confirmDirtySnapshots, sameDirtyPromptSnapshot, unconfirmedDirtySnapshots } from '../src/renderer/lib/dirty-prompt';

describe('dirty prompt snapshots', () => {
  it('does not ask again for unchanged dirty state already covered by the answer', () => {
    const file = {};
    const page = {};
    const snapshot = { path: 'a.pdf', fileRevision: file, pageRevisions: [page] };

    expect(sameDirtyPromptSnapshot(snapshot, { ...snapshot, pageRevisions: [page] })).toBe(true);
    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', snapshot]]), [snapshot])).toEqual([]);
  });

  it('asks for a file that became dirty while an earlier prompt was open', () => {
    const prior = { path: 'a.pdf', fileRevision: {}, pageRevisions: [] };
    const newlyDirty = { path: 'b.pdf', fileRevision: {}, pageRevisions: [] };

    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', prior]]), [prior, newlyDirty])).toEqual([
      newlyDirty,
    ]);
  });

  it('asks again when the same file receives edits while its prompt is open', () => {
    const prior = { path: 'a.pdf', fileRevision: {}, pageRevisions: [{}] };
    const edited = { ...prior, pageRevisions: [{}] };

    expect(sameDirtyPromptSnapshot(prior, edited)).toBe(false);
    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', prior]]), [edited])).toEqual([edited]);
  });

  it('prompts again for a second file that becomes dirty while the first prompt is open', async () => {
    const a = { path: 'a.pdf', fileRevision: {}, pageRevisions: [] };
    const b = { path: 'b.pdf', fileRevision: {}, pageRevisions: [] };
    let live = [a];
    const prompted: string[][] = [];

    await expect(confirmDirtySnapshots(
      () => live,
      async (pending) => {
        prompted.push(pending.map(({ path }) => path));
        if (prompted.length === 1) live = [a, b];
        return 'discard';
      },
      async () => true,
    )).resolves.toBe(true);

    expect(prompted).toEqual([['a.pdf'], ['b.pdf']]);
  });

  it('prompts again if a file is edited while its own prompt is open', async () => {
    const first = { path: 'a.pdf', fileRevision: {}, pageRevisions: [{}] };
    const edited = { ...first, pageRevisions: [{}] };
    let live = [first];
    let prompts = 0;

    await expect(confirmDirtySnapshots(
      () => live,
      async () => {
        prompts += 1;
        if (prompts === 1) live = [edited];
        return 'discard';
      },
      async () => true,
    )).resolves.toBe(true);

    expect(prompts).toBe(2);
  });
});
