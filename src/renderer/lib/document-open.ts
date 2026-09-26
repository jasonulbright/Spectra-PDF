// The credential half of opening a document: which password opens its working
// copy, and what the document then allows.
//
// ISO 32000-2 7.6.4.1: the USER password opens a document without the owner's
// authority, so its working copy stays encrypted and only the /P bits' grants
// apply. `open_document` records the opener engine-side and ends the prompt;
// `check_encrypted` still reports the copy encrypted after a user open, so the
// loop never asks it again.
import { UNRESTRICTED, parseDocumentSecurity, type DocumentSecurity } from './document-permissions';

type Reply = Record<string, unknown>;

export interface DocumentOpenIo {
  call: (method: string, params: Record<string, unknown>) => Promise<Reply>;
  askPassword: (fileName: string, error?: string) => Promise<{ password: string } | 'cancel'>;
  askCertificate: (
    fileName: string,
    error?: string,
    pfx?: string,
  ) => Promise<{ pfx: string; password: string } | 'cancel'>;
  /** The prompt's line after a password that did not open the document. */
  wrongPassword: () => string;
}

export interface OpenedCredentials {
  security: DocumentSecurity;
  /** The user password, for pdf.js to read the still-encrypted copy; null
   * when the copy is not encrypted or opens with the empty password. */
  password: string | null;
}

/** Null when the user cancelled the prompt. */
export async function openWithCredentials(
  workingPath: string,
  fileName: string,
  io: DocumentOpenIo,
): Promise<OpenedCredentials | null> {
  const status = await io.call('check_encrypted', { file: workingPath });
  // A certificate refusal ("does not match any recipient" / "check the file
  // and its password") is already the engine's honest sentence, so it is shown
  // verbatim.
  if (status.encrypted === true && status.kind === 'pubkey') {
    let error: string | undefined;
    let pfx: string | undefined;
    for (;;) {
      const answer = await io.askCertificate(fileName, error, pfx);
      if (answer === 'cancel') return null;
      pfx = answer.pfx;
      try {
        await io.call('decrypt_pubkey', {
          file: workingPath,
          output: workingPath,
          pfx: answer.pfx,
          password: answer.password,
        });
        return { security: UNRESTRICTED, password: null };
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  let password = '';
  let opened: Reply;
  if (status.encrypted === true) {
    let error: string | undefined;
    for (;;) {
      const answer = await io.askPassword(fileName, error);
      if (answer === 'cancel') return null;
      try {
        opened = await io.call('open_document', { path: workingPath, password: answer.password });
        password = answer.password;
        break;
      } catch {
        error = io.wrongPassword();
      }
    }
  } else {
    // A document encrypted with an empty user password opens without a prompt
    // (7.6.4.4) and still carries /P, so it is opened like any other.
    const probe = await io.call('document_permissions', { path: workingPath });
    if (probe.encrypted !== true) return { security: UNRESTRICTED, password: null };
    opened = await io.call('open_document', { path: workingPath, password: '' });
  }
  if (opened.encrypted !== true) return { security: UNRESTRICTED, password: null };
  const security = parseDocumentSecurity(await io.call('document_permissions', { path: workingPath }));
  return { security, password: security.opener === 'user' && password !== '' ? password : null };
}
