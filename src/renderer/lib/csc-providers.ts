// Remote signing service (Cloud Signature Consortium) provider configuration.
//
// WHAT IS PERSISTED AND WHAT IS NOT is the whole point of this module. A
// provider entry holds an address, the user's own OAuth client ID, a scope and
// a grant — public identifiers, the same class of thing as the store source's
// remembered thumbprint. The OAuth CLIENT SECRET is a credential, and this
// application persists no credential anywhere: it lives in memory for the life
// of the window and is asked for again in a new one. The access token never
// reaches this layer at all; the engine holds it for the life of its process.
//
// The rule the store source established holds here too: a remembered choice is
// an OFFER, never an action. A remembered credential pre-selects only while
// the provider still enumerates it, so a credential that was revoked or
// withdrawn cannot sit selected in a form.
//
// Pure over its storage, so every rule above is testable — there is no DOM
// test environment, which is why none of this lives in the component.

/** How the user's registration with a provider authenticates. Wire values,
 * never display text: the engine matches on them. */
export type CscGrant = 'client-credentials' | 'authorization-code';

export const CSC_GRANTS: readonly CscGrant[] = ['client-credentials', 'authorization-code'];

export interface CscProvider {
  /** Stable local identifier. Never sent anywhere — it names the row, and the
   * address can change without the row becoming a different provider. */
  id: string;
  /** The user's label for this provider. */
  name: string;
  /** The CSC API base address (HTTPS; the engine refuses anything else). */
  url: string;
  /** The user's OWN OAuth client registration with that provider. This
   * application ships none and holds no relationship with any provider. */
  clientId: string;
  scope: string;
  grant: CscGrant;
  /** A PEM bundle to trust for the provider's TLS certificate, for a provider
   * inside a private PKI. Null for the ordinary public case; verification is
   * never disabled either way. */
  caBundle: string | null;
}

const KEY = 'spectra-csc-providers';
const LAST_CREDENTIAL_KEY = 'spectra-csc-credential';

export const DEFAULT_SCOPE = 'service';

function isProvider(value: unknown): value is CscProvider {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    row.id !== '' &&
    typeof row.name === 'string' &&
    typeof row.url === 'string' &&
    typeof row.clientId === 'string' &&
    typeof row.scope === 'string' &&
    (row.grant === 'client-credentials' || row.grant === 'authorization-code') &&
    (row.caBundle === null || typeof row.caBundle === 'string')
  );
}

/** Every configured provider. A stored row this build cannot read is dropped
 * rather than repaired into something the user did not configure — a provider
 * address is where a signing credential is sent. */
export function loadProviders(): CscProvider[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProvider);
  } catch {
    return [];
  }
}

export function saveProviders(providers: CscProvider[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(providers));
  } catch {
    // A storage quota or a locked profile costs a convenience, never a sign.
  }
}

/** Upsert by id, preserving order and replacing in place. */
export function upsertProvider(
  providers: readonly CscProvider[],
  provider: CscProvider,
): CscProvider[] {
  const index = providers.findIndex((p) => p.id === provider.id);
  if (index < 0) return [...providers, provider];
  const next = [...providers];
  next[index] = provider;
  return next;
}

export function removeProvider(
  providers: readonly CscProvider[],
  id: string,
): CscProvider[] {
  return providers.filter((p) => p.id !== id);
}

export function newProviderId(): string {
  return `csc-${crypto.randomUUID()}`;
}

/** Whether this row can be used to reach a provider at all. Reported as a
 * catalog key, never as assembled text. */
export function providerProblem(provider: CscProvider): string | null {
  if (!provider.url.trim()) return 'dialog.signer.cscNeedUrl';
  if (!/^https:\/\//i.test(provider.url.trim())) return 'dialog.signer.cscNeedHttps';
  if (!provider.clientId.trim()) return 'dialog.signer.cscNeedClientId';
  return null;
}

// ── the client secret: memory only, for the life of this window ────────────

const secrets = new Map<string, string>();

export function rememberSecret(providerId: string, secret: string): void {
  if (secret) secrets.set(providerId, secret);
  else secrets.delete(providerId);
}

export function secretFor(providerId: string): string {
  return secrets.get(providerId) ?? '';
}

export function forgetSecrets(): void {
  secrets.clear();
}

// ── the last credential signed with ────────────────────────────────────────

interface LastCredential {
  providerId: string;
  credentialId: string;
}

export function rememberCredential(providerId: string, credentialId: string): void {
  try {
    localStorage.setItem(
      LAST_CREDENTIAL_KEY,
      JSON.stringify({ providerId, credentialId } satisfies LastCredential),
    );
  } catch {
    // See saveProviders.
  }
}

function lastCredential(): LastCredential | null {
  try {
    const raw = localStorage.getItem(LAST_CREDENTIAL_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.providerId !== 'string' || typeof row.credentialId !== 'string') return null;
    return { providerId: row.providerId, credentialId: row.credentialId };
  } catch {
    return null;
  }
}

/** One credential as the provider reports it. Mirrors the engine's row. */
export interface CscCredentialRow {
  credential_id: string;
  subject: string;
  auth_mode: string;
  key_algorithms: string[];
  key_length: number | null;
  key_curve: string | null;
  key_status: string;
  certificate_status: string;
  usable: boolean;
  unusable_reason: string | null;
}

/** The credential to pre-select, or null.
 *
 * Remembered ONLY while the provider still enumerates it AND still reports it
 * usable: a revoked credential sitting selected in the form is a signature
 * attempt that fails at the provider, and offering it back is worse than
 * offering nothing. */
export function preselectedCredential(
  providerId: string,
  rows: readonly CscCredentialRow[],
): string | null {
  const last = lastCredential();
  if (!last || last.providerId !== providerId) return null;
  const match = rows.find((r) => r.credential_id === last.credentialId);
  return match && match.usable ? match.credential_id : null;
}

// ── the browser sign-in's PKCE material ────────────────────────────────────

export interface PkcePair {
  /** Held by this window and sent to the engine, never to the listener. */
  verifier: string;
  /** Sent to the authorization server via the loopback listener. */
  challenge: string;
  /** The CSRF binding the listener checks the redirect against. */
  state: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** RFC 7636 PKCE, S256.
 *
 * Computed here because this is where WebCrypto is, and because it keeps the
 * verifier and the authorization code in different processes: the code arrives
 * through the loopback listener in the Rust side, the verifier goes straight
 * from this window to the engine, and only the token request ever holds both.
 *
 * `plain` is deliberately not offered. RFC 7636 §4.2 allows it only for a
 * client that cannot do S256, and this one can. */
export async function makePkce(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    state: randomToken(16),
  };
}
