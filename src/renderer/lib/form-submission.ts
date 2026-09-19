// A form button's submission, from the consent it asks for to what becomes of
// the reply, with every effect passed in, so the whole run tests without a
// DOM or a network.
//
// It owns the two temp files a submission makes. The payload holds the form's
// data: it is removed at the point it is abandoned (a declined consent, a
// saved copy, a failed build), and once it is handed to the request the Rust
// client removes it whatever the outcome. The reply is removed once the run is
// done with it (imported, saved, declined, empty, or rejected), except when it
// opened as a document: then it is that document's path.
import { tChrome } from '../i18n';
import type { SubmitFormat } from './field-actions';
import {
  SUBMIT_EXTENSION,
  destinationRefusal,
  payloadPreview,
  responseRoute,
  statusAccepted,
  submitRequest,
  type PayloadPreview,
  type SubmitRequest,
} from './form-submit';

export interface SubmitAction {
  url: string;
  format: SubmitFormat;
  method: 'post' | 'get';
  fields: string[] | null;
  exclude: boolean;
  includeEmpty: boolean;
}

/** `src-tauri/src/net.rs` `NetResponse`: a path to the reply, never its bytes. */
export interface SubmissionReply {
  status: number;
  contentType: string;
  path: string;
  bytes: number;
}

export interface SubmissionIo {
  /** Two buttons: proceed or not. */
  confirm: (title: string, message: string) => Promise<boolean>;
  /** One button: acknowledged. */
  notice: (title: string, message: string) => Promise<void>;
  consent: (ask: {
    field: string;
    url: string;
    format: SubmitFormat;
    method: 'post' | 'get';
    preview: PayloadPreview;
    fieldCount: number;
  }) => Promise<'submit' | 'save' | 'cancel'>;
  /** A path in the app's network scratch folder for the payload. */
  payloadPath: (stem: string, extension: string) => Promise<string>;
  /** Write the form's data to `output`; the count of fields it holds. */
  buildPayload: (output: string) => Promise<{ count?: number }>;
  payloadBytes: (path: string) => Promise<Uint8Array>;
  send: (request: SubmitRequest) => Promise<SubmissionReply>;
  /** The save dialog; null when the user cancels it. */
  saveTarget: (suggestedName: string) => Promise<string | null>;
  copyFile: (from: string, to: string) => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  importFormData: (dataPath: string) => Promise<void>;
  /** Open `path` as a document; whether it is one now. */
  openDocument: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
}

/** Remove a temp file this run made. A file already gone is not an error. */
async function discard(io: SubmissionIo, path: string): Promise<void> {
  await io.remove(path).catch(() => {});
}

export async function runSubmission(
  io: SubmissionIo,
  submission: { field: string; stem: string; action: SubmitAction },
): Promise<void> {
  const { field, stem, action } = submission;
  // A destination this app has no transport for — an empty address, a
  // `mailto:`, anything that is not http(s). The payload is still built and
  // can still be saved: the refusal is about the transport, never about the
  // submission.
  const refusalKey = destinationRefusal(action.url);
  const proceed = await io.confirm(
    tChrome('app.formButton.submitTitle'),
    refusalKey
      ? tChrome(refusalKey, { field })
      : tChrome('app.formButton.submit', { field, url: action.url, format: action.format }),
  );
  if (!proceed) return;
  // The payload is built to the app's own temp tree FIRST, because the
  // consent dialog shows that file's bytes: a preview assembled from anything
  // else would be a second answer to what gets transmitted.
  const payloadPath = await io.payloadPath(`${stem}-submission`, SUBMIT_EXTENSION[action.format].slice(1));
  let handedOff = false;
  let reply: SubmissionReply;
  try {
    const built = await io.buildPayload(payloadPath);

    /** The built submission handed over as a file, with its destination
     * offered to the clipboard. */
    const saveBuiltCopy = async (): Promise<void> => {
      const target = await io.saveTarget(`${stem}${SUBMIT_EXTENSION[action.format]}`);
      if (!target) return;
      await io.copyFile(payloadPath, target);
      const copy = await io.confirm(
        tChrome('app.formButton.submitBuiltTitle'),
        tChrome('app.formButton.submitBuilt', { file: target, url: action.url }),
      );
      if (copy) await io.copyToClipboard(action.url);
    };

    if (refusalKey) {
      await saveBuiltCopy();
      return;
    }

    const answer = await io.consent({
      field,
      url: action.url,
      format: action.format,
      method: action.method,
      preview: payloadPreview(action.format, await io.payloadBytes(payloadPath)),
      fieldCount: built.count ?? 0,
    });
    if (answer === 'cancel') return;
    if (answer === 'save') {
      await saveBuiltCopy();
      return;
    }

    handedOff = true;
    try {
      reply = await io.send(submitRequest(action, payloadPath, `${stem}-reply`));
    } catch (error) {
      await io.notice(
        tChrome('app.formButton.submitFailedTitle'),
        tChrome('app.formButton.submitFailed', { url: action.url, detail: String(error) }),
      );
      return;
    }
  } finally {
    if (!handedOff) await discard(io, payloadPath);
  }

  let opened = false;
  try {
    /** The reply as a file the user keeps — the door that interprets
     * nothing. An HTML reply always lands here: this app never renders a
     * page it was sent. */
    const saveReply = async (): Promise<void> => {
      const suffix = reply.path.slice(reply.path.lastIndexOf('.'));
      const target = await io.saveTarget(`${stem}-reply${suffix}`);
      if (!target) return;
      await io.copyFile(reply.path, target);
      await io.notice(
        tChrome('app.formButton.submitSentTitle'),
        tChrome('app.formButton.submitReplySaved', { file: target }),
      );
    };

    if (!statusAccepted(reply.status)) {
      await io.notice(
        tChrome('app.formButton.submitFailedTitle'),
        tChrome('app.formButton.submitRejected', { url: action.url, status: reply.status }),
      );
      if (reply.bytes > 0) await saveReply();
      return;
    }
    if (reply.bytes === 0) {
      await io.notice(
        tChrome('app.formButton.submitSentTitle'),
        tChrome('app.formButton.submitEmptyReply', { url: action.url }),
      );
      return;
    }
    // Everything below routes UNTRUSTED bytes into a door this app already
    // has, and every door asks first. Nothing executes.
    switch (responseRoute(reply.contentType)) {
      case 'formData': {
        const importIt = await io.confirm(
          tChrome('app.formButton.submitSentTitle'),
          tChrome('app.formButton.submitFormDataReply', { url: action.url, bytes: reply.bytes }),
        );
        if (importIt) await io.importFormData(reply.path);
        return;
      }
      case 'document': {
        const openIt = await io.confirm(
          tChrome('app.formButton.submitSentTitle'),
          tChrome('app.formButton.submitDocumentReply', { url: action.url, bytes: reply.bytes }),
        );
        if (openIt) opened = await io.openDocument(reply.path);
        return;
      }
      default: {
        const saveIt = await io.confirm(
          tChrome('app.formButton.submitSentTitle'),
          tChrome('app.formButton.submitFileReply', {
            url: action.url,
            bytes: reply.bytes,
            type: reply.contentType || tChrome('app.formButton.submitFileReplyUnknown'),
          }),
        );
        if (saveIt) await saveReply();
        return;
      }
    }
  } finally {
    if (!opened) await discard(io, reply.path);
  }
}
