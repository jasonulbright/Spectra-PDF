import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerSignHandler, type SignatureVerifySnapshot } from '../testHarness';
import { SignerSourceFields, EMPTY_SIGNER_SOURCE, signerSourceParams } from '../components/SignerSourceFields';
import type { SignerSource } from '../components/SignerSourceFields';
import { getCanvasServices } from '../commands/context';
import {
  classifySignature,
  policyVerdict,
  POLICY_VERDICT_LABEL,
  signatureKind,
  SIGNATURE_KIND_LABEL,
  SIGNATURE_STATUS_LABEL,
  CERTIFICATION_LEVEL_LABEL,
  LOCK_ACTION_LABEL,
  CERTIFY_LEVELS,
  DEFAULT_CERTIFY,
  DEFAULT_LOCK,
  certifyParams,
  lockParams,
  type CertificationLevel,
  type CertifyOptions,
  type LockAction,
  type LockOptions,
  type SignatureEntry,
  type VerifyResult,
} from '../lib/signatures';
import { FieldLockControl } from '../components/FieldLockControl';
import { readFormFields } from '../lib/forms';
import {
  loadTrustConfig,
  saveSystemStore,
  saveTrustAnchors,
  systemStoreUnavailable,
  trustSummary,
  trustVerifyParams,
  TRUST_SOURCE_LABEL,
  type TrustConfig,
} from '../lib/trust-store';
import { CertificationBanner } from '../components/CertificationBanner';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

interface SignResult {
  output: string;
  field: string;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  covers_whole_document: boolean;
  signature_count: number;
  /** Read back out of the written bytes, never echoed from the request. */
  certified?: boolean;
  certification_level?: CertificationLevel | null;
  lock?: LockAction | null;
  lock_fields?: string[];
}

const EMPTY_VERIFY_SNAPSHOT: SignatureVerifySnapshot = {
  signature_count: 0,
  all_valid: false,
  certified: false,
  certification_level: null,
  any_policy_violation: false,
  signatures: [],
};

/** The harness drives the same options the form collects; an omitted certify
 * flag is the ordinary approval signature. */
function harnessCertify(params: {
  certify?: boolean;
  certifyLevel?: CertificationLevel;
}): CertifyOptions {
  return params.certify
    ? { certify: true, level: params.certifyLevel ?? DEFAULT_CERTIFY.level }
    : DEFAULT_CERTIFY;
}

/** The same for the field lock; an omitted action locks nothing. */
function harnessLock(params: { lock?: LockAction; lockFields?: string[] }): LockOptions {
  return params.lock ? { action: params.lock, fields: params.lockFields ?? [] } : DEFAULT_LOCK;
}

