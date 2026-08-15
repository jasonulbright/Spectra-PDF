// The signature trust configuration: what is persisted, what reaches the
// engine, and what the aggregate readout says. Uses a localStorage stub since
// vitest runs in node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eutlProvenance,
  eutlUnavailable,
  hasTrustSource,
  loadTrustConfig,
  saveEutl,
  saveSystemStore,
  saveTrustAnchors,
  systemStoreUnavailable,
  trustSummary,
  trustVerifyParams,
  type TrustConfig,
} from '../src/renderer/lib/trust-store';
import type { SignatureEntry, VerifyResult } from '../src/renderer/lib/signatures';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

function sig(over: Partial<SignatureEntry> = {}): SignatureEntry {
  return {
    field: 'Signature1',
    signer: 'Someone',
    valid: true,
    intact: true,
    trusted: false,
    coverage: 'ENTIRE_FILE',
    covers_whole_document: true,
    modified_after_signing: false,
    digest_algorithm: 'sha256',
    signing_time: null,
    ...over,
  };
}

function result(signatures: SignatureEntry[], over: Partial<VerifyResult> = {}): VerifyResult {
  return {
    signed: signatures.length > 0,
    signature_count: signatures.length,
    signatures,
    summary: {
      all_valid: true,
      any_modified_after_signing: false,
      trust_verified: signatures.length > 0 && signatures.every((s) => s.trusted),
    },
    ...over,
  };
}

describe('trust configuration', () => {
  it('trusts nothing until the user configures a source', () => {
    const config = loadTrustConfig();
    expect(config.anchors).toEqual([]);
    expect(config.systemStore).toBe(false);
    expect(hasTrustSource(config)).toBe(false);
  });

  it('persists anchors and the store opt-in independently', () => {
    saveTrustAnchors(['C:/ca.pem']);
    expect(loadTrustConfig()).toEqual({ anchors: ['C:/ca.pem'], systemStore: false, eutl: false });
    saveSystemStore(true);
    expect(loadTrustConfig()).toEqual({ anchors: ['C:/ca.pem'], systemStore: true, eutl: false });
    saveTrustAnchors([]);
    expect(loadTrustConfig()).toEqual({ anchors: [], systemStore: true, eutl: false });
  });

  it('reads a corrupted anchor list as no anchors rather than throwing', () => {
    store.set('spectra.trustAnchors', '{not json');
    expect(loadTrustConfig().anchors).toEqual([]);
  });

  it('keeps only string entries out of a hand-edited anchor list', () => {
    store.set('spectra.trustAnchors', JSON.stringify(['C:/ca.pem', 7, null]));
    expect(loadTrustConfig().anchors).toEqual(['C:/ca.pem']);
  });

  it('reads any non-true stored value as off', () => {
    store.set('spectra.trustSystemStore', 'yes');
    expect(loadTrustConfig().systemStore).toBe(false);
    store.set('spectra.trustEutl', 'yes');
    expect(loadTrustConfig().eutl).toBe(false);
  });

  it('persists the trusted-list opt-in as its own source', () => {
    saveEutl(true);
    expect(loadTrustConfig()).toEqual({ anchors: [], systemStore: false, eutl: true });
    expect(hasTrustSource(loadTrustConfig())).toBe(true);
    saveSystemStore(true);
    expect(loadTrustConfig()).toEqual({ anchors: [], systemStore: true, eutl: true });
    saveEutl(false);
    expect(loadTrustConfig()).toEqual({ anchors: [], systemStore: true, eutl: false });
  });
});

describe('engine params', () => {
  it('sends NO system_trust key while the option is off', () => {
    // The engine's default path reads no certificate store at all; emitting
    // the key as false would still be a deliberate request.
    expect(trustVerifyParams({ anchors: [], systemStore: false, eutl: false })).toEqual({});
    expect(trustVerifyParams({ anchors: ['C:/ca.pem'], systemStore: false, eutl: false })).toEqual({
      trust_roots: ['C:/ca.pem'],
    });
  });

  it('sends the opt-in with or without anchors', () => {
    expect(trustVerifyParams({ anchors: [], systemStore: true, eutl: false })).toEqual({ system_trust: true });
    expect(trustVerifyParams({ anchors: ['C:/ca.pem'], systemStore: true, eutl: false })).toEqual({
      trust_roots: ['C:/ca.pem'],
      system_trust: true,
    });
  });

  it('sends each source separately, so one opt-in never implies another', () => {
    expect(trustVerifyParams({ anchors: [], systemStore: false, eutl: true })).toEqual({
      eutl_trust: true,
    });
    expect(trustVerifyParams({ anchors: ['C:/ca.pem'], systemStore: true, eutl: true })).toEqual({
      trust_roots: ['C:/ca.pem'],
      system_trust: true,
      eutl_trust: true,
    });
  });
});

