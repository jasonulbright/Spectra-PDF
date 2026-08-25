// The decisions a form submission makes, apart from the dialog that shows them
// and the Rust client that performs the request.
//
// Two of them, and both are the security posture rather than plumbing:
//
//   • What is SENT. The request is built from the action's own format and the
//     payload the engine already wrote — a file, a content type and a
//     destination. Nothing here reads a field, because the payload builder
//     (`export_form_data`) is the only thing that ever does; the dialog shows
//     that file's bytes, so what the user sees is what transmits.
//   • What is DONE with what comes back. A response is untrusted bytes routed
//     by its declared content type into a door the app already has: the form
//     data import, the ordinary open funnel, or a saved file for the system
//     browser. There is no fourth answer, and an unknown type takes the
//     saved-file one — the door that interprets nothing.
//
// Pure, so both are pinned by tests rather than by clicking.

import type { SubmitFormat } from './field-actions';

/** The `Content-Type` a submission of each format is posted under. The names
 * are the ecosystem's own registrations; an HTML submission is a form post,
 * which is what `/SubmitForm`'s HTML flag means. */
export const SUBMIT_CONTENT_TYPE: Record<SubmitFormat, string> = {
  fdf: 'application/vnd.fdf',
  xfdf: 'application/vnd.adobe.xfdf',
  html: 'application/x-www-form-urlencoded',
  pdf: 'application/pdf',
};

/** The extension the built payload is written under. */
export const SUBMIT_EXTENSION: Record<SubmitFormat, string> = {
  fdf: '.fdf',
  xfdf: '.xfdf',
  html: '.txt',
  pdf: '.pdf',
};

/** What the Rust client is handed. Mirrors `src-tauri/src/net.rs` `NetRequest`;
 * P39's open-from-web-address builds the same shape with no body. */
export interface SubmitRequest {
  url: string;
  method: 'get' | 'post';
  bodyPath: string;
  contentType: string;
  fileName: string;
  /** A submit destination is DOCUMENT-chosen, so a private/loopback/link-local
   * target is refused by name: a document must not steer a state-changing
   * request at a service on the user's own machine or LAN. Always true here. */
  refusePrivate: true;
}

/** The request for one submit action and one already-built payload file. */
export function submitRequest(
  action: { url: string; format: SubmitFormat; method: 'post' | 'get' },
  payloadPath: string,
  stem: string,
): SubmitRequest {
  return {
    url: action.url,
    method: action.method,
    bodyPath: payloadPath,
    contentType: SUBMIT_CONTENT_TYPE[action.format],
    fileName: stem,
    refusePrivate: true,
  };
}

/** Whether the destination is plain HTTP, which the dialog says out loud. An
 * address that is not a web address at all is not "plain HTTP" — it is
 * refused by `destinationRefusal` before the dialog opens. */
export function isPlainHttp(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

/** Why this destination cannot be submitted to at all, or null when it can.
 * Returns a catalog KEY, never a sentence — the caller renders it.
 *
 * `mailto:` is the case worth naming: `/SubmitForm` allows one, and this app
 * has no mail transport and will not hand a document-supplied string to a
 * shell-open. The payload is still built and can still be saved. */
export type DestinationRefusal =
  | 'app.formButton.submitNoUrl'
  | 'app.formButton.submitMailto'
  | 'app.formButton.submitNotWeb';

export function destinationRefusal(url: string): DestinationRefusal | null {
  const trimmed = url.trim();
  if (!trimmed) return 'app.formButton.submitNoUrl';
  if (/^mailto:/i.test(trimmed)) return 'app.formButton.submitMailto';
  if (!/^https?:\/\//i.test(trimmed)) return 'app.formButton.submitNotWeb';
  return null;
}

/** How the payload is shown before it is sent.
 *
 * FDF, XFDF and HTML are text and are shown as text — the exact bytes, decoded
 * as UTF-8 with anything undecodable left visible rather than dropped. A PDF
 * submission is the document itself, which is not readable as text, so it is
 * SUMMARIZED: the caller renders the byte count and the field count. Neither
 * form paraphrases; a summary states that it is one. */
export type PayloadPreview =
  | { kind: 'text'; text: string; bytes: number }
  | { kind: 'document'; bytes: number };

export function payloadPreview(format: SubmitFormat, bytes: Uint8Array): PayloadPreview {
  if (format === 'pdf') return { kind: 'document', bytes: bytes.length };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { kind: 'text', text, bytes: bytes.length };
}

/** Where a response goes. Three doors, all of them doors the app already has.
 *
 *   • `formData` — the existing form-data import, user-confirmed.
 *   • `document` — the ordinary open funnel (`App.openByPaths`).
 *   • `file` — offered as a saved file, for the system browser or anything
 *     else. HTML lands here BY DESIGN: this app never renders a fetched page.
 *
 * The classification is by declared content type only. A type this build does
 * not know takes the `file` door, which is the one that interprets nothing —
 * sniffing the bytes to find a better door would be the app deciding to parse
 * something the server did not claim it had sent. */
export type ResponseRoute = 'formData' | 'document' | 'file';

export function responseRoute(contentType: string): ResponseRoute {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (base) {
    case 'application/vnd.fdf':
    case 'application/vnd.adobe.xfdf':
    case 'application/xfdf+xml':
      return 'formData';
    case 'application/pdf':
      return 'document';
    default:
      return 'file';
  }
}

/** Whether the server's status means the submission was accepted. A 2xx is an
 * acceptance; everything else is reported by number and the response is still
 * offered, because an error page is often the only thing that says what went
 * wrong. */
export function statusAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}
