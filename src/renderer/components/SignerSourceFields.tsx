import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useTranslation } from 'react-i18next';
import { dialog, type StoreCertificate } from '../lib/tauri-bridge';
import { tChrome, tDate, type UiKey } from '../i18n';
import {
  ADVANCED_SIGNER_SOURCES,
  PRIMARY_SIGNER_SOURCE,
  emptySourceFor,
  rememberedCertificate,
  signerCertificateOptions,
  sourceAfterStoreRead,
  sourceOnOpen,
  storeAvailability,
  type SignerSource,
  type SignerSourceMode,
} from '../lib/signer-sources';
import {
  CSC_GRANTS,
  DEFAULT_SCOPE,
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
  type CscGrant,
  type CscProvider,
} from '../lib/csc-providers';

// The signer source both sign flows (SignaturesPanel invisible form, canvas
// visible-signature popover) share: a certificate installed in the Windows
// certificate store, a PKCS#12 file, a PEM key+cert pair, a PKCS#11 hardware
// token, a remote signing service, or a freshly generated self-signed .pfx
// (which becomes the selected .pfx). The installed certificates are the
// PRIMARY source and are enumerated as the form opens; the rest are offered
// under their own heading below.
//
// LAYOUT: each source is a full-width row whose label WRAPS. A single row of
// side-by-side source buttons does not fit either surface — the tool dock at
// its 300px minimum leaves the group about 70px, the canvas card about 110px,
// and against `overflow-hidden` a flex item resolves `min-width` to 0, so the
// last sources were clipped away with no affordance that they existed.
// SECURITY: this component never holds the SIGNING password or token PIN —
// only the generator sub-form's own password, which is cleared the moment
// generation finishes (the user then types it again as the signing
// password/PIN; a generated signer is prompted for like any other, never
// cached). For a token the sign form's password field IS the PIN. The store
// source has no secret here at all: Windows collects any PIN itself, inside
// the engine's sign call, and only a thumbprint ever leaves this component.

export type { SignerSource };

/** Engine params for one signer source. Booleans ride as booleans — the
 * engine's store-location flag is one, and a stringified "false" would read
 * as true. */
export type SignerParams = Record<string, string | boolean>;

const SOURCE_LABEL_KEYS: Record<SignerSourceMode, UiKey> = {
  store: 'dialog.signer.modeStore',
  pfx: 'dialog.signer.modePfx',
  pem: 'dialog.signer.modePem',
  pkcs11: 'dialog.signer.modeToken',
  csc: 'dialog.signer.modeCsc',
};

export const EMPTY_SIGNER_SOURCE: SignerSource = emptySourceFor(PRIMARY_SIGNER_SOURCE);

/** The last store certificate signed with, so the picker can OFFER it again.
 * Pre-selection only — a remembered thumbprint never signs on its own, and a
 * thumbprint is a public identifier, not a secret. */
const LAST_STORE_CERT_KEY = 'spectra-signer-store-cert';

export function rememberStoreCertificate(thumbprint: string): void {
  try {
    localStorage.setItem(LAST_STORE_CERT_KEY, thumbprint);
  } catch {
    // A storage quota or a locked profile costs a convenience, never a sign.
  }
}

function lastStoreCertificate(): string | null {
  try {
    return localStorage.getItem(LAST_STORE_CERT_KEY);
  } catch {
    return null;
  }
}

/** Engine params for the chosen source, or null (with a message) when
 * incomplete. */
