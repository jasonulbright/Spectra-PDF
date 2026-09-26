// The user password of each document opened with it, for pdf.js only: the
// working copy of such a document stays encrypted (ISO 32000-2 7.6.4.1), and
// pdf.js has to decrypt it on every load, including the reload after new
// bytes land. Module memory only: never application state, never storage,
// never a log. Keyed by the file's path, the key `pdfDocCache` loads under.

const passwords = new Map<string, string>();

export function rememberDocumentPassword(path: string, password: string): void {
  passwords.set(path, password);
}

export function documentPassword(path: string): string | undefined {
  return passwords.get(path);
}

export function forgetDocumentPassword(path: string): void {
  passwords.delete(path);
}
