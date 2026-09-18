// Certificate-source ordering and store availability (lib/signer-sources.ts).
//
// Under test: installed Windows certificates are the first source offered,
// a usable source is never hidden when the primary one cannot serve, and the
// store selection the request is built from is always one the store offers.
// Each of these fails with no visible symptom, which is why they are pinned
// here rather than left to a component with no test environment.
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SIGNER_SOURCES,
  PRIMARY_SIGNER_SOURCE,
  SIGNER_SOURCE_ORDER,
  emptySourceFor,
  rememberedCertificate,
  signerCertificateOptions,
  sourceAfterStoreRead,
  sourceIsUnconfigured,
  sourceOnOpen,
  storeAvailability,
  storeSelectionAfterRead,
  classifyStoreFailure,
  type SignerSource,
  type StoreAvailability,
} from '../src/renderer/lib/signer-sources';
import type { StoreCertificate } from '../src/renderer/lib/tauri-bridge';

function cert(over: Partial<StoreCertificate> = {}): StoreCertificate {
  return {
    thumbprint: 'AA'.repeat(20),
    subject: 'Signer',
    issuer: 'Issuer',
    not_after: '2030-01-01T00:00:00Z',
    eku: [],
    hardware_backed: false,
    machine_store: false,
    ...over,
  };
}

describe('the order the sources are offered in', () => {
  it('puts the installed-certificate source first', () => {
    expect(PRIMARY_SIGNER_SOURCE).toBe('store');
    expect(SIGNER_SOURCE_ORDER[0]).toBe('store');
  });

  it('offers every source exactly once', () => {
    expect(SIGNER_SOURCE_ORDER).toEqual(['store', 'pfx', 'pem', 'pkcs11', 'csc']);
    expect(new Set(SIGNER_SOURCE_ORDER).size).toBe(SIGNER_SOURCE_ORDER.length);
  });

  it('keeps the primary source out of the advanced list', () => {
    expect(ADVANCED_SIGNER_SOURCES).not.toContain(PRIMARY_SIGNER_SOURCE);
    expect([PRIMARY_SIGNER_SOURCE, ...ADVANCED_SIGNER_SOURCES]).toEqual(SIGNER_SOURCE_ORDER);
  });
});

describe('what the store enumeration has produced', () => {
  it('reads as loading until the first answer lands', () => {
    expect(storeAvailability({ busy: true, rows: null, failed: false })).toBe('loading');
    expect(storeAvailability({ busy: false, rows: null, failed: false })).toBe('loading');
    expect(storeAvailability({ busy: true, rows: [], failed: false })).toBe('loading');
  });

  it('separates a store that refused from a store that holds no signer', () => {
    expect(storeAvailability({ busy: false, rows: [], failed: true })).toBe('error');
    expect(storeAvailability({ busy: false, rows: [], failed: false })).toBe('empty');
  });

  it('reports an offer once there is a row to offer', () => {
    expect(storeAvailability({ busy: false, rows: [cert()], failed: false })).toBe('offer');
  });

  it('returns to a wait while a Refresh re-reads, since the read clears the failure first', () => {
    // The reachable sequence: a failed read leaves rows=[] and a failure, then
    // Refresh sets busy and clears the failure in the same commit.
    expect(storeAvailability({ busy: false, rows: [], failed: true })).toBe('error');
    expect(storeAvailability({ busy: true, rows: [], failed: false })).toBe('loading');
  });
});

