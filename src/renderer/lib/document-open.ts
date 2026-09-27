// The credential half of opening a document: which password opens its working
// copy, and what the document then allows.
//
// ISO 32000-2 7.6.4.1: the USER password opens a document without the owner's
// authority, so its working copy stays encrypted and only the /P bits' grants
// apply. `open_document` records the opener engine-side and ends the prompt;
// `check_encrypted` still reports the copy encrypted after a user open, so the
// loop never asks it again.
import { UNRESTRICTED, parseDocumentSecurity, type DocumentSecurity } from './document-permissions';
import type { PdfBuffer } from '../state/types';

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

export interface PreparedDocumentBytes {
  workingPath: string;
  name: string;
  buffer: PdfBuffer;
  pageCount: number;
  security: DocumentSecurity;
}

export interface PrepareDocumentIo extends DocumentOpenIo {
  createWorkingCopy: (sourcePath: string) => Promise<string>;
  readBuffer: (workingPath: string) => Promise<PdfBuffer>;
  rememberPassword: (sourcePath: string, password: string) => void;
  releaseCredentials: (sourcePath: string, workingPath: string) => Promise<void>;
  removeWorkingCopy: (workingPath: string) => Promise<void>;
}

/** Open and read a private working copy. Every unsuccessful path—including a
 * cancelled password prompt—releases its engine credential and removes the
 * copy; only a fully prepared result transfers ownership to the caller. */
export async function prepareDocumentWorkingCopy(
  sourcePath: string,
  fileName: string,
  io: PrepareDocumentIo,
): Promise<PreparedDocumentBytes | null> {
  const workingPath = await io.createWorkingCopy(sourcePath);
  let prepared: PreparedDocumentBytes | null = null;
  let failed = false;
  let failure: unknown;
  try {
    const opened = await openWithCredentials(workingPath, fileName, io);
    if (opened) {
      const buffer = await io.readBuffer(workingPath);
      const info = await io.call('get_page_count', { file: workingPath });
      if (opened.password !== null) io.rememberPassword(sourcePath, opened.password);
      prepared = {
        workingPath,
        name: fileName,
        buffer,
        pageCount: info.pages as number,
        security: opened.security,
      };
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!prepared) {
    try {
      await discardDocumentWorkingCopy(sourcePath, workingPath, io);
    } catch (cleanupError) {
      if (failed) {
        throw new AggregateError([failure, cleanupError],
          'Document opening failed and its temporary working copy could not be removed.',
          { cause: cleanupError });
      }
      throw cleanupError;
    }
  }
  if (failed) throw failure;
  return prepared;
}

/** Dispose of a prepared copy that its caller could not register in the
 * workspace (for example, a failed page-index build during import). */
export async function discardDocumentWorkingCopy(
  sourcePath: string,
  workingPath: string,
  io: Pick<PrepareDocumentIo, 'releaseCredentials' | 'removeWorkingCopy'>,
): Promise<void> {
  let releaseError: unknown;
  try {
    await io.releaseCredentials(sourcePath, workingPath);
  } catch (error) {
    releaseError = error;
  }
  try {
    await io.removeWorkingCopy(workingPath);
  } catch (removeError) {
    if (releaseError !== undefined) {
      throw new AggregateError([releaseError, removeError],
        'The temporary working copy could not be fully discarded.', { cause: removeError });
    }
    throw removeError;
  }
  if (releaseError !== undefined) throw releaseError;
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
      const attempt = await io.call('open_document_attempt', {
        path: workingPath,
        password: answer.password,
      });
      if (attempt.status === 'wrong_password') {
        error = io.wrongPassword();
        continue;
      }
      if (attempt.status !== 'opened' || !attempt.document || typeof attempt.document !== 'object') {
        throw new Error('invalid open_document_attempt response');
      }
      opened = attempt.document as Reply;
      password = answer.password;
      break;
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