export function SignaturesPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  // The SAME undoable in-place flow the canvas edits use, so signing in
  // place snapshots for undo and only touches the on-disk file on Save.
  const { performOperation } = useOperations();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Signing (produces a NEW file; the active file's working copy is untouched).
  const [showSign, setShowSign] = useState(false);
  const [source, setSource] = useState<SignerSource>(EMPTY_SIGNER_SOURCE);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [signing, setSigning] = useState(false);
  const [signResult, setSignResult] = useState<SignResult | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  // PAdES / TSA / LTV. TSA + LTV are network calls to endpoints the
  // USER configures — inherent to the capability, never a bundled service.
  const [pades, setPades] = useState(false);
  const [tsaUrl, setTsaUrl] = useState('');
  const [ltv, setLtv] = useState(false);
  // Certification. Offered only while the document carries no signature at
  // all: a certification signature must be the first signature in a document,
  // so on any other document the control is ABSENT with a sentence saying why
  // rather than present and unusable.
  const [certify, setCertify] = useState<CertifyOptions>(DEFAULT_CERTIFY);
  // The field lock. Independent of certification — a lock binds with no
  // certification present — so it is offered on every signature, and the field
  // names come from the document rather than from typing.
  const [lock, setLock] = useState<LockOptions>(DEFAULT_LOCK);
  const [lockableFields, setLockableFields] = useState<string[]>([]);

  // Trust management: user-chosen CA anchors, plus an explicit opt-in to the
  // OS certificate store. Both persisted, both off/empty by default — with
  // neither, nothing can make `trusted` true, which is the explicit-trust
  // posture the panel has always stated.
  const [trust, setTrust] = useState<TrustConfig>(loadTrustConfig);
  const trustRoots = trust.anchors;
  const saveTrustRoots = useCallback((roots: string[]) => {
    setTrust((t) => ({ ...t, anchors: roots }));
    saveTrustAnchors(roots);
  }, []);
  const setSystemStore = useCallback((on: boolean) => {
    setTrust((t) => ({ ...t, systemStore: on }));
    saveSystemStore(on);
  }, []);

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const runVerify = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setStatus(tChrome('panel.sig.verifying'));
    setResult(null);
    try {
      const res = (await call('verify_signatures', {
        file: workingPath,
        ...trustVerifyParams(trust),
      })) as unknown as VerifyResult;
      setResult(res);
      setStatus('');
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [workingPath, call, trust]);

  // Auto-verify when the active file OR the trust configuration changes.
  useEffect(() => {
    if (path) void runVerify();
    else setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, trust]);

  // Reset the sign form when the active file changes — never carry a typed
  // password or a previous file's result across a switch.
  useEffect(() => {
    setShowSign(false);
    setPassword('');
    setReason('');
    setLocation('');
    setSource(EMPTY_SIGNER_SOURCE);
    setSignResult(null);
    setSignError(null);
    setCertify(DEFAULT_CERTIFY);
    setLock(DEFAULT_LOCK);
  }, [path]);

  // The names a lock can choose from. Signature fields are excluded — a lock
  // governs form fields. `read_form_fields` is an INTERNAL read, so opening the
  // sign form does not flush the user's pending page edits to disk.
  useEffect(() => {
    if (!workingPath) {
      setLockableFields([]);
      return;
    }
    let cancelled = false;
    void readFormFields(call, workingPath)
      .then(({ fields }) => {
        if (cancelled) return;
        setLockableFields(fields.filter((f) => f.type !== 'signature').map((f) => f.name));
      })
      .catch(() => {
        if (!cancelled) setLockableFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workingPath, call]);

  // The core engine call, shared by the UI handler and the e2e harness hook
  // (native .pfx/save dialogs aren't WebDriver-drivable). No dialog / no state
  // — just paths in, self-verify summary out.
  const doSign = useCallback(
    async (
      sourceParams: Record<string, string>,
      pw: string,
      output: string,
      rsn?: string,
      loc?: string,
      appearance?: { page: number; rect: [number, number, number, number] },
      profile?: { pades?: boolean; tsaUrl?: string; ltv?: boolean },
      certification: CertifyOptions = DEFAULT_CERTIFY,
      fieldLock: LockOptions = DEFAULT_LOCK,
    ): Promise<SignResult> => {
      if (!activeFile) throw new Error(tChrome('refusal.file.noActiveToSign'));
      return (await call('sign_pdf', {
        file: activeFile.workingPath,
        output,
        ...sourceParams,
        // A token source takes the password field as its PIN.
        ...(sourceParams.pkcs11_module ? { pkcs11_pin: pw } : { password: pw }),
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
        ...(appearance ? { appearance } : {}),
        ...(profile?.pades ? { pades: true } : {}),
        ...(profile?.tsaUrl?.trim() ? { tsa_url: profile.tsaUrl.trim() } : {}),
        ...(profile?.ltv ? { embed_revocation: true, ...trustVerifyParams(trust) } : {}),
        ...certifyParams(certification),
        ...lockParams(fieldLock),
      })) as unknown as SignResult;
    },
    [activeFile, call, trust],
  );

  // Ref, not just state: two clicks in the same tick both read a stale
  // `signing === false` (the documented reentrancy-tripwire class — same
  // guard as applyMarks/applySignature).
  const signingRef = useRef(false);
  const handleSign = useCallback(async () => {
    if (!activeFile || signingRef.current) return;
    const resolved = signerSourceParams(source);
    if (resolved.error) {
      setSignError(resolved.error);
      return;
    }
    if (!password && source.mode === 'pfx') {
      setSignError(tChrome('panel.sig.enterPassword'));
      return;
    }
    const suggested = activeFile.name.replace(/\.pdfx?$/i, '') + '-signed.pdf';
    signingRef.current = true;
    setSigning(true);
    setSignError(null);
    setSignResult(null);
    try {
      const dest = await dialog.saveFile({ defaultPath: suggested });
      if (!dest) return; // cancelled — the finally still clears the password
      const res = await doSign(
        resolved.params!, password, dest, reason, location, undefined,
        { pades, tsaUrl, ltv },
        certify,
        lock,
      );
      setSignResult(res);
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      // Clear the secret from component state on EVERY exit — success,
      // failure, or a cancelled save dialog (regression: a cancel used to
      // strand the typed password in state).
      setPassword('');
      signingRef.current = false;
      setSigning(false);
    }
  }, [activeFile, source, password, reason, location, doSign, pades, tsaUrl, ltv, certify, lock]);

  // The core in-place sign, shared by the UI handler and the e2e harness
  // hook (the native .pfx picker is not WebDriver-drivable, exactly as doSign).
  // Routes through the workspace's undoable performOperation (snapshot → sign
  // the working copy → UPDATE_FILE), so the signature becomes part of the open
  // document (Ctrl+Z reverts it) and the file on disk is written only on Save.
  // The password is passed straight to the engine and never retained (the op
  // log records only params.file). Returns the post-sign verification.
  const doSignInPlace = useCallback(
    async (
      sourceParams: Record<string, string>,
      pw: string,
      rsn?: string,
      loc?: string,
      certification: CertifyOptions = DEFAULT_CERTIFY,
      fieldLock: LockOptions = DEFAULT_LOCK,
    ): Promise<VerifyResult> => {
      if (!activeFile) throw new Error(tChrome('refusal.file.noActiveToSign'));
      await performOperation(activeFile.path, 'sign_pdf', {
        ...sourceParams,
        // A token source takes the password field as its PIN.
        ...(sourceParams.pkcs11_module ? { pkcs11_pin: pw } : { password: pw }),
        // The engine refuses output == input UNLESS this opt-in is set — the
        // in-place flow is the one caller that intends it (regression).
        allow_in_place: true,
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
        ...(pades ? { pades: true } : {}),
        ...(tsaUrl.trim() ? { tsa_url: tsaUrl.trim() } : {}),
        ...(ltv ? { embed_revocation: true, ...trustVerifyParams(trust) } : {}),
        ...certifyParams(certification),
        ...lockParams(fieldLock),
      });
      // The now-signed working copy (same path, new bytes) re-verifies under
      // the same trust configuration the panel is displaying.
      return (await call('verify_signatures', {
        file: activeFile.workingPath,
        ...trustVerifyParams(trust),
      })) as unknown as VerifyResult;
    },
    [activeFile, performOperation, call, pades, tsaUrl, ltv, trust],
  );

  const signInPlaceRef = useRef(false);
  const handleSignInPlace = useCallback(async () => {
    if (!activeFile || signInPlaceRef.current) return;
    const resolved = signerSourceParams(source);
    if (resolved.error) {
      setSignError(resolved.error);
      return;
    }
    if (!password && source.mode === 'pfx') {
      setSignError(tChrome('panel.sig.enterPassword'));
      return;
    }
    signInPlaceRef.current = true;
    setSigning(true);
    setSignError(null);
    setSignResult(null);
    try {
      const v = await doSignInPlace(resolved.params!, password, reason, location, certify, lock);
      setResult(v); // the new signature lists immediately
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPassword('');
      signInPlaceRef.current = false;
      setSigning(false);
    }
  }, [activeFile, source, password, reason, location, doSignInPlace, certify, lock]);

  // e2e-only: register the real sign call so the harness can drive it with
  // injected paths (the native dialogs can't be driven by WebDriver).
  const doSignRef = useRef(doSign);
  doSignRef.current = doSign;
  const doSignInPlaceRef = useRef(doSignInPlace);
  doSignInPlaceRef.current = doSignInPlace;
  // The current working copy path, for the read-only verify hook (the effect
  // below registers once, so it must read a ref, not a stale closure).
  const workingPathRef = useRef(workingPath);
  workingPathRef.current = workingPath;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerSignHandler({
      sign: (p) =>
        doSignRef.current(
          p.pfxPath
            ? { pfx_path: p.pfxPath }
            : { key_path: p.keyPath ?? '', cert_path: p.certPath ?? '' },
          p.password,
          p.output,
          p.reason,
          p.location,
          p.appearance,
          p.pades ? { pades: true } : undefined,
          harnessCertify(p),
          harnessLock(p),
        ),
      signInPlace: (p) =>
        doSignInPlaceRef
          .current(
            p.pfxPath
              ? { pfx_path: p.pfxPath }
              : { key_path: p.keyPath ?? '', cert_path: p.certPath ?? '' },
            p.password,
            p.reason,
            p.location,
            harnessCertify(p),
            harnessLock(p),
          )
          .then((v) => ({
            signature_count: v.signature_count,
            all_valid: v.summary.all_valid,
          })),
      verifyActive: async () => {
        const wp = workingPathRef.current;
        if (!wp) return EMPTY_VERIFY_SNAPSHOT;
        const v = (await call('verify_signatures', { file: wp })) as unknown as VerifyResult;
        return {
          signature_count: v.signature_count,
          all_valid: v.summary.all_valid,
          certified: v.certification?.certified === true,
          certification_level: v.certification?.level ?? null,
          any_policy_violation: v.summary.any_policy_violation === true,
          any_lock_violation: v.summary.any_lock_violation === true,
          signatures: v.signatures.map((s) => ({
            field: s.field,
            certification_level: s.certification_level ?? null,
            policy_ok: s.policy_ok ?? null,
            policy_judged: s.policy_judged === true,
            modification_level: s.modification_level ?? null,
            lock: s.lock ?? null,
            lock_violation: s.lock_violation ?? null,
          })),
        };
      },
    });
    return () => registerSignHandler(null);
  }, [call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.sig.open')} />;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="shrink-0 flex items-center gap-3">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.sig.heading')} <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="signatures-recheck"
          onClick={() => void runVerify()}
          disabled={busy}
          className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
        >
          {tChrome('panel.sig.recheck')}
        </button>
        <button
          data-testid="sign-open"
          onClick={() => {
            setShowSign((v) => !v);
            setSignError(null);
          }}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium"
        >
          {tChrome('panel.sig.signPdf')}
        </button>
      </div>

      {result && !result.signed && !busy && (
        <div data-testid="signatures-empty" className="text-sm text-neutral-500">
          {tChrome('panel.sig.none')}
        </div>
      )}

      {result && result.signed && (
        <>
          <div
            data-testid="signatures-summary"
            className="shrink-0 text-sm text-neutral-300"
          >
            {tChromeCount('panel.sig.found', result.signature_count)}
          </div>
          <CertificationBanner result={result} />
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1" tabIndex={0} role="region" aria-label={tChrome('panel.sig.listAria')}>
            {result.signatures.map((sig, i) => (
              <SignatureCard
                key={sig.field ?? i}
                sig={sig}
                certified={result.certification?.certified === true}
                // Jump to the widget's page. jumpToFilePage (not
                // centerOn) — the bookmark rule: it resolves page number →
                // live id, partitions included.
                onJump={
                  sig.page !== undefined && activeFile
                    ? () => getCanvasServices()?.jumpToFilePage(activeFile.path, sig.page!)
                    : undefined
                }
              />
            ))}
          </div>
          {/* Trust posture. With no source configured, identity is explicitly
              unverified; with one, `trusted` is validated against exactly the
              anchors that source supplies, and the box names which of them
              vouched for the chain. */}
          <TrustStatusBox trust={trust} result={result} />
        </>
      )}

      <div className="shrink-0 flex flex-col gap-1" data-testid="trust-anchors">
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">{tChrome('panel.sig.trustAnchors')}</span>
          <button
            data-testid="trust-anchor-add"
            onClick={() => {
              void (async () => {
                const p = await dialog.pickPemFile();
                if (p && !trustRoots.includes(p)) saveTrustRoots([...trustRoots, p]);
              })();
            }}
            className="px-2 py-0.5 text-[11px] bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded"
          >
            {tChrome('panel.sig.addCa')}
          </button>
        </div>
        {trustRoots.map((p) => (
          <div key={p} className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="truncate" title={p}>
              {p.split(/[\\/]/).pop()}
            </span>
            <button
              data-testid="trust-anchor-remove"
              onClick={() => saveTrustRoots(trustRoots.filter((r) => r !== p))}
              className="text-neutral-600 hover:text-red-400"
              aria-label={tChrome('panel.sig.removeAnchor', { path: p })}
            >
              ×
            </button>
          </div>
        ))}
        {/* The second trust SOURCE, beside the anchors rather than in a
            settings surface: it is the same decision, and it changes what the
            list above means. Off unless turned on — the engine reads no
            certificate store at all while it is off. */}
        <label className="flex items-center gap-2 text-xs text-neutral-300 mt-1">
          <input
            data-testid="trust-system-store"
            type="checkbox"
            checked={trust.systemStore}
            onChange={(e) => setSystemStore(e.target.checked)}
          />
          {tChrome('panel.sig.systemStore')}
        </label>
        <p className="text-[11px] text-neutral-500">{tChrome('panel.sig.systemStoreHint')}</p>
        {systemStoreUnavailable(result) && (
          <p data-testid="trust-system-store-unavailable" className="text-[11px] text-amber-200/90">
            {tChrome('panel.sig.systemStoreUnavailable')}
          </p>
        )}
      </div>

      {showSign && (
        <div
          data-testid="sign-form"
          className="shrink-0 rounded border border-neutral-700 bg-neutral-900/60 p-3 flex flex-col gap-3"
        >
          <div className="text-sm text-neutral-300 font-medium">{tChrome('panel.sig.signHeading')}</div>
          <p className="text-xs text-neutral-500 -mt-1">
            {tChrome('panel.sig.signBlurb')}
          </p>
          {/* The visible-signature path from the PANEL — hands off to the
              canvas placement flow with these signer details prefilled, so
              nothing is typed twice. Offered only while the canvas is up. */}
          {getCanvasServices()?.startVisibleSignature && (
            <button
              data-testid="sign-visible-btn"
              type="button"
              onClick={() =>
                getCanvasServices()?.startVisibleSignature?.(
                  source,
                  result?.signed ? DEFAULT_CERTIFY : certify,
                  lock,
                )
              }
              className="self-start px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded"
              title={tChrome('panel.sig.visibleTitle')}
            >
              {tChrome('panel.sig.visibleBtn')}
            </button>
          )}
          <SignerSourceFields value={source} onChange={setSource} idPrefix="sign" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('panel.sig.password')}</span>
            <input
              data-testid="sign-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('panel.sig.reason')}</span>
            <input
              data-testid="sign-reason"
              type="text"
              value={reason}
              placeholder={tChrome('panel.sig.optional')}
              onChange={(e) => setReason(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('panel.sig.location')}</span>
            <input
              data-testid="sign-location"
              type="text"
              value={location}
              placeholder={tChrome('panel.sig.optional')}
              onChange={(e) => setLocation(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input
              data-testid="sign-pades"
              type="checkbox"
              checked={pades}
              onChange={(e) => {
                setPades(e.target.checked);
                if (!e.target.checked) setLtv(false);
              }}
            />
            {tChrome('panel.sig.pades')}
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('panel.sig.tsaUrl')}</span>
            <input
              data-testid="sign-tsa-url"
              type="text"
              value={tsaUrl}
              placeholder={tChrome('panel.sig.tsaPlaceholder')}
              onChange={(e) => setTsaUrl(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <label className={`flex items-center gap-2 text-xs ${pades ? 'text-neutral-300' : 'text-neutral-600'}`}>
            <input
              data-testid="sign-ltv"
              type="checkbox"
              checked={ltv}
              disabled={!pades}
              onChange={(e) => setLtv(e.target.checked)}
            />
            {tChrome('panel.sig.ltv')}
          </label>
          {/* A certification signature must be the FIRST signature in a
              document, so on a document that already carries one the control
              is absent with a sentence saying why — a control that cannot be
              used and cannot be explained is the shortfall to avoid. */}
          {result?.signed ? (
            <p data-testid="certify-unavailable" className="text-[11px] text-neutral-500">
              {tChrome('panel.sig.certifyUnavailable')}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5" data-testid="certify-group">
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  data-testid="sign-certify"
                  type="checkbox"
                  checked={certify.certify}
                  onChange={(e) => setCertify((c) => ({ ...c, certify: e.target.checked }))}
                />
                {tChrome('panel.sig.certify')}
              </label>
              <p className="text-[11px] text-neutral-500">{tChrome('panel.sig.certifyHint')}</p>
              {certify.certify && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400 w-20 shrink-0">
                    {tChrome('panel.sig.certifyLevel')}
                  </span>
                  <select
                    data-testid="sign-certify-level"
                    value={certify.level}
                    aria-label={tChrome('panel.sig.certifyLevel')}
                    onChange={(e) =>
                      setCertify((c) => ({ ...c, level: e.target.value as CertificationLevel }))
                    }
                    className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
                  >
                    {CERTIFY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {tChrome(CERTIFICATION_LEVEL_LABEL[level])}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          <FieldLockControl
            value={lock}
            onChange={setLock}
            fieldNames={lockableFields}
            idPrefix="sign"
          />
          {signError && <div className="text-xs text-red-400">{signError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowSign(false);
                setPassword('');
                setSignError(null);
              }}
              className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('panel.sig.cancel')}
            </button>
            <button
              data-testid="sign-in-place"
              onClick={() => void handleSignInPlace()}
              disabled={signing}
              className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {signing ? tChrome('panel.sig.signing') : tChrome('panel.sig.signInPlace')}
            </button>
            <button
              data-testid="sign-apply"
              onClick={() => void handleSign()}
              disabled={signing}
              className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
            >
              {signing ? tChrome('panel.sig.signing') : tChrome('panel.sig.signSaveCopy')}
            </button>
          </div>
        </div>
      )}

      {signResult && (
        <div
          data-testid="sign-result"
          className="shrink-0 px-3 py-2 bg-green-600/15 border border-green-600/40 rounded text-sm text-green-200"
        >
          {tChrome('panel.sig.signedAs')} <strong>{signResult.signer ?? tChrome('panel.sig.unknownSigner')}</strong>
          {signResult.valid && signResult.intact && signResult.covers_whole_document
            ? tChrome('panel.sig.signedOk')
            : tChrome('panel.sig.signedBad')}
          {signResult.certified && (
            <div data-testid="sign-result-certified" className="text-xs text-green-300/70 mt-0.5">
              {signResult.certification_level
                ? tChrome(CERTIFICATION_LEVEL_LABEL[signResult.certification_level])
                : tChrome('panel.sig.certifiedLevelUnknown')}
            </div>
          )}
          <div className="text-xs text-green-300/70 mt-0.5 truncate" title={signResult.output}>
            {tChrome('panel.sig.savedTo', { path: signResult.output })}
          </div>
        </div>
      )}
      {signError && !showSign && <div data-testid="sign-error" className="shrink-0 text-xs text-red-400">{signError}</div>}

      <StatusBar message={status} busy={busy} />
    </div>
  );
}

/** The aggregate trust readout. The no-source case is its own box, not a
 * failed verification: nothing was asked to vouch for the chain. */
function TrustStatusBox({
  trust,
  result,
}: {
  trust: TrustConfig;
  result: VerifyResult;
}): React.ReactElement {
  const summary = trustSummary(trust, result);
  if (summary === 'none') {
    return (
      <div
        data-testid="trust-caveat"
        className="shrink-0 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200/90"
      >
        {tChrome('panel.sig.trustCaveat')}
      </div>
    );
  }
  const verified = summary !== 'failed';
  const message =
    summary === 'failed'
      ? tChrome('panel.sig.trustFailed')
      : summary === 'system'
        ? tChrome('panel.sig.trustVerifiedSystem')
        : summary === 'mixed'
          ? tChrome('panel.sig.trustVerifiedMixed')
          : tChromeCount('panel.sig.trustVerified', trust.anchors.length);
  return (
    <div
      data-testid="trust-status"
      data-trust={summary}
      className={`shrink-0 px-3 py-2 rounded text-xs border ${
        verified
          ? 'bg-green-600/10 border-green-600/30 text-green-200/90'
          : 'bg-amber-500/10 border-amber-500/30 text-amber-200/90'
      }`}
    >
      {message}
    </div>
  );
}

function SignatureCard({
  sig,
  certified,
  onJump,
}: {
  sig: SignatureEntry;
  certified: boolean;
  onJump?: () => void;
}): React.ReactElement {
  const status = classifySignature(sig);
  const cls = {
    invalid: 'bg-red-600/20 text-red-300 border-red-600/40',
    modified: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
    valid: 'bg-green-600/15 text-green-300 border-green-600/40',
  }[status];
  const badge = { text: tChrome(SIGNATURE_STATUS_LABEL[status]), cls };
  // The second axis, rendered BESIDE the status badge — never instead of it.
  const kind = signatureKind(sig);
  const verdict = policyVerdict(sig);

  return (
    <div
      data-testid="signature-card"
      data-kind={kind}
      data-policy={verdict}
      className="rounded border border-neutral-800 bg-neutral-900/50 p-3 flex flex-col gap-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span data-testid="signature-signer" className="text-sm text-neutral-200 font-medium truncate">
          {sig.signer ?? tChrome('panel.sig.unknownSigner')}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {kind === 'certification' && (
            <span
              data-testid="signature-certification-badge"
              className="px-2 py-0.5 text-[11px] rounded border bg-blue-600/15 text-blue-300 border-blue-600/40"
            >
              {tChrome(SIGNATURE_KIND_LABEL.certification)}
            </span>
          )}
          <span className={`px-2 py-0.5 text-[11px] rounded border ${badge.cls}`}>{badge.text}</span>
        </span>
      </div>
      {certified && verdict !== 'within-policy' && (
        <div
          data-testid="signature-policy"
          className={`text-xs ${verdict === 'unjudged' ? 'text-amber-200/90' : 'text-red-300'}`}
        >
          {tChrome(POLICY_VERDICT_LABEL[verdict])}
        </div>
      )}
      {/* The field lock is a THIRD fact beside validity and the certification
          verdict: a signature can be valid, within the document's
          certification, and still report a change to what it locked. */}
      {sig.lock && (
        <div data-testid="signature-lock" data-lock-action={sig.lock.action} className="text-xs text-neutral-400">
          {tChrome(LOCK_ACTION_LABEL[sig.lock.action], { fields: sig.lock.fields.join(', ') })}
        </div>
      )}
      {sig.lock_violation && (
        <div data-testid="signature-lock-violation" className="text-xs text-red-300">
          {tChrome('panel.sig.lockViolated', {
            field: sig.field ?? tChrome('panel.sig.unnamedField'),
            fields: sig.lock_violation.fields.join(', '),
          })}
        </div>
      )}
      <div className="text-xs text-neutral-500 flex flex-wrap gap-x-4 gap-y-0.5">
        {sig.field && <span>{tChrome('panel.sig.field', { name: sig.field })}</span>}
        {sig.page !== undefined && (
          onJump ? (
            <button
              data-testid="signature-jump"
              className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline"
              onClick={onJump}
            >
              {tChrome('panel.sig.pageJump', { page: sig.page })}
            </button>
          ) : (
            <span>{tChrome('panel.sig.page', { page: sig.page })}</span>
          )
        )}
        <span>
          {sig.intact ? tChrome('panel.sig.integrityIntact') : tChrome('panel.sig.integrityBroken')}
          {' · '}
          {sig.covers_whole_document
            ? tChrome('panel.sig.coversWhole')
            : tChrome('panel.sig.coversPartial')}
        </span>
        {sig.digest_algorithm && <span>{tChrome('panel.sig.digest', { algo: sig.digest_algorithm })}</span>}
        {sig.pades && <span data-testid="signature-pades">PAdES</span>}
        {sig.timestamped ? (
          <span data-testid="signature-timestamp">
            {tChrome('panel.sig.tsaTime', { time: sig.timestamp_time ?? tChrome('panel.sig.tsaUnreadable') })}
            {sig.timestamp_valid ? '' : tChrome('panel.sig.tsaNotVerified')}
          </span>
        ) : (
          sig.signing_time && <span>{tChrome('panel.sig.claimedTime', { time: sig.signing_time })}</span>
        )}
        {sig.trusted && (
          <span data-testid="signature-trusted" data-trust-source={sig.trust_source ?? 'unknown'}>
            {/* Naming the source is the point: "trusted" means something
                different when the machine vouched for the chain than when the
                user did. An anchor matching neither set falls back to the
                unqualified wording rather than claiming a source. */}
            {sig.trust_source
              ? tChrome(TRUST_SOURCE_LABEL[sig.trust_source])
              : tChrome('panel.sig.identityTrusted')}
          </span>
        )}
      </div>
      {sig.error && <div className="text-xs text-red-400">{tChrome('panel.sig.errorLine', { message: sig.error })}</div>}
    </div>
  );
}
