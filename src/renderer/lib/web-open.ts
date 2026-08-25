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

/**
 * Whether a host is a LITERAL private/loopback/link-local address.
 *
 * A hint for the dialog only: open-from-web is user-typed and a private address
 * is fetched (Rust warns, does not refuse), but the address bar convention that
 * flags "this is your own machine or LAN" does not exist here, so the dialog
 * says so. Only literals are judged — a hostname's resolution is unknown until
 * Rust resolves it, and guessing here would either miss or over-warn.
 */
export function isPrivateHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h === '') return false;
  // Strip an IPv6 bracket/zone or an IPv4 port.
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) h = h.slice(1, end);
  } else if (h.includes(':') && h.split(':').length === 2) {
    h = h.slice(0, h.indexOf(':'));
  }
  h = h.split('%')[0]; // drop an IPv6 zone id

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map((n) => Number(n));
    if (o.some((n) => n > 255)) return false;
    if (o[0] === 127 || o[0] === 0) return true; // loopback, "this host"
    if (o[0] === 10) return true; // 10/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true; // 192.168/16
    if (o[0] === 169 && o[1] === 254) return true; // link-local + metadata
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true; // loopback, unspecified
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
      return true; // fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7
  }
  return false;
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
