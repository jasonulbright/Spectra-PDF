// The credential half of opening a document: which password opens its working
// copy, and what the document then allows.
//
// ISO 32000-2 7.6.4.1: the USER password opens a document without the owner's
// authority, so its working copy stays encrypted and only the /P bits' grants
// apply. `open_document` records the opener engine-side and ends the prompt;
// `check_encrypted` still reports the copy encrypted after a user open, so the
// loop never asks it again.
//
// 7.6.5: a certificate-encrypted (Adobe.PubSec) document opens with the
// grants of the first recipient list that matches the key. Neither qpdf nor
// pdf.js reads that handler, so its working copy is plaintext inside the
// app's private working folder, and every save of it is resealed under the
// original recipient lists (`saveWorkingCopy`).
import { tChrome } from '../i18n';
import { withWriteChain } from './engine-lock';
import {
  UNRESTRICTED,
  isRecipientOpened,
  parseDocumentSecurity,
  type DocumentSecurity,
} from './document-permissions';
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
  /** Told which certificate opened a certificate-encrypted document. */
  certificateOpened?: (fileName: string, recipient: CertificateRecipient) => void;
}

export interface CertificateRecipient {
  subject: string;
  issuer: string;
  serial: string;
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
          tChrome('app.open.cleanupFailed'),
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
        tChrome('app.open.discardFailed'), { cause: removeError });
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
      let reply: Reply;
      try {
        reply = await io.call('open_pubkey_document', {
          path: workingPath,
          pfx: answer.pfx,
          password: answer.password,
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (reply.opener !== 'recipient') throw new Error(tChrome('app.open.invalidReply'));
      const recipient = readRecipient(reply.recipient);
      if (recipient) io.certificateOpened?.(fileName, recipient);
      return { security: parseDocumentSecurity(reply), password: null };
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
        throw new Error(tChrome('app.open.invalidReply'));
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

function readRecipient(raw: unknown): CertificateRecipient | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return { subject: text(r.subject), issuer: text(r.issuer), serial: text(r.serial) };
}

export interface SaveWorkingCopyIo {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  saveAs: (source: string, dest: string) => Promise<unknown>;
  remove: (path: string) => Promise<void>;
  /** Asks whether to save a signed document whose signatures the rewrite
   * breaks. Absent on a save nobody asked for (a tab hand-off), which then
   * refuses. */
  confirmSignatureBreak?: () => Promise<boolean>;
  /** Authenticates the certificate again after an engine restart lost it;
   * false when the user cancelled. */
  reattach: () => Promise<boolean>;
}

let resealStage = 0;

/** Write the working copy over `dest`; false when the user declined. A
 * certificate-opened working copy is plaintext, so it is first resealed under
 * the document's own recipient lists into a stage beside it; the plaintext
 * never reaches `dest`. */
export async function saveWorkingCopy(
  workingPath: string,
  security: DocumentSecurity | undefined,
  dest: string,
  io: SaveWorkingCopyIo,
): Promise<boolean> {
  // Without the renderer's record, the engine's record of the working folder
  // decides: a certificate-opened copy is plaintext and never copied as is.
  const known = security ?? parseDocumentSecurity(await io.call('document_permissions', { path: workingPath }));
  if (!isRecipientOpened(known)) {
    await io.saveAs(workingPath, dest);
    return true;
  }
  resealStage += 1;
  const stage = `${workingPath}.${Date.now()}-${resealStage}.sealed`;
  try {
    // The reseal reads the working copy, so it holds the copy's write chain:
    // a staged rewrite of the copy publishes first, as it does before an
    // unsealed save (`withFileSave`). The stage it writes has no other writer.
    const resealed = await withWriteChain([workingPath], async () => {
      let breakSignatures = false;
      let reattached = false;
      for (;;) {
        const raw = await io.call('pubkey_reseal', { path: workingPath, output: stage, break_signatures: breakSignatures });
        const reply = raw && typeof raw === 'object' ? (raw as Reply) : null;
        if (reply?.output === stage) return true;
        if (reply?.output === null && reply.needs_certificate === true && !reattached) {
          if (!(await io.reattach())) return false;
          reattached = true;
          continue;
        }
        if (reply?.output === null && typeof reply.signatures === 'number' && !breakSignatures) {
          if (!io.confirmSignatureBreak) throw new Error(tChrome('app.save.signedCertificateImplicit'));
          if (!(await io.confirmSignatureBreak())) return false;
          breakSignatures = true;
          continue;
        }
        throw new Error(tChrome('app.save.invalidReply'));
      }
    });
    if (!resealed) return false;
    await io.saveAs(stage, dest);
    return true;
  } finally {
    await io.remove(stage).catch(() => {});
  }
}