export function signerSourceParams(
  source: SignerSource,
): { params: SignerParams; error?: never } | { params?: never; error: string } {
  if (source.mode === 'pfx') {
    if (!source.pfxPath) return { error: tChrome('dialog.signer.needPfx') };
    return { params: { pfx_path: source.pfxPath } };
  }
  if (source.mode === 'csc') {
    const provider = loadProviders().find((p) => p.id === source.providerId);
    if (!provider) return { error: tChrome('dialog.signer.cscNeedProvider') };
    const problem = providerProblem(provider);
    if (problem) return { error: tChrome(problem as 'dialog.signer.cscNeedUrl') };
    if (!source.credentialId) return { error: tChrome('dialog.signer.cscNeedCredential') };
    const params: SignerParams = {
      csc_url: provider.url.trim(),
      csc_credential: source.credentialId,
      csc_client_id: provider.clientId.trim(),
      csc_scope: provider.scope || DEFAULT_SCOPE,
      csc_grant: provider.grant,
    };
    // The secret lives in memory only; an empty one is simply omitted rather
    // than sent as a registration that has none.
    const secret = secretFor(provider.id);
    if (secret) params.csc_client_secret = secret;
    if (provider.caBundle) params.csc_ca_bundle = provider.caBundle;
    if (provider.grant === 'authorization-code') {
      if (!source.authorization) return { error: tChrome('dialog.signer.cscNeedSignIn') };
      params.csc_code = source.authorization.code;
      params.csc_redirect_uri = source.authorization.redirectUri;
      params.csc_verifier = source.authorization.verifier;
    }
    return { params };
  }
  if (source.mode === 'store') {
    if (!source.thumbprint) return { error: tChrome('dialog.signer.needStoreCert') };
    const params: SignerParams = { store_cert: source.thumbprint };
    if (source.machineStore) params.store_machine = true;
    return { params };
  }
  if (source.mode === 'pkcs11') {
    if (!source.modulePath) return { error: tChrome('dialog.signer.needModule') };
    if (!source.tokenLabel.trim()) return { error: tChrome('dialog.signer.needToken') };
    if (!source.certLabel.trim()) return { error: tChrome('dialog.signer.needCertLabel') };
    const params: Record<string, string> = {
      pkcs11_module: source.modulePath,
      pkcs11_token: source.tokenLabel.trim(),
      pkcs11_cert_label: source.certLabel.trim(),
    };
    if (source.keyLabel.trim()) params.pkcs11_key_label = source.keyLabel.trim();
    return { params };
  }
  if (!source.keyPath || !source.certPath)
    return { error: tChrome('dialog.signer.needPem') };
  return { params: { key_path: source.keyPath, cert_path: source.certPath } };
}

interface GenerateResult {
  output: string;
  common_name: string;
  not_after: string;
  fingerprint_sha256: string;
}

