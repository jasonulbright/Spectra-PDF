/**
 * Following a link while READING: what a click on a /Link region does.
 *
 * The routing is a pure function of the target the engine read (`list_links`'
 * `target_spec`, the `lib/links.ts` vocabulary) and the document's own path, so
 * the parts that decide what leaves the app — which addresses are offered,
 * which files are opened, which are only named — are pinned by unit tests
 * rather than by a click in a running window.
 *
 * The policy, in one place:
 *  - A page in this document, directly or through a named destination, is a
 *    jump. It lands inside the app and changes nothing, so it asks nothing.
 *  - A web address is NEVER opened silently. Only http, https and mailto are
 *    offered at all, the full address is shown, and the reader chooses to open
 *    it in the system browser or only copy it to the clipboard.
 *  - Another PDF opens in this app once the user confirms the full path. Any
 *    other file is named and never run, a network or web location is named
 *    and never fetched, and a /Launch (a program for the system to run) is
 *    named and never run.
 */
import type { LinkTarget } from './links';

/** The only schemes a reader is offered. Everything else — `javascript:`,
 * `file:`, `data:`, a custom protocol handler that starts a program — is
 * refused and named. */
export const WEB_LINK_SCHEMES = ['http', 'https', 'mailto'] as const;
export type WebLinkScheme = (typeof WEB_LINK_SCHEMES)[number];
/** The longest address offered. The Rust command that opens one
 * (`src-tauri/src/web_link.rs`) caps bytes at the same number. */
export const MAX_WEB_LINK_LENGTH = 2048;

export type WebLinkCheck =
  | { ok: true; url: string; scheme: WebLinkScheme }
  | { ok: false; url: string; reason: 'scheme'; scheme: string | null }
  | { ok: false; url: string; reason: 'malformed' };

// The same rules are re-checked, independently, by the Rust command that opens
// an address (`src-tauri/src/web_link.rs`): this gate decides what the reader
// is offered, that one what the system browser is given.
//
// Characters that make the address the dialog SHOWS differ from the one that
// would be used: controls and whitespace (a line break pushes the real host
// out of view), and the bidirectional overrides that reorder what is drawn.
// eslint-disable-next-line no-control-regex
const DECEPTIVE = /[\u0000-\u001f\u007f-\u009f\s\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * Whether an address a link carries may be offered to the reader, and why not.
 * Only surrounding whitespace is removed; what is offered is otherwise the
 * address exactly as the document wrote it.
 */
export function checkWebLink(raw: string): WebLinkCheck {
  const url = raw.trim();
  if (!url || url.length > MAX_WEB_LINK_LENGTH || DECEPTIVE.test(url)) {
    return { ok: false, url, reason: 'malformed' };
  }
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!m) return { ok: false, url, reason: 'scheme', scheme: null };
  const scheme = m[1].toLowerCase();
  if (!(WEB_LINK_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, url, reason: 'scheme', scheme };
  }
  if (scheme === 'mailto') {
    return url.length > 'mailto:'.length
      ? { ok: true, url, scheme: 'mailto' }
      : { ok: false, url, reason: 'malformed' };
  }
  // http(s): a real authority, and no user-info. `https://bank.example@evil.example`
  // reads as one host and goes to the other. No backslash: WHATWG reads it as
  // `/`, other parsers do not.
  if (!/^https?:\/\//i.test(url) || url.includes('\\')) return { ok: false, url, reason: 'malformed' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, reason: 'malformed' };
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    return { ok: false, url, reason: 'malformed' };
  }
  return { ok: true, url, scheme: scheme as WebLinkScheme };
}

export type LinkFollowPlan =
  /** A 1-based page of THIS file, by its on-disk order. */
  | { kind: 'page'; page: number }
  | { kind: 'pageUnresolved' }
  /** A named destination of this file; resolved against its names at click. */
  | { kind: 'named'; name: string }
  | { kind: 'web'; url: string; scheme: WebLinkScheme }
  | { kind: 'webRefused'; url: string; reason: 'scheme'; scheme: string | null }
  | { kind: 'webRefused'; url: string; reason: 'malformed' }
  /** Another PDF on this machine: opened in this app after confirming. */
  | { kind: 'pdf'; path: string; page: number | null }
  /** A file that is not a PDF: named, never run. */
  | { kind: 'fileNotRun'; path: string }
  /** A network share or a web location: named, never fetched. */
  | { kind: 'fileRemote'; path: string }
  | { kind: 'launch'; path: string }
  | { kind: 'unsupported'; action: string }
  | { kind: 'none' };

/** Route one link target. `docPath` is the document's own location on disk,
 * which a relative file specification is resolved against. */
