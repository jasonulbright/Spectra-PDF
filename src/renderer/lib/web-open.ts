// File ▸ Open from web address — the parts that decide, with no React and no
// IPC in them.
//
// The address the user types is read HERE and shown back before anything is
// fetched, so what the dialog displays is the string that is handed to the one
// outbound client. Rust's `validate_http_url` is what DECIDES — this reader is
// deliberately no more permissive than it is, with one addition it states
// rather than hides: a bare `example.com/a.pdf` becomes `https://example.com/a.pdf`
// and the dialog shows the rewritten address. A non-http scheme is never
// rewritten into one; `file:`, `javascript:` and `data:` are refused by name.
//
// A document fetched from the web lands on a temp working path. That path is
// not a place a save belongs, so a file opened this way carries its origin and
// File ▸ Save routes to Save As — see `saveRouteFor`.

/** Why an address cannot be used. One reason per refusal, keyed to a string. */
export type WebUrlRefusal = 'empty' | 'spaces' | 'scheme' | 'host';

export type WebUrlVerdict =
  | { ok: true; url: string; host: string; insecure: boolean }
  | { ok: false; reason: WebUrlRefusal };

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** A scheme-looking prefix with no `//` — `mailto:`, `javascript:`, `data:`. */
const OPAQUE_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * Read a typed or pasted address into the exact URL that would be fetched.
 *
 * Whitespace anywhere inside is a refusal rather than something to strip: a
 * pasted line that broke across a word boundary is not an address, and
 * repairing it would fetch something the user never wrote.
 */
export function readWebUrl(raw: string): WebUrlVerdict {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'spaces' };

  let candidate = trimmed;
  const scheme = SCHEME.exec(trimmed);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') return { ok: false, reason: 'scheme' };
    // `https:///a.pdf` names no authority. WHATWG parsing swallows the extra
    // slash and reads the first path segment as the host, which would send a
    // request to `a.pdf`; Rust refuses the same string. Refused here so the
    // address the dialog shows is never one the typed text does not contain.
    if (trimmed.slice(name.length + 3).startsWith('/')) return { ok: false, reason: 'host' };
  } else if (OPAQUE_SCHEME.test(trimmed)) {
    // `mailto:`, `javascript:`, `data:` — a scheme this door does not open.
    // Never rewritten: prefixing https:// onto one would turn a refusal into a
    // request for a different address than the one that was typed.
    return { ok: false, reason: 'scheme' };
  } else {
    candidate = `https://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'host' };
  }
  const host = parsed.host.toLowerCase();
  if (host === '') return { ok: false, reason: 'host' };
  // `URL` keeps userinfo, and an address that carries credentials is not one
  // this app sends. Rust drops userinfo from its origin comparison; here it is
  // refused outright, because the address shown to the user is the address
  // used and a password in it has no business being displayed or sent.
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'host' };
  return {
    ok: true,
    url: parsed.toString(),
    host,
    insecure: parsed.protocol === 'http:',
  };
}

/** The refusal string for a verdict — one key per reason, no composition. */
export const WEB_URL_REFUSAL_KEYS = {
  empty: 'dialog.openWeb.refuseEmpty',
  spaces: 'dialog.openWeb.refuseSpaces',
  scheme: 'dialog.openWeb.refuseScheme',
  host: 'dialog.openWeb.refuseHost',
} as const;

/**
 * A file-name stem for the downloaded copy, from the address's last path
 * segment (its extension dropped — the response's content type picks that) or
 * the host when the path names nothing. Cosmetic: Rust sanitizes it again.
 */
export function downloadStem(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'download';
  }
  const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();
  const stem = decoded.replace(/\.[A-Za-z0-9]{1,8}$/, '') || parsed.host;
  return stem || 'download';
}

/**
 * Where File ▸ Save goes for a given open file.
 *
 * A document fetched from a web address lives on a path in the app's own temp
 * tree. Saving onto that path writes into scratch space the user cannot find
 * and the OS may clear — a save that reports success and keeps nothing. So the
 * origin routes Save to Save As, every time and not just the first: Save As
 * writes a COPY and leaves the document on its temp path (the workspace keys
 * identity by that path), so the document never acquires a home of its own to
 * save back to.
 *
 * This is the ghost rule's sibling. There, `path` was a real file the user did
 * not mean to overwrite; here, `path` is not a file the user has at all.
 */
export type SaveRoute = 'save' | 'saveAs';

export function saveRouteFor(file: { webOrigin?: string } | null | undefined): SaveRoute {
  return file && file.webOrigin ? 'saveAs' : 'save';
}
