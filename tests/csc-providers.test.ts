// Remote signing service provider configuration (lib/csc-providers.ts).
//
// What is under test is the STORAGE BOUNDARY: which parts of a provider
// configuration are written to disk and which never are, and the rule that a
// remembered credential is an offer rather than an action. Both are security
// properties with no visible symptom when they break — a persisted secret
// looks exactly like a working application — so they are pinned here rather
// than left to a component with no test environment.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE,
  forgetSecrets,
  loadProviders,
  makePkce,
  newProviderId,
  preselectedCredential,
  providerProblem,
  rememberCredential,
  rememberSecret,
  removeProvider,
  saveProviders,
  secretFor,
  upsertProvider,
  type CscCredentialRow,
  type CscProvider,
} from '../src/renderer/lib/csc-providers';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

beforeEach(() => {
  store.clear();
  forgetSecrets();
});

function provider(overrides: Partial<CscProvider> = {}): CscProvider {
  return {
    id: 'p1',
    name: 'Example CA',
    url: 'https://signing.example/csc/v2',
    clientId: 'the-client',
    scope: DEFAULT_SCOPE,
    grant: 'client-credentials',
    caBundle: null,
    ...overrides,
  };
}

function credential(overrides: Partial<CscCredentialRow> = {}): CscCredentialRow {
  return {
    credential_id: 'cred-1',
    subject: 'CN=Jane',
    auth_mode: 'oauth2code',
    key_algorithms: [],
    key_length: 2048,
    key_curve: null,
    key_status: 'enabled',
    certificate_status: 'valid',
    usable: true,
    unusable_reason: null,
    ...overrides,
  };
}

describe('provider storage', () => {
  it('round-trips a configured provider', () => {
    saveProviders([provider()]);
    expect(loadProviders()).toEqual([provider()]);
  });

  it('never writes the client secret', () => {
    saveProviders([provider()]);
    rememberSecret('p1', 'the-client-secret');
    // The whole storage, not just this module's key: a secret leaking into
    // ANY persisted value is the failure, wherever it lands.
    const persisted = [...store.values()].join('\n');
    expect(persisted).not.toContain('the-client-secret');
    // It is still usable in this window.
    expect(secretFor('p1')).toBe('the-client-secret');
  });

  it('drops a secret when the provider is forgotten', () => {
    rememberSecret('p1', 'shh');
    rememberSecret('p1', '');
    expect(secretFor('p1')).toBe('');
  });

  it('drops a stored row it cannot read rather than repairing it', () => {
    // A provider address is where a signing credential is sent, so a row this
    // build cannot understand is discarded rather than guessed into shape.
    store.set(
      'spectra-csc-providers',
      JSON.stringify([provider(), { id: 'x', url: 'https://y' }, { grant: 'implicit' }]),
    );
    expect(loadProviders()).toEqual([provider()]);
  });

  it('survives a corrupt payload', () => {
    store.set('spectra-csc-providers', 'not json at all');
    expect(loadProviders()).toEqual([]);
  });

  it('upserts in place and removes by id', () => {
    const rows = upsertProvider([provider()], provider({ name: 'Renamed' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed');
    expect(upsertProvider(rows, provider({ id: 'p2' }))).toHaveLength(2);
    expect(removeProvider(rows, 'p1')).toEqual([]);
  });

  it('mints distinct provider ids', () => {
    expect(newProviderId()).not.toBe(newProviderId());
  });
});

describe('provider validation', () => {
  it('accepts a complete https provider', () => {
    expect(providerProblem(provider())).toBeNull();
  });

  it('names each missing piece', () => {
    expect(providerProblem(provider({ url: '' }))).toBe('dialog.signer.cscNeedUrl');
    expect(providerProblem(provider({ url: 'http://signing.example/csc/v2' }))).toBe(
      'dialog.signer.cscNeedHttps',
    );
    expect(providerProblem(provider({ clientId: '  ' }))).toBe(
      'dialog.signer.cscNeedClientId',
    );
  });
});

describe('the remembered credential', () => {
  it('pre-selects one the provider still offers', () => {
    rememberCredential('p1', 'cred-1');
    expect(preselectedCredential('p1', [credential()])).toBe('cred-1');
  });

  it('does not pre-select one the provider no longer enumerates', () => {
    rememberCredential('p1', 'cred-1');
    expect(preselectedCredential('p1', [credential({ credential_id: 'cred-2' })])).toBeNull();
  });

  it('does not pre-select one the provider now reports unusable', () => {
    // A revoked credential sitting selected in the form is a signature that
    // fails at the provider; offering it back is worse than offering nothing.
    rememberCredential('p1', 'cred-1');
    expect(
      preselectedCredential('p1', [
        credential({ usable: false, unusable_reason: 'revoked' }),
      ]),
    ).toBeNull();
  });

  it('does not cross providers', () => {
    rememberCredential('p1', 'cred-1');
    expect(preselectedCredential('p2', [credential()])).toBeNull();
  });

  it('survives a corrupt payload', () => {
    store.set('spectra-csc-credential', '{');
    expect(preselectedCredential('p1', [credential()])).toBeNull();
  });
});

describe('PKCE', () => {
  it('produces a fresh S256 challenge and state each time', async () => {
    const a = await makePkce();
    const b = await makePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    // base64url: no padding and none of the three characters base64 uses that
    // a query string would have to escape.
    for (const value of [a.verifier, a.challenge, a.state]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // SHA-256 in base64url is 43 characters.
    expect(a.challenge).toHaveLength(43);
  });

  it('derives the challenge from the verifier it returns', async () => {
    const pair = await makePkce();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(pair.verifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pair.challenge).toBe(expected);
  });
});
