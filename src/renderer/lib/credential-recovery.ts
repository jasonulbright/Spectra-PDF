// A replaced engine worker is given the window's document credentials again
// by the Rust side. A credential it refuses (the working copy changed or was
// removed, the certificate file moved) arrives as `engine:credential-lost`
// naming the working copy. The document is then unlocked again through the
// ordinary prompts before the next operation that names it, instead of that
// operation failing on a password error.
import { isRecipientOpened, type DocumentSecurity } from './document-permissions';

type Reply = Record<string, unknown>;

/** Unlocks the working copy at `workingPath`; false when the user cancelled. */
export type CredentialUnlocker = (workingPath: string) => Promise<boolean>;

const lost = new Map<string, string>();
let unlocker: CredentialUnlocker | null = null;
let running: Promise<void> | null = null;

function key(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
}

export function markCredentialLost(workingPath: string): void {
  lost.set(key(workingPath), workingPath);
}

export function forgetLostCredential(workingPath: string): void {
  lost.delete(key(workingPath));
}

export function hasLostCredential(workingPath: string): boolean {
  return lost.has(key(workingPath));
}

export function setCredentialUnlocker(next: CredentialUnlocker | null): void {
  unlocker = next;
}

/** The lost working copies `params` names, at any depth. */
export function lostPathsIn(params: unknown): string[] {
  if (lost.size === 0) return [];
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const held = lost.get(key(value));
      if (held !== undefined) found.add(held);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(params);
  return [...found];
}

/** Unlock every lost working copy `params` names, one prompt at a time. A
 * cancelled prompt leaves the copy marked, so the call goes on and fails
 * with the engine's own refusal, and the next call asks again. */
export async function restoreLostCredentials(params: unknown): Promise<void> {
  for (;;) {
    const paths = lostPathsIn(params);
    if (paths.length === 0 || !unlocker) return;
    if (running) {
      await running.catch(() => {});
      continue;
    }
    const unlock = unlocker;
    let cancelled = false;
    running = (async () => {
      for (const path of paths) {
        if (await unlock(path)) forgetLostCredential(path);
        else cancelled = true;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
    if (cancelled) return;
  }
}

export interface LostDocument {
  path: string;
  name: string;
  workingPath: string;
  security?: DocumentSecurity;
}

export interface UnlockIo {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  askPassword: (fileName: string, error?: string) => Promise<{ password: string } | 'cancel'>;
  askCertificate: (
    fileName: string,
    error?: string,
    pfx?: string,
  ) => Promise<{ pfx: string; password: string } | 'cancel'>;
  wrongPassword: () => string;
  rememberPassword: (sourcePath: string, password: string) => void;
}

/** Ask for `doc`'s password or certificate again and register it with the
 * engine; false when the user cancelled. */
export async function unlockLostDocument(doc: LostDocument, io: UnlockIo): Promise<boolean> {
  let error: string | undefined;
  if (isRecipientOpened(doc.security)) {
    let pfx: string | undefined;
    for (;;) {
      const answer = await io.askCertificate(doc.name, error, pfx);
      if (answer === 'cancel') return false;
      pfx = answer.pfx;
      try {
        await io.call('pubkey_reattach', {
          path: doc.workingPath, source: doc.path, pfx: answer.pfx, password: answer.password,
        });
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  for (;;) {
    const answer = await io.askPassword(doc.name, error);
    if (answer === 'cancel') return false;
    const raw = await io.call('open_document_attempt', { path: doc.workingPath, password: answer.password });
    const reply = raw && typeof raw === 'object' ? (raw as Reply) : {};
    if (reply.status === 'opened') {
      io.rememberPassword(doc.path, answer.password);
      return true;
    }
    error = io.wrongPassword();
  }
}