describe('aggregate trust readout', () => {
  const anchorsOnly: TrustConfig = { anchors: ['C:/ca.pem'], systemStore: false, eutl: false };
  const storeOnly: TrustConfig = { anchors: [], systemStore: true, eutl: false };
  const both: TrustConfig = { anchors: ['C:/ca.pem'], systemStore: true, eutl: false };

  it('separates "no source configured" from "did not verify"', () => {
    const trusted = result([sig({ trusted: true, trust_source: 'user' })]);
    expect(trustSummary({ anchors: [], systemStore: false, eutl: false }, trusted)).toBe('none');
    expect(trustSummary(anchorsOnly, result([sig()]))).toBe('failed');
  });

  it('names the store when the store is what vouched', () => {
    expect(trustSummary(storeOnly, result([sig({ trusted: true, trust_source: 'system' })]))).toBe(
      'system',
    );
  });

  it('names both when different signatures reached different sources', () => {
    const r = result([
      sig({ field: 'A', trusted: true, trust_source: 'user' }),
      sig({ field: 'B', trusted: true, trust_source: 'system' }),
    ]);
    expect(trustSummary(both, r)).toBe('mixed');
  });

  it('falls back to the user wording for a trusted chain of unreported source', () => {
    expect(trustSummary(anchorsOnly, result([sig({ trusted: true })]))).toBe('user');
  });

  it('reports no result as unverified rather than trusted', () => {
    expect(trustSummary(storeOnly, null)).toBe('failed');
  });

  it('names the trusted lists when the bundle is what vouched', () => {
    const listsOnly: TrustConfig = { anchors: [], systemStore: false, eutl: true };
    expect(trustSummary(listsOnly, result([sig({ trusted: true, trust_source: 'eutl' })]))).toBe(
      'eutl',
    );
    const r = result([
      sig({ field: 'A', trusted: true, trust_source: 'eutl' }),
      sig({ field: 'B', trusted: true, trust_source: 'user' }),
    ]);
    expect(trustSummary({ anchors: ['C:/ca.pem'], systemStore: false, eutl: true }, r)).toBe(
      'mixed',
    );
  });
});

describe('store availability', () => {
  it('distinguishes an absent store from an unhelpful one', () => {
    const asked = result([sig()], {
      system_trust: { requested: true, available: false, anchor_count: 0 },
    });
    expect(systemStoreUnavailable(asked)).toBe(true);
    const empty = result([sig()], {
      system_trust: { requested: true, available: true, anchor_count: 0 },
    });
    expect(systemStoreUnavailable(empty)).toBe(false);
  });

  it('says nothing when the store was never asked for', () => {
    const r = result([sig()], {
      system_trust: { requested: false, available: false, anchor_count: 0 },
    });
    expect(systemStoreUnavailable(r)).toBe(false);
    expect(systemStoreUnavailable(result([sig()]))).toBe(false);
  });
});

describe('trusted-list bundle', () => {
  it('distinguishes an installation without a bundle from one that anchored nothing', () => {
    expect(
      eutlUnavailable(
        result([sig()], { eutl_trust: { requested: true, available: false, anchor_count: 0 } }),
      ),
    ).toBe(true);
    expect(
      eutlUnavailable(
        result([sig()], { eutl_trust: { requested: true, available: true, anchor_count: 0 } }),
      ),
    ).toBe(false);
    expect(
      eutlUnavailable(
        result([sig()], { eutl_trust: { requested: false, available: false, anchor_count: 0 } }),
      ),
    ).toBe(false);
  });

  it('shows provenance only when there is a date to show', () => {
    expect(
      eutlProvenance(
        result([sig()], {
          eutl_trust: {
            requested: true,
            available: true,
            anchor_count: 989,
            fetched: '2026-08-15',
            list_count: 31,
          },
        }),
      ),
    ).toEqual({ fetched: '2026-08-15', lists: 31, anchors: 989 });
    // Asked for but unreadable, and asked for but undated: nothing to state.
    expect(
      eutlProvenance(
        result([sig()], { eutl_trust: { requested: true, available: false, anchor_count: 0 } }),
      ),
    ).toBeNull();
    expect(
      eutlProvenance(
        result([sig()], {
          eutl_trust: { requested: true, available: true, anchor_count: 5, fetched: null },
        }),
      ),
    ).toBeNull();
    expect(eutlProvenance(result([sig()]))).toBeNull();
  });
});
