// Which certificate source the signing form offers, in what order, and what
// it holds when the platform store has nothing to give.
//
// Installed Windows certificates are the PRIMARY source: they are enumerated
// when the form opens and offered for selection directly. The file, token and
// service sources follow under their own heading.
//
// A remembered choice is an OFFER, never an action. A remembered thumbprint
// pre-selects only while the store still enumerates it, so a certificate that
// expired or was removed cannot sit selected in a form.
//
// Pure over its inputs: there is no DOM test environment, so every decision
// the picker takes lives here where it can be tested.

import type { StoreCertificate } from './tauri-bridge';

export type SignerSourceMode = 'store' | 'pfx' | 'pem' | 'pkcs11' | 'csc';

/** One chosen certificate source and whatever has been configured for it. */
export type SignerSource =
  | { mode: 'pfx'; pfxPath: string | null }
  | { mode: 'pem'; keyPath: string | null; certPath: string | null }
  | {
      mode: 'pkcs11';
      modulePath: string | null;
      tokenLabel: string;
      certLabel: string;
      keyLabel: string;
    }
  | { mode: 'store'; thumbprint: string | null; machineStore: boolean }
  | {
      mode: 'csc';
      providerId: string | null;
      credentialId: string | null;
      /** The completed browser sign-in, for an authorization-code provider.
       * Null on a client-credentials one, which needs no person. */
      authorization: { code: string; redirectUri: string; verifier: string } | null;
    };

/** The installed-certificate source, offered first and selected by default. */
export const PRIMARY_SIGNER_SOURCE: SignerSourceMode = 'store';

/** The sources that need a file, a device or a service registration, in the
 * order the picker renders them. */
export const ADVANCED_SIGNER_SOURCES: readonly SignerSourceMode[] = [
  'pfx',
  'pem',
  'pkcs11',
  'csc',
];

export const SIGNER_SOURCE_ORDER: readonly SignerSourceMode[] = [
  PRIMARY_SIGNER_SOURCE,
  ...ADVANCED_SIGNER_SOURCES,
];

/** A fresh, empty source of one mode.
 *
 * Exhaustive over `SignerSourceMode`: a mode added to the picker's list with
 * no shape here does not compile. */
export function emptySourceFor(mode: SignerSourceMode): SignerSource {
  switch (mode) {
    case 'store':
      return { mode: 'store', thumbprint: null, machineStore: false };
    case 'pfx':
      return { mode: 'pfx', pfxPath: null };
    case 'pem':
      return { mode: 'pem', keyPath: null, certPath: null };
    case 'pkcs11':
      return { mode: 'pkcs11', modulePath: null, tokenLabel: '', certLabel: '', keyLabel: '' };
    case 'csc':
      return { mode: 'csc', providerId: null, credentialId: null, authorization: null };
  }
}

/** Whether nothing has been chosen or typed for this source yet. */
export function sourceIsUnconfigured(source: SignerSource): boolean {
  switch (source.mode) {
    case 'store':
      return !source.thumbprint;
    case 'pfx':
      return !source.pfxPath;
    case 'pem':
      return !source.keyPath && !source.certPath;
    case 'pkcs11':
      return (
        !source.modulePath
        && !source.tokenLabel.trim()
        && !source.certLabel.trim()
        && !source.keyLabel.trim()
      );
    case 'csc':
      return !source.providerId && !source.credentialId && !source.authorization;
  }
}

/**
 * The source a freshly opened signing form should hold.
 *
 * The caller's state outlives one opening of the form. An UNCONFIGURED source
 * carries no work to lose, so it returns to the primary one on every open —
 * otherwise a fallback taken while the store was unavailable would outlive
 * the form that took it, and a recovered store would never be offered again.
 * A source with a file, a label or a credential in it is the user's and is
 * kept.
 */
export function sourceOnOpen(source: SignerSource): SignerSourceMode {
  return sourceIsUnconfigured(source) ? PRIMARY_SIGNER_SOURCE : source.mode;
}

/**
 * What the store enumeration has produced so far.
 *
 * `error` and `empty` are different findings and are reported differently: a
 * store that refused says why, a store that opened and holds no signer says
 * so. Neither may render as a blank picker.
 */
export type StoreAvailability = 'loading' | 'offer' | 'empty' | 'error';

export function storeAvailability(state: {
  busy: boolean;
  rows: readonly StoreCertificate[] | null;
  failed: boolean;
}): StoreAvailability {
  if (state.failed) return 'error';
  if (state.busy || state.rows === null) return 'loading';
  return state.rows.length > 0 ? 'offer' : 'empty';
}

/**
 * Why the store could not be listed, as the picker words it.
 *
 * Classified from structured fields only. The platform's own error text is
 * localized by the OS rather than by this app, so matching on it would break
 * in every other Windows language.
 */
export type StoreReadFailure =
  | { kind: 'denied'; code: string }
  | { kind: 'missing'; code: string }
  | { kind: 'unsupported' }
  | { kind: 'code'; code: string }
  | { kind: 'unknown' };

/** E_ACCESSDENIED. */
const DENIED_CODES: ReadonlySet<string> = new Set(['0x80070005']);
/** ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND and CRYPT_E_NOT_FOUND: the
 * account has no personal store to open. */
const MISSING_CODES: ReadonlySet<string> = new Set(['0x80070002', '0x80070003', '0x80092004']);

/** An HRESULT normalized to `0x` and eight uppercase hex digits, or null when
 * the value is not one. */
function normalizeHresult(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const m = /^0x([0-9a-f]{1,8})$/i.exec(code.trim());
  return m ? `0x${m[1].toUpperCase().padStart(8, '0')}` : null;
}

