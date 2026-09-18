// Which certificate source the signing form offers, in what order, and what
// it does when the platform store has nothing to give.
//
// Installed Windows certificates are the PRIMARY source: they are enumerated
// when the form opens and offered for selection directly, and the file, token
// and service sources sit behind one disclosure as the advanced choices. That
// ordering is a fact about the product, not about a component, so it lives
// here where it can be read and tested.
//
// The rule the store source established holds: a remembered choice is an
// OFFER, never an action. A remembered thumbprint pre-selects only while the
// store still enumerates it, so a certificate that expired or was removed
// cannot sit selected in a form.
//
// Pure over its inputs — there is no DOM test environment, which is why none
// of this lives in the component.

import type { StoreCertificate } from './tauri-bridge';

export type SignerSourceMode = 'store' | 'pfx' | 'pem' | 'pkcs11' | 'csc';

/**
 * One chosen certificate source and whatever has been configured for it.
 *
 * Lives here rather than in the component so the decisions below can be taken
 * over a real source rather than over a mode alone.
 */
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

/** The sources that need a file, a device or a service registration. Order is
 * the order the picker renders them in. */
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
 * Exhaustive over `SignerSourceMode`, which is what ties the ordered list the
 * picker renders to the shapes the sign request can be assembled from — a
 * mode with no case here does not compile. */
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
 * The caller's state outlives one opening of the form, so a fallback taken
 * because the store was unavailable would otherwise outlive the form that took
 * it — and a store that has since recovered would never be offered again. An
 * UNCONFIGURED source carries no work to lose, so it returns to the primary
 * one on every open; a source with a file, a label or a credential in it is
 * the user's and is kept.
 */
export function sourceOnOpen(source: SignerSource): SignerSourceMode {
  return sourceIsUnconfigured(source) ? PRIMARY_SIGNER_SOURCE : source.mode;
}

/**
 * What the store enumeration has produced so far.
 *
 * `error` and `empty` are different findings and are reported differently: a
 * store that refused says why, a store that opened and holds no signer says
 * so. Neither is allowed to render as a blank picker.
 */
export type StoreAvailability = 'loading' | 'offer' | 'empty' | 'error';

export function storeAvailability(state: {
  busy: boolean;
  rows: readonly StoreCertificate[] | null;
  error: string | null;
}): StoreAvailability {
  if (state.error) return 'error';
  if (state.busy || state.rows === null) return 'loading';
  return state.rows.length > 0 ? 'offer' : 'empty';
}

/**
 * The source the form should hold once the store enumeration has answered.
 *
 * A store that refused, or that holds no signer, leaves the primary source
 * with nothing to choose from, so the selection moves to the first advanced
 * source instead of parking the user on an empty picker. The store's own
 * message does NOT travel with the selection — it is rendered on the store
 * row whatever is selected, which is the only way the reason for this move
 * survives it.
 *
 * Never fires over a choice the user made: a source they picked themselves is
 * theirs even if the answer arrives afterwards, and a store selection that
 * already names a certificate is a choice too.
 */
export function sourceAfterStoreRead(state: {
  mode: SignerSourceMode;
  /** A thumbprint the store STILL OFFERS. One it no longer enumerates is not
   * a selection — it is a certificate that expired or was removed, and
   * counting it as one would park the user on a store that cannot serve. */
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
 * The remembered certificate, if the store still offers it.
 *
 * Null for a thumbprint the store no longer enumerates, and null for no
 * remembered thumbprint at all — there is deliberately no fallback to "the
 * first row", because a pre-selection the user never made is a selection they
 * did not make.
 */
export function rememberedCertificate(
  options: readonly SignerCertificateOption[],
  remembered: string | null,
): SignerCertificateOption | null {
  if (!remembered) return null;
  return options.find((o) => o.thumbprint === remembered) ?? null;
}
