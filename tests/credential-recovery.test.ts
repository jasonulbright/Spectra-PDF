import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetLostCredential,
  hasLostCredential,
  lostPathsIn,
  markCredentialLost,
  restoreLostCredentials,
  setCredentialUnlocker,
  unlockLostDocument,
  type UnlockIo,
} from '../src/renderer/lib/credential-recovery';
import { UNRESTRICTED } from '../src/renderer/lib/document-permissions';

const W = 'C:\\work\\a\\doc.pdf';

afterEach(() => {
  setCredentialUnlocker(null);
  forgetLostCredential(W);
});

describe('credential recovery after a worker replacement', () => {
  it('finds a lost working copy named anywhere in the parameters', () => {
    expect(lostPathsIn({ file: W })).toEqual([]);
    markCredentialLost(W);
    expect(lostPathsIn({ files: [{ path: 'c:/work/a/DOC.pdf' }] })).toEqual([W]);
    expect(lostPathsIn({ file: 'C:\\work\\b\\doc.pdf' })).toEqual([]);
  });

  it('unlocks once before the operation and not again after', async () => {
    markCredentialLost(W);
    const asked: string[] = [];
    setCredentialUnlocker(async (path) => {
      asked.push(path);
      return true;
    });
    await Promise.all([restoreLostCredentials({ file: W }), restoreLostCredentials({ path: W })]);
    await restoreLostCredentials({ file: W });
    expect(asked).toEqual([W]);
    expect(hasLostCredential(W)).toBe(false);
  });

  it('a cancelled prompt lets the call go on and asks again next time', async () => {
    markCredentialLost(W);
    let asked = 0;
    setCredentialUnlocker(async () => {
      asked += 1;
      return false;
    });
    await restoreLostCredentials({ file: W });
    await restoreLostCredentials({ file: W });
    expect(asked).toBe(2);
    expect(hasLostCredential(W)).toBe(true);
  });

  function io(replies: unknown[], answers: unknown[]): UnlockIo & { calls: [string, Record<string, unknown>][]; remembered: string[] } {
    const calls: [string, Record<string, unknown>][] = [];
    const remembered: string[] = [];
    return {
      calls,
      remembered,
      call: async (method, params) => {
        calls.push([method, params]);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
      askPassword: async () => answers.shift() as { password: string } | 'cancel',
      askCertificate: async () => answers.shift() as { pfx: string; password: string } | 'cancel',
      wrongPassword: () => 'wrong',
      rememberPassword: (_source, password) => remembered.push(password),
    };
  }

  it('re-opens a password document with the password the user gives', async () => {
    const doc = { path: 'C:\\users\\doc.pdf', name: 'doc.pdf', workingPath: W, security: { ...UNRESTRICTED, opener: 'user' as const } };
    const unlock = io(
      [{ status: 'wrong_password' }, { status: 'opened', document: { opener: 'user' } }],
      [{ password: 'x' }, { password: 'u' }],
    );
    expect(await unlockLostDocument(doc, unlock)).toBe(true);
    expect(unlock.calls.map(([m, p]) => [m, p.password])).toEqual([
      ['open_document_attempt', 'x'],
      ['open_document_attempt', 'u'],
    ]);
    expect(unlock.remembered).toEqual(['u']);
  });

  it('reattaches a certificate document against the user file', async () => {
    const doc = { path: 'C:\\users\\doc.pdf', name: 'doc.pdf', workingPath: W, security: { ...UNRESTRICTED, opener: 'recipient' as const } };
    const unlock = io([new Error('no match'), { opener: 'recipient' }], [
      { pfx: 'a.pfx', password: 'p' },
      { pfx: 'b.pfx', password: 'p' },
    ]);
    expect(await unlockLostDocument(doc, unlock)).toBe(true);
    expect(unlock.calls[1]).toEqual(['pubkey_reattach', { path: W, source: doc.path, pfx: 'b.pfx', password: 'p' }]);
    expect(await unlockLostDocument(doc, io([], ['cancel']))).toBe(false);
  });
});