export function SignerSourceFields({
  value,
  onChange,
  idPrefix,
}: {
  value: SignerSource;
  onChange: (next: SignerSource) => void;
  /** Distinguishes testids when two forms exist (panel vs canvas). */
  idPrefix: string;
}): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call } = useEngine();
  const [showGenerate, setShowGenerate] = useState(false);
  const [genName, setGenName] = useState('');
  const [genOrg, setGenOrg] = useState('');
  const [genPassword, setGenPassword] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genDone, setGenDone] = useState<GenerateResult | null>(null);
  const [storeCerts, setStoreCerts] = useState<StoreCertificate[] | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

  const inStoreMode = value.mode === 'store';
  const storeThumbprint = value.mode === 'store' ? value.thumbprint : null;
  /** The user has operated the source chooser. A late store answer never
   * moves a selection they made themselves. */
  const userPicked = useRef(false);
  /** The picker's own subtree, for finding a source radio without reaching
   * into the other surface's copy of this form. */
  const rootRef = useRef<HTMLDivElement>(null);

  const loadStoreCerts = useCallback(async () => {
    setStoreBusy(true);
    setStoreError(null);
    try {
      const rows = await dialog.listStoreCertificates();
      setStoreCerts(rows);
      return rows;
    } catch (e: unknown) {
      setStoreCerts([]);
      setStoreError(e instanceof Error ? e.message : String(e));
      return [];
    } finally {
      setStoreBusy(false);
    }
  }, []);

  const certOptions = useMemo(() => signerCertificateOptions(storeCerts ?? []), [storeCerts]);
  const availability = storeAvailability({ busy: storeBusy, rows: storeCerts, error: storeError });

  // Opening the form READS the store: installed certificates are the primary
  // source, so they are on offer before the user asks for them.
  useEffect(() => {
    void loadStoreCerts();
  }, [loadStoreCerts]);

  /** The selection, but only while the store still enumerates it. The caller's
   * state outlives one opening of the form, so a thumbprint chosen against an
   * earlier read can name a certificate that has since expired or been
   * removed. */
  const offeredThumbprint = rememberedCertificate(certOptions, storeThumbprint)?.thumbprint ?? null;

  // The remembered thumbprint is pre-selected ONLY while that certificate is
  // still one of the rows the store actually offers — a certificate that
  // expired or was removed must not sit selected in the form, and one carried
  // in from a previous opening is dropped for the same reason.
  useEffect(() => {
    if (!inStoreMode || availability === 'loading') return;
    const stale = storeThumbprint !== null && offeredThumbprint === null;
    // A live selection stands; only an absent or stale one is resolved.
    if (storeThumbprint !== null && !stale) return;
    const match = rememberedCertificate(certOptions, lastStoreCertificate());
    if (match) {
      onChange({ mode: 'store', thumbprint: match.thumbprint, machineStore: match.machineStore });
    } else if (stale) {
      onChange({ mode: 'store', thumbprint: null, machineStore: false });
    }
    // `onChange` and the current selection are read, not depended on: this
    // runs when the source is entered or re-read, never again on the selection
    // changing — a selection the user CLEARED has to stay cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inStoreMode, availability, certOptions]);

  // Re-decide the source every time the form opens. The caller's state
  // outlives one opening, so a fallback taken because the store was
  // unavailable would otherwise outlive the form that took it and a recovered
  // store would never be offered again. Only an UNCONFIGURED source moves —
  // a file, a label or a credential already chosen is the user's.
  useEffect(() => {
    const next = sourceOnOpen(value);
    if (next !== value.mode) onChange(emptySourceFor(next));
    // Runs once per mount by design; the incoming source is read, not
    // depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Move the keyboard onto a source radio. A selection that moves without
   * its focus leaves the arrow keys walking from a row that is no longer the
   * chosen one. */
  const focusSourceRadio = useCallback(
    (mode: SignerSourceMode) => {
      const active = document.activeElement;
      const inThisPicker =
        active instanceof HTMLElement
        && (active.getAttribute('data-testid') ?? '').startsWith(`${idPrefix}-source-input-`);
      if (!inThisPicker) return;
      rootRef.current
        ?.querySelector<HTMLInputElement>(`[data-testid="${idPrefix}-source-input-${mode}"]`)
        ?.focus();
    },
    [idPrefix],
  );

  // A store that refused, or that holds no signer, hands the selection to the
  // first advanced source rather than leaving an empty picker selected. The
  // store's message stays on the store row either way, so the move explains
  // itself. Once per opened form, on the FIRST answer only, and never over a
  // source the user picked — the guards are `sourceAfterStoreRead`'s.
  const fallbackSettled = useRef(false);
  useEffect(() => {
    if (fallbackSettled.current || availability === 'loading') return;
    const next = sourceAfterStoreRead({
      mode: value.mode,
      thumbprint: offeredThumbprint,
      userPicked: userPicked.current,
      availability,
    });
    fallbackSettled.current = true;
    if (next === value.mode) return;
    onChange(emptySourceFor(next));
    focusSourceRadio(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, inStoreMode, offeredThumbprint, focusSourceRadio]);

  const pickPfx = useCallback(async () => {
    const p = await dialog.pickCertificate();
    if (p) onChange({ mode: 'pfx', pfxPath: p });
  }, [onChange]);

  const pickModule = useCallback(async () => {
    const p = await dialog.pickPkcs11Module();
    if (p && value.mode === 'pkcs11') onChange({ ...value, modulePath: p });
  }, [onChange, value]);

  const pickKey = useCallback(async () => {
    const p = await dialog.pickPemFile();
    if (p) onChange({ mode: 'pem', keyPath: p, certPath: value.mode === 'pem' ? value.certPath : null });
  }, [onChange, value]);

  const pickCert = useCallback(async () => {
    const p = await dialog.pickPemFile();
    if (p) onChange({ mode: 'pem', keyPath: value.mode === 'pem' ? value.keyPath : null, certPath: p });
  }, [onChange, value]);

  const handleGenerate = useCallback(async () => {
    const cn = genName.trim();
    if (!cn) {
      setGenError(tChrome('dialog.signer.needName'));
      return;
    }
    if (!genPassword) {
      setGenError(tChrome('dialog.signer.needPassword'));
      return;
    }
    const dest = await dialog.saveFile({ defaultPath: `${cn.replace(/[\\/:*?"<>|]+/g, '_')}.pfx` });
    if (!dest) return; // cancelled
    setGenBusy(true);
    setGenError(null);
    try {
      // The save dialog above already confirmed any overwrite with the user,
      // so overwrite: true here does not bypass a confirmation.
      const res = (await call('generate_signer', {
        common_name: cn,
        output: dest,
        password: genPassword,
        ...(genOrg.trim() ? { org: genOrg.trim() } : {}),
        overwrite: true,
      })) as unknown as GenerateResult;
      setGenDone(res);
      setShowGenerate(false);
      onChange({ mode: 'pfx', pfxPath: res.output });
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      // Clear the generation password from state regardless of outcome.
      setGenPassword('');
      setGenBusy(false);
    }
  }, [genName, genOrg, genPassword, call, onChange]);

  const fileName = (p: string | null): React.ReactNode =>
    p ? p.split(/[\\/]/).pop()
      : <span className="text-neutral-600">{tChrome('dialog.signer.noneChosen')}</span>;

  /** One source as a full-width row.
   *
   * The label WRAPS instead of being clipped: these rows are the one layout
   * that survives both the dock at its minimum width and the canvas card, in
   * every locale. The hint sits OUTSIDE the label and is referenced by
   * `aria-describedby` — inside it, it would become part of the radio's
   * accessible name and be read on every pass through the group. */
  const sourceRow = (m: SignerSourceMode, hint?: string): React.ReactElement => {
    const hintId = hint ? `${idPrefix}-source-${m}-hint` : undefined;
    return (
      <div key={m} className="flex flex-col">
        <label
          data-testid={`${idPrefix}-source-${m}`}
          className="flex w-full items-start gap-2 cursor-pointer"
        >
          <input
            type="radio"
            // One native group of five, named by the fieldset's legend: the
            // shared name is what makes the arrow keys traverse every source
            // and what reports the set size honestly.
            name={`${idPrefix}-signer-source`}
            data-testid={`${idPrefix}-source-input-${m}`}
            aria-describedby={hintId}
            checked={value.mode === m}
            onChange={() => {
              userPicked.current = true;
              // Picking the source already picked changes nothing. A fresh
              // empty source would DISCARD the chosen certificate or path,
              // and the store's pre-select is keyed on ENTERING the source —
              // it does not run again to put the selection back.
              if (value.mode === m) return;
              onChange(emptySourceFor(m));
            }}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0 text-xs text-neutral-300 break-words">
            {tChrome(SOURCE_LABEL_KEYS[m])}
          </span>
        </label>
        {hint ? (
          <span id={hintId} className="ps-5 text-[11px] text-neutral-500 break-words">
            {hint}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    // A fieldset + legend names the ONE native radio group the five sources
    // form. `min-w-0` is load-bearing, not tidy: a fieldset's default
    // `min-width` is `min-content`, so without it this element refuses to
    // shrink below its widest label and reintroduces the overflow above.
    <fieldset className="min-w-0">
      <legend className="text-xs text-neutral-400 mb-1.5">{tChrome('dialog.signer.label')}</legend>
      <div ref={rootRef} className="flex flex-col gap-2">
        {sourceRow(PRIMARY_SIGNER_SOURCE, tChrome('dialog.signer.modeStoreHint'))}

        {/* The store's verdict renders whatever source is selected. The
            fallback below moves the selection off an unusable store, and a
            message gated on that selection would unmount in the same commit
            that moved it — leaving a silent switch with no reason. */}
        {availability === 'error' ? (
          <div data-testid={`${idPrefix}-store-error`} className="text-xs text-red-400 break-words">
            {storeError}
          </div>
        ) : availability === 'empty' ? (
          <p
            data-testid={`${idPrefix}-store-empty`}
            className="text-[11px] text-neutral-500 break-words"
          >
            {tChrome('dialog.signer.storeNone')}
          </p>
        ) : availability === 'loading' && inStoreMode ? (
          <p className="text-[11px] text-neutral-500">{tChrome('dialog.signer.storeLoading')}</p>
        ) : null}

        {value.mode === 'store' ? (
          <>
            {/* The label is stacked, not inline: this control carries a
                subject, an issuer and a date, and an 80px inline label leaves
                it too narrow to show any of them at the dock's minimum width. */}
            <span className="text-xs text-neutral-400">
              {tChrome('dialog.signer.storeCertificate')}
            </span>
            <div className="flex items-center gap-2 -mt-1">
              <select
                data-testid={`${idPrefix}-store-cert`}
                value={value.thumbprint ?? ''}
                disabled={storeBusy || certOptions.length === 0}
                onChange={(e) => {
                  const row = certOptions.find((r) => r.thumbprint === e.target.value);
                  onChange({
                    mode: 'store',
                    thumbprint: row ? row.thumbprint : null,
                    machineStore: row ? row.machineStore : false,
                  });
                }}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
              >
                <option value="">{tChrome('dialog.signer.storeChoose')}</option>
                {certOptions.map((c) => (
                  <option key={c.thumbprint} value={c.thumbprint}>
                    {tChrome('dialog.signer.storeRow', {
                      subject: c.subject,
                      issuer: c.issuer,
                      date: tDate(c.notAfter),
                    })}
                  </option>
                ))}
              </select>
              <button
                data-testid={`${idPrefix}-store-refresh`}
                onClick={() => void loadStoreCerts()}
                disabled={storeBusy}
                className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded font-medium"
              >
                {tChrome('dialog.signer.storeRefresh')}
              </button>
            </div>
            {(() => {
              const selected = certOptions.find((c) => c.thumbprint === value.thumbprint);
              if (!selected) return null;
              const marks: string[] = [];
              if (selected.hardwareBacked) marks.push(tChrome('dialog.signer.storeHardware'));
              if (selected.machineStore) marks.push(tChrome('dialog.signer.storeMachine'));
              return (
                <p className="text-[11px] text-neutral-500 -mt-1 break-all">
                  {selected.thumbprint}
                  {marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}
                </p>
              );
            })()}
            <p className="text-[11px] text-neutral-500 -mt-1">
              {tChrome('dialog.signer.storeNote')}
            </p>
          </>
        ) : null}

        <span className="text-xs text-neutral-400 mt-1">
          {tChrome('dialog.signer.sourceAdvanced')}
        </span>
        {ADVANCED_SIGNER_SOURCES.map((m) => sourceRow(m))}
        <button
          data-testid={`${idPrefix}-generate-open`}
          onClick={() => {
            setShowGenerate((v) => !v);
            setGenError(null);
          }}
          className="self-start px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          title={tChrome('dialog.signer.createTitle')}
        >
          {tChrome('dialog.signer.create')}
        </button>

        {value.mode === 'pfx' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.modePfx')}</span>
            <span
              data-testid={`${idPrefix}-pfx-path`}
              className="flex-1 min-w-0 text-xs text-neutral-300 truncate"
              title={value.pfxPath ?? undefined}
            >
              {fileName(value.pfxPath)}
            </span>
            <button
              data-testid={`${idPrefix}-pick-pfx`}
              onClick={() => void pickPfx()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('dialog.signer.choose')}
            </button>
          </div>
        ) : value.mode === 'csc' ? (
          <CscSignerFields value={value} onChange={onChange} idPrefix={idPrefix} />
        ) : value.mode === 'pkcs11' ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.module')}</span>
              <span
                className="flex-1 min-w-0 text-xs text-neutral-300 truncate"
                title={value.modulePath ?? undefined}
              >
                {fileName(value.modulePath)}
              </span>
              <button
                data-testid={`${idPrefix}-pick-module`}
                onClick={() => void pickModule()}
                className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                {tChrome('dialog.signer.choose')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.token')}</span>
              <input
                data-testid={`${idPrefix}-token-label`}
                value={value.tokenLabel}
                onChange={(e) => onChange({ ...value, tokenLabel: e.target.value })}
                placeholder={tChrome('dialog.signer.tokenPlaceholder')}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.certLabel')}</span>
              <input
                data-testid={`${idPrefix}-cert-label`}
                value={value.certLabel}
                onChange={(e) => onChange({ ...value, certLabel: e.target.value })}
                placeholder={tChrome('dialog.signer.certPlaceholder')}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.keyLabel')}</span>
              <input
                data-testid={`${idPrefix}-key-label`}
                value={value.keyLabel}
                onChange={(e) => onChange({ ...value, keyLabel: e.target.value })}
                placeholder={tChrome('dialog.signer.keyPlaceholder')}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>
            <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
              {tChrome('dialog.signer.tokenNote')}
            </p>
          </>
        ) : value.mode === 'pem' ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.keyFile')}</span>
              <span className="flex-1 min-w-0 text-xs text-neutral-300 truncate" title={value.keyPath ?? undefined}>
                {fileName(value.keyPath)}
              </span>
              <button
                data-testid={`${idPrefix}-pick-key`}
                onClick={() => void pickKey()}
                className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                {tChrome('dialog.signer.choose')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.certificate')}</span>
              <span className="flex-1 min-w-0 text-xs text-neutral-300 truncate" title={value.certPath ?? undefined}>
                {fileName(value.certPath)}
              </span>
              <button
                data-testid={`${idPrefix}-pick-cert`}
                onClick={() => void pickCert()}
                className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                {tChrome('dialog.signer.choose')}
              </button>
            </div>
            <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
              {tChrome('dialog.signer.pemNote')}
            </p>
          </>
        ) : null}

        {showGenerate && (
          <div className="rounded border border-neutral-700 bg-neutral-900/70 p-2.5 flex flex-col gap-2">
            <div className="text-xs text-neutral-300 font-medium">{tChrome('dialog.signer.newTitle')}</div>
            <p className="text-[11px] text-neutral-500 -mt-1">
              {tChrome('dialog.signer.newNote')}
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.name')}</span>
              <input
                data-testid={`${idPrefix}-generate-name`}
                type="text"
                value={genName}
                onChange={(e) => setGenName(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.organization')}</span>
              <input
                type="text"
                value={genOrg}
                placeholder={tChrome('dialog.signer.optional')}
                onChange={(e) => setGenOrg(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('dialog.signer.password')}</span>
              <input
                data-testid={`${idPrefix}-generate-password`}
                type="password"
                value={genPassword}
                onChange={(e) => setGenPassword(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
            {genError && <div className="text-xs text-red-400">{genError}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowGenerate(false);
                  setGenPassword('');
                  setGenError(null);
                }}
                className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                {tChrome('dialog.common.cancel')}
              </button>
              <button
                data-testid={`${idPrefix}-generate-apply`}
                onClick={() => void handleGenerate()}
                disabled={genBusy}
                className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
              >
                {tChrome(genBusy ? 'dialog.signer.generating' : 'dialog.signer.generate')}
              </button>
            </div>
          </div>
        )}

        {genDone && (
          <div
            data-testid={`${idPrefix}-generate-done`}
            className="text-[11px] text-green-300/90 bg-green-600/10 border border-green-600/30 rounded px-2 py-1"
          >
            {/* One whole message, not a sentence assembled around a <strong>:
                the clause order differs per language (the Settings precedent). */}
            {tChrome('dialog.signer.created', {
              name: genDone.common_name,
              date: tDate(genDone.not_after),
            })}
          </div>
        )}
      </div>
    </fieldset>
  );
}

// ── the signing-service source ────────────────────────────────────────────
//
// A provider is CONFIGURED once (address, the user's own OAuth client ID,
// scope, grant) and then its credentials are listed. Configuration and
// selection are one panel rather than a settings page because the two are the
// same act the first time and the list is meaningless without the former.
//
// Nothing here holds a PIN or a one-time password: a credential the provider
// authorizes that way is reported unusable by the engine and cannot be
// selected. The OAuth client secret is typed here and kept in memory only.

const EMPTY_DRAFT = (): CscProvider => ({
  id: newProviderId(),
  name: '',
  url: '',
  clientId: '',
  scope: DEFAULT_SCOPE,
  grant: 'client-credentials',
  caBundle: null,
});

function CscSignerFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Extract<SignerSource, { mode: 'csc' }>;
  onChange: (next: SignerSource) => void;
  idPrefix: string;
}): React.ReactElement {
  const { call } = useEngine();
  const [providers, setProviders] = useState<CscProvider[]>(() => loadProviders());
  const [draft, setDraft] = useState<CscProvider | null>(null);
  const [secret, setSecret] = useState('');
  const [rows, setRows] = useState<CscCredentialRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === value.providerId) ?? null;

  const commitDraft = useCallback(() => {
    if (!draft) return;
    const problem = providerProblem(draft);
    if (problem) {
      setError(tChrome(problem as 'dialog.signer.cscNeedUrl'));
      return;
    }
    const next = upsertProvider(providers, draft);
    setProviders(next);
    saveProviders(next);
    rememberSecret(draft.id, secret);
    setSecret('');
    setDraft(null);
    setRows(null);
    setError(null);
    onChange({ mode: 'csc', providerId: draft.id, credentialId: null, authorization: null });
  }, [draft, providers, secret, onChange]);

  const forget = useCallback(
    (id: string) => {
      const next = removeProvider(providers, id);
      setProviders(next);
      saveProviders(next);
      rememberSecret(id, '');
      if (value.providerId === id) {
        setRows(null);
        onChange({ mode: 'csc', providerId: null, credentialId: null, authorization: null });
      }
    },
    [providers, value.providerId, onChange],
  );

  // Listing is the FIRST thing that touches the network, and for an
  // authorization-code provider it is what makes the user sign in — which is
  // why it is a button and not something that happens on render.
  const listCredentials = useCallback(async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      let authorization = value.authorization;
      if (provider.grant === 'authorization-code' && !authorization) {
        const pkce = await makePkce();
        const returned = await dialog.cscAuthorize({
          baseUrl: provider.url.trim(),
          clientId: provider.clientId.trim(),
          scope: provider.scope || DEFAULT_SCOPE,
          challenge: pkce.challenge,
          state: pkce.state,
        });
        authorization = {
          code: returned.code,
          redirectUri: returned.redirect_uri,
          verifier: pkce.verifier,
        };
      }
      const result = (await call('list_csc_credentials', {
        csc_url: provider.url.trim(),
        csc_client_id: provider.clientId.trim(),
        csc_scope: provider.scope || DEFAULT_SCOPE,
        csc_grant: provider.grant,
        ...(secretFor(provider.id) ? { csc_client_secret: secretFor(provider.id) } : {}),
        ...(provider.caBundle ? { csc_ca_bundle: provider.caBundle } : {}),
        ...(authorization
          ? {
              csc_code: authorization.code,
              csc_redirect_uri: authorization.redirectUri,
              csc_verifier: authorization.verifier,
            }
          : {}),
      })) as unknown as { credentials: CscCredentialRow[] };
      setRows(result.credentials);
      // The remembered credential is an OFFER: it pre-selects only while the
      // provider still enumerates it AND still reports it usable.
      const remembered = preselectedCredential(provider.id, result.credentials);
      onChange({
        mode: 'csc',
        providerId: provider.id,
        credentialId: value.credentialId ?? remembered,
        authorization: authorization ?? null,
      });
    } catch (e: unknown) {
      setRows([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [provider, call, onChange, value.authorization, value.credentialId]);

  const fieldClass =
    'flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded focus:outline-none focus:border-blue-500';
  const labelClass = 'text-xs text-neutral-400 w-20 shrink-0';
  const buttonClass =
    'px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded font-medium';

  if (draft) {
    return (
      <div className="rounded border border-neutral-700 bg-neutral-900/70 p-2.5 flex flex-col gap-2">
        <div className="text-xs text-neutral-300 font-medium">
          {tChrome('dialog.signer.cscProviderTitle')}
        </div>
        <p className="text-[11px] text-neutral-500 -mt-1">
          {tChrome('dialog.signer.cscProviderNote')}
        </p>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscName')}</span>
          <input
            data-testid={`${idPrefix}-csc-name`}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscUrl')}</span>
          <input
            data-testid={`${idPrefix}-csc-url`}
            value={draft.url}
            placeholder={tChrome('dialog.signer.cscUrlPlaceholder')}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscClientId')}</span>
          <input
            data-testid={`${idPrefix}-csc-client-id`}
            value={draft.clientId}
            onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscClientSecret')}</span>
          <input
            data-testid={`${idPrefix}-csc-client-secret`}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className={fieldClass}
          />
        </div>
        <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
          {tChrome('dialog.signer.cscSecretNote')}
        </p>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscGrant')}</span>
          <select
            data-testid={`${idPrefix}-csc-grant`}
            value={draft.grant}
            onChange={(e) => setDraft({ ...draft, grant: e.target.value as CscGrant })}
            className={fieldClass}
          >
            {CSC_GRANTS.map((g) => (
              <option key={g} value={g}>
                {tChrome(
                  g === 'client-credentials'
                    ? 'dialog.signer.cscGrantClient'
                    : 'dialog.signer.cscGrantBrowser',
                )}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscScope')}</span>
          <input
            data-testid={`${idPrefix}-csc-scope`}
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscCaBundle')}</span>
          <span
            className="flex-1 min-w-0 text-xs text-neutral-300 truncate"
            title={draft.caBundle ?? undefined}
          >
            {draft.caBundle ? (
              draft.caBundle.split(/[\\/]/).pop()
            ) : (
              <span className="text-neutral-600">{tChrome('dialog.signer.noneChosen')}</span>
            )}
          </span>
          <button
            data-testid={`${idPrefix}-csc-pick-ca`}
            onClick={() => {
              void (async () => {
                const picked = await dialog.pickPemFile();
                if (picked) setDraft({ ...draft, caBundle: picked });
              })();
            }}
            className={buttonClass}
          >
            {tChrome('dialog.signer.choose')}
          </button>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {
              setDraft(null);
              setSecret('');
              setError(null);
            }}
            className={buttonClass}
          >
            {tChrome('dialog.common.cancel')}
          </button>
          <button
            data-testid={`${idPrefix}-csc-save-provider`}
            onClick={commitDraft}
            className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            {tChrome('dialog.signer.cscSaveProvider')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span className={labelClass}>{tChrome('dialog.signer.cscProvider')}</span>
        <select
          data-testid={`${idPrefix}-csc-provider`}
          value={value.providerId ?? ''}
          onChange={(e) => {
            setRows(null);
            setError(null);
            onChange({
              mode: 'csc',
              providerId: e.target.value || null,
              credentialId: null,
              authorization: null,
            });
          }}
          className={fieldClass}
        >
          <option value="">{tChrome('dialog.signer.cscChooseProvider')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.url}
            </option>
          ))}
        </select>
        <button
          data-testid={`${idPrefix}-csc-add-provider`}
          onClick={() => {
            setDraft(provider ? { ...provider } : EMPTY_DRAFT());
            setSecret(provider ? secretFor(provider.id) : '');
            setError(null);
          }}
          className={buttonClass}
        >
          {tChrome(provider ? 'dialog.signer.cscEditProvider' : 'dialog.signer.cscAddProvider')}
        </button>
        {provider && (
          <button
            data-testid={`${idPrefix}-csc-forget-provider`}
            onClick={() => forget(provider.id)}
            className={buttonClass}
          >
            {tChrome('dialog.signer.cscForgetProvider')}
          </button>
        )}
      </div>

      {provider && (
        <div className="flex items-center gap-2">
          <span className={labelClass}>{tChrome('dialog.signer.cscCredential')}</span>
          <select
            data-testid={`${idPrefix}-csc-credential`}
            value={value.credentialId ?? ''}
            disabled={busy || !rows || rows.length === 0}
            onChange={(e) => {
              const row = (rows ?? []).find((r) => r.credential_id === e.target.value);
              onChange({
                mode: 'csc',
                providerId: provider.id,
                credentialId: row && row.usable ? row.credential_id : null,
                authorization: value.authorization,
              });
            }}
            className={fieldClass}
          >
            <option value="">{tChrome('dialog.signer.cscChooseCredential')}</option>
            {(rows ?? []).map((r) => (
              <option key={r.credential_id} value={r.credential_id} disabled={!r.usable}>
                {r.subject || r.credential_id}
              </option>
            ))}
          </select>
          <button
            data-testid={`${idPrefix}-csc-list`}
            onClick={() => void listCredentials()}
            disabled={busy}
            className={buttonClass}
          >
            {tChrome(
              provider.grant === 'authorization-code' && !value.authorization
                ? 'dialog.signer.cscSignIn'
                : 'dialog.signer.cscList',
            )}
          </button>
        </div>
      )}

      {error ? (
        <div data-testid={`${idPrefix}-csc-error`} className="text-xs text-red-400 ml-[5.5rem]">
          {error}
        </div>
      ) : busy ? (
        <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
          {tChrome('dialog.signer.cscLoading')}
        </p>
      ) : rows && rows.length === 0 ? (
        <p
          data-testid={`${idPrefix}-csc-empty`}
          className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]"
        >
          {tChrome('dialog.signer.cscNone')}
        </p>
      ) : null}

      {(() => {
        // An unusable credential is SHOWN with its reason rather than hidden:
        // a user staring at a short list must be able to learn why it is short.
        const selected = (rows ?? []).find((r) => r.credential_id === value.credentialId);
        const unusable = (rows ?? []).filter((r) => !r.usable);
        return (
          <>
            {selected && (
              <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem] break-all">
                {selected.credential_id}
              </p>
            )}
            {unusable.map((r) => (
              <p key={r.credential_id} className="text-[11px] text-amber-400/80 -mt-1 ml-[5.5rem]">
                {tChrome('dialog.signer.cscUnusable', {
                  subject: r.subject || r.credential_id,
                  reason: r.unusable_reason ?? '',
                })}
              </p>
            ))}
          </>
        );
      })()}

      <p className="text-[11px] text-neutral-500 -mt-1 ml-[5.5rem]">
        {tChrome('dialog.signer.cscNote')}
      </p>
    </>
  );
}

/** Record the credential a signature actually used, so the picker can offer it
 * again. Selection only — a remembered credential never signs on its own, and
 * a credential id is a public identifier, not a secret. */
export function rememberCscCredential(providerId: string, credentialId: string): void {
  rememberCredential(providerId, credentialId);
}