export function classifyStoreFailure(e: unknown): StoreReadFailure {
  if (typeof e === 'object' && e !== null && 'reason' in e) {
    const { reason, code } = e as { reason?: unknown; code?: unknown };
    if (reason === 'unsupported') return { kind: 'unsupported' };
    const hresult = normalizeHresult(code);
    if (hresult) {
      if (DENIED_CODES.has(hresult)) return { kind: 'denied', code: hresult };
      if (MISSING_CODES.has(hresult)) return { kind: 'missing', code: hresult };
      return { kind: 'code', code: hresult };
    }
  }
  // An IPC failure, or a refusal with no code: nothing structured to name.
  return { kind: 'unknown' };
}

/**
 * The source the form should hold once the store enumeration has answered.
 *
 * A store that refused, or that holds no signer, leaves the primary source
 * with nothing to choose from, so the selection moves to the first advanced
 * source instead of parking the user on an empty picker. The caller renders
 * the store's verdict on the store row whatever is selected; a verdict gated
 * on the selection would unmount in the commit that moved it.
 *
 * Never fires over a choice the user made: a source they picked themselves is
 * theirs even if the answer arrives afterwards, and a store selection that
 * names a certificate the store still offers is a choice too.
 */
export function sourceAfterStoreRead(state: {
  mode: SignerSourceMode;
  /** A thumbprint the store STILL OFFERS, or null. One it no longer
   * enumerates is not a selection, and counting it as one would park the
   * user on a store that cannot serve. */
  thumbprint: string | null;
  /** The user has operated the source chooser at least once. */
  userPicked: boolean;
  availability: StoreAvailability;
}): SignerSourceMode {
  if (state.userPicked) return state.mode;
  if (state.mode !== PRIMARY_SIGNER_SOURCE) return state.mode;
  if (state.thumbprint) return state.mode;
  if (state.availability === 'empty' || state.availability === 'error') {
    return ADVANCED_SIGNER_SOURCES[0];
  }
  return state.mode;
}

/** One certificate as the picker lists it. */
export interface SignerCertificateOption {
  thumbprint: string;
  subject: string;
  issuer: string;
  notAfter: string;
  hardwareBacked: boolean;
  machineStore: boolean;
}

/**
 * The enumeration as an ordered, duplicate-free list of options.
 *
 * The user's own store comes before the machine store — a key the account can
 * reach is the likelier choice — and within each, rows sort by the name the
 * store shows, then by thumbprint so two identically named certificates keep a
 * stable order between reads. A row with neither a subject nor an issuer is
 * named by its thumbprint; an unnamed option cannot be chosen from.
 */
export function signerCertificateOptions(
  rows: readonly StoreCertificate[],
): SignerCertificateOption[] {
  const seen = new Set<string>();
  const options: SignerCertificateOption[] = [];
  for (const row of rows) {
    if (!row.thumbprint || seen.has(row.thumbprint)) continue;
    seen.add(row.thumbprint);
    options.push({
      thumbprint: row.thumbprint,
      subject: row.subject || row.thumbprint,
      issuer: row.issuer || row.thumbprint,
      notAfter: row.not_after,
      hardwareBacked: row.hardware_backed,
      machineStore: row.machine_store,
    });
  }
  options.sort((a, b) => {
    if (a.machineStore !== b.machineStore) return a.machineStore ? 1 : -1;
    const bySubject = a.subject.localeCompare(b.subject, 'en');
    if (bySubject !== 0) return bySubject;
    return a.thumbprint.localeCompare(b.thumbprint, 'en');
  });
  return options;
}

/**
 * The option for a thumbprint, if the store still offers it.
 *
 * Null for a thumbprint the store no longer enumerates, and null for no
 * thumbprint at all — there is deliberately no fallback to "the first row",
 * because a pre-selection the user never made is a selection they did not
 * make.
 */
export function rememberedCertificate(
  options: readonly SignerCertificateOption[],
  remembered: string | null,
): SignerCertificateOption | null {
  if (!remembered) return null;
  return options.find((o) => o.thumbprint === remembered) ?? null;
}

/** A store selection: which certificate, and in which store location. */
export interface StoreSelection {
  thumbprint: string | null;
  machineStore: boolean;
}

/**
 * The store selection once a read has answered, or null to leave it as it is.
 *
 * - A selection the store still offers stands, but its store location is
 *   re-derived from the row just read: the request is built from this state,
 *   and a certificate that moved between the user and machine stores would
 *   otherwise be looked for where it no longer is.
 * - A selection the store no longer offers is not a selection. It resolves
 *   to the remembered certificate if that is offered, otherwise to none.
 * - With nothing selected, the remembered certificate is offered if the store
 *   still has it. A selection the user cleared is not re-filled here: the
 *   caller runs this on entering the source and on each read, never on the
 *   selection changing.
 */
export function storeSelectionAfterRead(state: {
  selection: StoreSelection;
  options: readonly SignerCertificateOption[];
  remembered: string | null;
}): StoreSelection | null {
  const { selection, options } = state;
  if (selection.thumbprint !== null) {
    const live = rememberedCertificate(options, selection.thumbprint);
    if (live) {
      return live.machineStore === selection.machineStore
        ? null
        : { thumbprint: live.thumbprint, machineStore: live.machineStore };
    }
  }
  const remembered = rememberedCertificate(options, state.remembered);
  if (remembered) {
    return { thumbprint: remembered.thumbprint, machineStore: remembered.machineStore };
  }
  return selection.thumbprint !== null ? { thumbprint: null, machineStore: false } : null;
}