describe('naming the store\u2019s refusal', () => {
  it('names an access refusal by its HRESULT, not by the platform\u2019s wording', () => {
    expect(
      classifyStoreFailure({ reason: 'open-failed', code: '0x80070005', message: 'Zugriff verweigert' }),
    ).toEqual({ kind: 'denied', code: '0x80070005' });
  });

  it('names a missing personal store by any of its codes', () => {
    for (const code of ['0x80070002', '0x80070003', '0x80092004']) {
      expect(classifyStoreFailure({ reason: 'open-failed', code, message: '' })).toEqual({
        kind: 'missing',
        code,
      });
    }
  });

  it('normalizes the spelling of a code before matching it', () => {
    expect(classifyStoreFailure({ reason: 'open-failed', code: '0X80070005' })).toEqual({
      kind: 'denied',
      code: '0x80070005',
    });
    expect(classifyStoreFailure({ reason: 'open-failed', code: '0x5' })).toEqual({
      kind: 'code',
      code: '0x00000005',
    });
  });

  it('carries an unmapped code into the generic message', () => {
    expect(classifyStoreFailure({ reason: 'open-failed', code: '0x80090016' })).toEqual({
      kind: 'code',
      code: '0x80090016',
    });
  });

  it('reports a platform with no store as unsupported', () => {
    expect(classifyStoreFailure({ reason: 'unsupported', code: null })).toEqual({
      kind: 'unsupported',
    });
  });

  it('falls back to the generic sentence for anything unstructured', () => {
    // An IPC failure rejects with plain text; an Error has no fields to read.
    for (const e of ['Command list_store_certificates not found', new Error('x'), null, undefined, {}]) {
      expect(classifyStoreFailure(e)).toEqual({ kind: 'unknown' });
    }
    expect(classifyStoreFailure({ reason: 'open-failed', code: 'not-a-code' })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('the source a freshly opened form holds', () => {
  const configured: SignerSource[] = [
    { mode: 'pfx', pfxPath: 'C:\\signers\\me.pfx' },
    { mode: 'pem', keyPath: 'C:\\k.pem', certPath: null },
    { mode: 'pem', keyPath: null, certPath: 'C:\\c.pem' },
    { mode: 'pkcs11', modulePath: 'C:\\p11.dll', tokenLabel: '', certLabel: '', keyLabel: '' },
    { mode: 'pkcs11', modulePath: null, tokenLabel: '', certLabel: 'Signing', keyLabel: '' },
    { mode: 'store', thumbprint: 'AA'.repeat(20), machineStore: false },
    { mode: 'csc', providerId: 'p1', credentialId: null, authorization: null },
  ];

  it('returns to the installed certificates when nothing has been chosen yet', () => {
    // A fallback taken because the store was unavailable must not outlive the
    // form that took it — a recovered store would never be offered again.
    for (const mode of SIGNER_SOURCE_ORDER) {
      expect(sourceIsUnconfigured(emptySourceFor(mode))).toBe(true);
      expect(sourceOnOpen(emptySourceFor(mode))).toBe(PRIMARY_SIGNER_SOURCE);
    }
  });

  it('keeps a source that already holds a file, a label or a credential', () => {
    for (const source of configured) {
      expect(sourceIsUnconfigured(source)).toBe(false);
      expect(sourceOnOpen(source)).toBe(source.mode);
    }
  });

  it('counts whitespace-only token labels as nothing chosen', () => {
    expect(
      sourceIsUnconfigured({
        mode: 'pkcs11',
        modulePath: null,
        tokenLabel: '   ',
        certLabel: '',
        keyLabel: ' ',
      }),
    ).toBe(true);
  });
});

describe('falling back when the store cannot serve', () => {
  const after = (
    mode: Parameters<typeof sourceAfterStoreRead>[0]['mode'],
    thumbprint: string | null,
    userPicked: boolean,
    availability: StoreAvailability,
  ) => sourceAfterStoreRead({ mode, thumbprint, userPicked, availability });

  it('stays on the store while it is still being read', () => {
    expect(after('store', null, false, 'loading')).toBe('store');
  });

  it('stays on the store when it has certificates to offer', () => {
    expect(after('store', null, false, 'offer')).toBe('store');
  });

  it('moves to the first advanced source when the store refused or is empty', () => {
    expect(after('store', null, false, 'empty')).toBe(ADVANCED_SIGNER_SOURCES[0]);
    expect(after('store', null, false, 'error')).toBe(ADVANCED_SIGNER_SOURCES[0]);
  });

  it('never moves a source the user operated the chooser to reach', () => {
    // Including a deliberate return TO the store while the read was still in
    // flight: the answer must not yank them off a choice they just made.
    for (const mode of SIGNER_SOURCE_ORDER) {
      expect(after(mode, null, true, 'error')).toBe(mode);
      expect(after(mode, null, true, 'empty')).toBe(mode);
    }
  });

  it('never overrides a source the form is already on for another reason', () => {
    for (const mode of ADVANCED_SIGNER_SOURCES) {
      expect(after(mode, null, false, 'error')).toBe(mode);
      expect(after(mode, null, false, 'empty')).toBe(mode);
    }
  });

  it('never overrides a store selection that already names a certificate', () => {
    // A stale error beside a chosen certificate must not throw the choice
    // away — the request is assembled from what is selected.
    expect(after('store', 'AA'.repeat(20), false, 'error')).toBe('store');
  });
});

describe('the enumeration as a list to choose from', () => {
  it('puts the user’s own store before the machine store', () => {
    const options = signerCertificateOptions([
      cert({ thumbprint: 'M', subject: 'A machine signer', machine_store: true }),
      cert({ thumbprint: 'U', subject: 'Z user signer', machine_store: false }),
    ]);
    expect(options.map((o) => o.thumbprint)).toEqual(['U', 'M']);
  });

  it('sorts by the name the store shows, then by thumbprint', () => {
    const options = signerCertificateOptions([
      cert({ thumbprint: 'B2', subject: 'Same Name' }),
      cert({ thumbprint: 'A9', subject: 'Zed' }),
      cert({ thumbprint: 'B1', subject: 'Same Name' }),
    ]);
    expect(options.map((o) => o.thumbprint)).toEqual(['B1', 'B2', 'A9']);
  });

  it('drops a repeated thumbprint — one identity is one row', () => {
    const options = signerCertificateOptions([
      cert({ thumbprint: 'DUP', subject: 'User copy' }),
      cert({ thumbprint: 'DUP', subject: 'Machine copy', machine_store: true }),
    ]);
    expect(options).toHaveLength(1);
    expect(options[0].subject).toBe('User copy');
  });

  it('names a certificate with no subject by its thumbprint', () => {
    const [option] = signerCertificateOptions([cert({ thumbprint: 'BARE', subject: '', issuer: '' })]);
    expect(option.subject).toBe('BARE');
    expect(option.issuer).toBe('BARE');
  });

  it('skips a row the store could not identify at all', () => {
    expect(signerCertificateOptions([cert({ thumbprint: '' })])).toEqual([]);
  });

  it('carries the marks the picker annotates a row with', () => {
    const [option] = signerCertificateOptions([
      cert({ thumbprint: 'HW', hardware_backed: true, machine_store: true, not_after: '2031-06-05T00:00:00Z' }),
    ]);
    expect(option.hardwareBacked).toBe(true);
    expect(option.machineStore).toBe(true);
    expect(option.notAfter).toBe('2031-06-05T00:00:00Z');
  });
});

describe('the store selection after a read', () => {
  const options = signerCertificateOptions([
    cert({ thumbprint: 'USER', subject: 'User signer', machine_store: false }),
    cert({ thumbprint: 'MACH', subject: 'Machine signer', machine_store: true }),
  ]);
  const after = (thumbprint: string | null, machineStore: boolean, remembered: string | null) =>
    storeSelectionAfterRead({ selection: { thumbprint, machineStore }, options, remembered });

  it('leaves a live selection whose store location still matches', () => {
    expect(after('USER', false, null)).toBeNull();
    expect(after('MACH', true, 'USER')).toBeNull();
  });

  it('re-derives the store location of a live selection from the row just read', () => {
    // The request carries the location from this state: a certificate that
    // moved stores must be looked for where it now is.
    expect(after('MACH', false, null)).toEqual({ thumbprint: 'MACH', machineStore: true });
    expect(after('USER', true, null)).toEqual({ thumbprint: 'USER', machineStore: false });
  });

  it('replaces a stale selection with the remembered certificate when offered', () => {
    expect(after('GONE', false, 'MACH')).toEqual({ thumbprint: 'MACH', machineStore: true });
  });

  it('clears a stale selection when nothing remembered is offered', () => {
    expect(after('GONE', true, null)).toEqual({ thumbprint: null, machineStore: false });
    expect(after('GONE', true, 'ALSO-GONE')).toEqual({ thumbprint: null, machineStore: false });
  });

  it('offers the remembered certificate into an empty selection', () => {
    expect(after(null, false, 'USER')).toEqual({ thumbprint: 'USER', machineStore: false });
  });

  it('leaves an empty selection empty when nothing remembered is offered', () => {
    expect(after(null, false, null)).toBeNull();
    expect(after(null, false, 'GONE')).toBeNull();
  });

  it('clears a selection against an empty store', () => {
    expect(
      storeSelectionAfterRead({
        selection: { thumbprint: 'USER', machineStore: false },
        options: [],
        remembered: 'USER',
      }),
    ).toEqual({ thumbprint: null, machineStore: false });
  });
});

describe('the remembered certificate', () => {
  const options = signerCertificateOptions([
    cert({ thumbprint: 'KEEP', subject: 'Kept signer', machine_store: true }),
    cert({ thumbprint: 'OTHER', subject: 'Other signer' }),
  ]);

  it('pre-selects only while the store still offers it', () => {
    expect(rememberedCertificate(options, 'KEEP')?.thumbprint).toBe('KEEP');
    expect(rememberedCertificate(options, 'GONE')).toBeNull();
  });

  it('carries the store location back, so the request names the right store', () => {
    expect(rememberedCertificate(options, 'KEEP')?.machineStore).toBe(true);
  });

  it('never falls back to the first row', () => {
    expect(rememberedCertificate(options, null)).toBeNull();
    expect(rememberedCertificate(options, '')).toBeNull();
  });
});