export function planLinkFollow(target: LinkTarget | null | undefined, docPath: string): LinkFollowPlan {
  if (!target) return { kind: 'none' };
  switch (target.kind) {
    case 'goto':
      return target.page != null && Number.isInteger(target.page) && target.page >= 1
        ? { kind: 'page', page: target.page }
        : { kind: 'pageUnresolved' };
    case 'named':
      return target.name ? { kind: 'named', name: target.name } : { kind: 'none' };
    case 'uri': {
      const check = checkWebLink(target.url ?? '');
      if (check.ok) return { kind: 'web', url: check.url, scheme: check.scheme };
      return check.reason === 'scheme'
        ? { kind: 'webRefused', url: check.url, reason: 'scheme', scheme: check.scheme }
        : { kind: 'webRefused', url: check.url, reason: 'malformed' };
    }
    case 'file': {
      const spec = (target.path ?? '').trim();
      if (!spec) return { kind: 'none' };
      const resolved = resolveLinkedFile(docPath, spec);
      if (resolved.kind === 'remote') return { kind: 'fileRemote', path: spec };
      if (!/\.pdf$/i.test(resolved.path)) return { kind: 'fileNotRun', path: resolved.path };
      const page = target.page != null && Number.isInteger(target.page) && target.page >= 1 ? target.page : null;
      return { kind: 'pdf', path: resolved.path, page };
    }
    case 'launch':
      return target.path?.trim() ? { kind: 'launch', path: target.path.trim() } : { kind: 'none' };
    case 'other':
      return { kind: 'unsupported', action: target.action || '?' };
    default:
      return { kind: 'none' };
  }
}

/**
 * A link's file specification as a path on this machine, or `remote` for one
 * this app will not reach for: a UNC share (`\\host\share` — merely opening
 * one on Windows sends the user's credentials to that host) or anything
 * carrying a URL scheme. A relative specification is relative to the
 * document's own folder (ISO 32000 §7.11.2); the PDF form of a drive-rooted
 * path, `/C/dir/file.pdf`, is read as `C:\dir\file.pdf` on Windows.
 */
export function resolveLinkedFile(
  docPath: string,
  spec: string,
): { kind: 'local'; path: string } | { kind: 'remote' } {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(spec)) return { kind: 'remote' };
  if (/^[\\/]{2}/.test(spec)) return { kind: 'remote' };
  // A scheme of two or more letters (a one-letter one is a drive).
  if (/^[a-z][a-z0-9+.-]+:/i.test(spec)) return { kind: 'remote' };
  const windows = /^[a-z]:[\\/]/i.test(docPath) || docPath.includes('\\');
  // A document that is itself on a share: a relative link stays on that share
  // (the user's own choice of location), and `..` never climbs off it.
  const shareRoot = windows && /^[\\/]{2}/.test(docPath);
  const sep = windows ? '\\' : '/';
  let base: string[];
  let rest: string;
  if (windows && /^[a-z]:[\\/]/i.test(spec)) {
    base = [spec.slice(0, 2)];
    rest = spec.slice(3);
  } else if (windows && /^\/[a-z]\//i.test(spec)) {
    base = [`${spec[1].toUpperCase()}:`];
    rest = spec.slice(3);
  } else if (windows && /^[a-z]:/i.test(spec)) {
    // Drive-relative (`C:file.pdf`): nothing reliable to anchor it on.
    return { kind: 'remote' };
  } else if (/^[\\/]/.test(spec)) {
    const drive = windows ? /^([a-z]:)/i.exec(docPath)?.[1] : '';
    if (windows && !drive) return { kind: 'remote' };
    base = windows ? [drive as string] : [''];
    rest = spec.slice(1);
  } else {
    const parts = docPath.split(/[\\/]/);
    parts.pop();
    base = parts;
    rest = spec;
  }
  const out = [...base];
  const floor = shareRoot ? Math.min(4, base.length) : windows ? 1 : base[0] === '' ? 1 : 0;
  for (const seg of rest.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > floor) out.pop();
      continue;
    }
    out.push(seg);
  }
  return { kind: 'local', path: out.join(sep) };
}

/** The 1-based page a named destination lands on, or null when the document
 * does not declare it or it resolves to no page. */
export function namedDestinationPage(
  names: readonly { name: string; page: number | null }[] | null | undefined,
  name: string,
): number | null {
  const hit = names?.find((d) => d.name === name);
  return hit && hit.page != null && Number.isInteger(hit.page) && hit.page >= 1 ? hit.page : null;
}

/** What a link region says to a screen reader and in its tooltip: where it
 * goes, as a catalog key and its values. */
export function followLabel(target: LinkTarget | null | undefined):
  | { key: 'canvas.link.followPage'; vars: { page: number } }
  | { key: 'canvas.link.followNamed'; vars: { name: string } }
  | { key: 'canvas.link.followWeb'; vars: { url: string } }
  | { key: 'canvas.link.followFile'; vars: { file: string } }
  | { key: 'app.link.title'; vars: Record<string, never> } {
  switch (target?.kind) {
    case 'goto':
      if (target.page != null) return { key: 'canvas.link.followPage', vars: { page: target.page } };
      break;
    case 'named':
      if (target.name) return { key: 'canvas.link.followNamed', vars: { name: target.name } };
      break;
    case 'uri':
      if (target.url?.trim()) return { key: 'canvas.link.followWeb', vars: { url: target.url.trim() } };
      break;
    case 'file':
    case 'launch':
      if (target.path?.trim()) return { key: 'canvas.link.followFile', vars: { file: target.path.trim() } };
      break;
    default:
      break;
  }
  return { key: 'app.link.title', vars: {} };
}
