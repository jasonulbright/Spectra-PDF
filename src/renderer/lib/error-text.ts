// A Rust `std::io::Error` displays as "<description> (os error N)". The
// description is already the operating system's localized sentence; the code
// is a diagnostic number no reader can act on. The operation log keeps the raw
// text (it is written from the raw error, never from these helpers).

const OS_ERROR_CODE = /\s*\(os error -?\d+\)(?=\s*$)/;

/** `message` without a trailing " (os error N)". */
export function withoutOsErrorCode(message: string): string {
  return message.replace(OS_ERROR_CODE, '').trimEnd();
}

/** The text a surface shows for a caught value: an Error's message, or the
 * value itself, without the operating-system error code. */
export function errorText(error: unknown): string {
  return withoutOsErrorCode(error instanceof Error ? error.message : String(error));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `message` without the leading "<path>: " (or "<path> (offset N): ") that a
 * PDF library puts in front of what it found. Used where the path is a file
 * the program created, such as a download's temporary copy, which names
 * nothing the reader chose. Path comparison ignores case and the direction of
 * the separators, because the library may print either spelling.
 */
export function withoutFilePath(message: string, path: string): string {
  if (!path) return message;
  const separators = escapeRegExp(path).replace(/\\\\|\//g, '[\\\\/]');
  const prefix = new RegExp(`^\\s*${separators}(?:\\s*\\([^)]*\\))?\\s*:\\s*`, 'i');
  return message.replace(prefix, '').trim();
}
