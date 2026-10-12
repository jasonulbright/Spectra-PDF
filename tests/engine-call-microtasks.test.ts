import { describe, expect, it } from 'vitest';
import { engineClosures } from './helpers/engine-closures';
import { exclusiveKeys, lockKeysFor, withFileLock, withWriteChain } from '../src/renderer/lib/engine-lock';
import { beginDocumentWrites } from '../src/renderer/lib/document-writes';
import type { ReaderCopyIo } from '../src/renderer/lib/reader-copy';

// How many microtasks an engine call takes to settle when nothing holds its
// keys. Readers that render from a call's answer (the text layer, the index)
// see a later answer as a later rebuild; a change that adds a tick to every
// call shifts them all. The counts are those the closures took before reader
// copies existed, and a method that is not a reader-copy member keeps them.

async function microtasks(start: () => Promise<unknown>): Promise<number> {
  let settled = false;
  void start().then(() => { settled = true; });
  let n = 0;
  while (!settled && n < 1000) {
    await Promise.resolve();
    n++;
  }
  return n;
}

const io: ReaderCopyIo = {
  fileAt: path => ({ workingPath: path }),
  create: async () => 'C:\\work\\a.1\\r1-00000001\\doc.pdf',
  remove: async () => true,
  lend: async () => false,
  giveBack: async () => {},
};

function closures(trackable: boolean, readerCopies: ReaderCopyIo | null) {
  return engineClosures({
    isTrackableMethod: () => trackable, beginInteractive: () => () => {},
    runCommitGate: async () => {}, restoreLostCredentials: async () => {}, lockKeysFor, exclusiveKeys, withFileLock,
    withWriteChain, beginDocumentWrites,
    track: async (_m: string, _p: unknown, run: () => Promise<unknown>) => run(),
    rawCall: async () => ({}), readerCopies,
  });
}

const W = 'C:\\work\\a.1\\doc.pdf';

describe('a call that is not a reader-copy member takes no added tick', () => {
  for (const readerCopies of [io, null]) {
    const label = readerCopies ? 'with reader copies' : 'with none';
    it(`call, trackable (${label})`, async () => {
      expect(await microtasks(() => closures(true, readerCopies).call('extract_text', { file: W, output: 'C:\\o.txt' }))).toBe(9);
    });
    it(`call, internal (${label})`, async () => {
      expect(await microtasks(() => closures(false, readerCopies).call('list_text_paragraphs', { file: W }))).toBe(4);
    });
    it(`callLocked (${label})`, async () => {
      expect(await microtasks(() => closures(false, readerCopies).callLocked('list_text_paragraphs', { file: W }))).toBe(2);
    });
  }
});
