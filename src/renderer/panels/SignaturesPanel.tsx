import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerSignHandler } from '../testHarness';
import { SignerSourceFields, EMPTY_SIGNER_SOURCE, signerSourceParams } from '../components/SignerSourceFields';
import type { SignerSource } from '../components/SignerSourceFields';
import { getCanvasServices } from '../commands/context';
import {
  classifySignature,
  SIGNATURE_STATUS_LABEL,
  type SignatureEntry,
  type VerifyResult,
} from '../lib/signatures';
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
}

export function SignaturesPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  // 9.F5: the SAME undoable in-place flow the canvas edits use, so signing in
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
  // PAdES / TSA / LTV (F2/F4). TSA + LTV are network calls to endpoints the
  // USER configures — inherent to the capability, never a bundled service.
  const [pades, setPades] = useState(false);
  const [tsaUrl, setTsaUrl] = useState('');
  const [ltv, setLtv] = useState(false);

  // F4 trust management: user-chosen CA anchors, persisted. The OS store is
  // deliberately never consulted (the panel's standing explicit-trust rule);
  // these are the ONLY anchors `trusted` can chain to.
  const [trustRoots, setTrustRoots] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('spectra.trustAnchors');
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  });
  const saveTrustRoots = useCallback((roots: string[]) => {
    setTrustRoots(roots);
    try {
      localStorage.setItem('spectra.trustAnchors', JSON.stringify(roots));
    } catch {
      // persistence is best-effort; the session state still holds them
    }
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
        ...(trustRoots.length > 0 ? { trust_roots: trustRoots } : {}),
      })) as unknown as VerifyResult;
      setResult(res);
      setStatus('');
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [workingPath, call, trustRoots]);

  // Auto-verify when the active file OR the trust anchors change.
  useEffect(() => {
    if (path) void runVerify();
    else setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, trustRoots]);

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
  }, [path]);

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
    ): Promise<SignResult> => {
      if (!activeFile) throw new Error('No active file to sign.');
      return (await call('sign_pdf', {
        file: activeFile.workingPath,
        output,
        ...sourceParams,
        // A token source takes the password field as its PIN (F3).
        ...(sourceParams.pkcs11_module ? { pkcs11_pin: pw } : { password: pw }),
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
        ...(appearance ? { appearance } : {}),
        ...(profile?.pades ? { pades: true } : {}),
        ...(profile?.tsaUrl?.trim() ? { tsa_url: profile.tsaUrl.trim() } : {}),
        ...(profile?.ltv ? { embed_revocation: true, ...(trustRoots.length > 0 ? { trust_roots: trustRoots } : {}) } : {}),
      })) as unknown as SignResult;
    },
    [activeFile, call, trustRoots],
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
      const res = await doSign(resolved.params!, password, dest, reason, location, undefined, {
        pades,
        tsaUrl,
        ltv,
      });
      setSignResult(res);
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      // Clear the secret from component state on EVERY exit — success,
      // failure, or a cancelled save dialog (review-caught: a cancel used to
      // strand the typed password in state).
      setPassword('');
      signingRef.current = false;
      setSigning(false);
    }
  }, [activeFile, source, password, reason, location, doSign, pades, tsaUrl, ltv]);

  // 9.F5: the core in-place sign, shared by the UI handler and the e2e harness
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
    ): Promise<VerifyResult> => {
      if (!activeFile) throw new Error('No active file to sign.');
      await performOperation(activeFile.path, 'sign_pdf', {
        ...sourceParams,
        // A token source takes the password field as its PIN (F3).
        ...(sourceParams.pkcs11_module ? { pkcs11_pin: pw } : { password: pw }),
        // The engine refuses output == input UNLESS this opt-in is set — the
        // in-place flow is the one caller that intends it (round-42 gauntlet).
        allow_in_place: true,
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
        ...(pades ? { pades: true } : {}),
        ...(tsaUrl.trim() ? { tsa_url: tsaUrl.trim() } : {}),
        ...(ltv ? { embed_revocation: true, ...(trustRoots.length > 0 ? { trust_roots: trustRoots } : {}) } : {}),
      });
      // The now-signed working copy (same path, new bytes) re-verifies.
      return (await call('verify_signatures', {
        file: activeFile.workingPath,
      })) as unknown as VerifyResult;
    },
    [activeFile, performOperation, call, pades, tsaUrl, ltv, trustRoots],
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
      const v = await doSignInPlace(resolved.params!, password, reason, location);
      setResult(v); // the new signature lists immediately
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPassword('');
      signInPlaceRef.current = false;
      setSigning(false);
    }
  }, [activeFile, source, password, reason, location, doSignInPlace]);

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
          )
          .then((v) => ({
            signature_count: v.signature_count,
            all_valid: v.summary.all_valid,
          })),
      verifyActive: async () => {
        const wp = workingPathRef.current;
        if (!wp) return { signature_count: 0, all_valid: false };
        const v = (await call('verify_signatures', { file: wp })) as unknown as VerifyResult;
        return { signature_count: v.signature_count, all_valid: v.summary.all_valid };
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
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1" tabIndex={0} role="region" aria-label={tChrome('panel.sig.listAria')}>
            {result.signatures.map((sig, i) => (
              <SignatureCard
                key={sig.field ?? i}
                sig={sig}
                // F7: jump to the widget's page. jumpToFilePage (not
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
          {/* Trust posture (F4): with no anchors, identity is explicitly
              unverified (never the OS store); with user anchors, `trusted`
              is validated against exactly those. */}
          {trustRoots.length === 0 ? (
            <div
              data-testid="trust-caveat"
              className="shrink-0 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200/90"
            >
              {tChrome('panel.sig.trustCaveat')}
            </div>
          ) : (
            <div
              data-testid="trust-status"
              className={`shrink-0 px-3 py-2 rounded text-xs border ${
                result.summary.trust_verified
                  ? 'bg-green-600/10 border-green-600/30 text-green-200/90'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-200/90'
              }`}
            >
              {result.summary.trust_verified
                ? tChromeCount('panel.sig.trustVerified', trustRoots.length)
                : tChrome('panel.sig.trustFailed')}
            </div>
          )}
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
          {/* F6: the visible-signature path from the PANEL — hands off to the
              canvas placement flow with these signer details prefilled, so
              nothing is typed twice. Offered only while the canvas is up. */}
          {getCanvasServices()?.startVisibleSignature && (
            <button
              data-testid="sign-visible-btn"
              type="button"
              onClick={() => getCanvasServices()?.startVisibleSignature?.(source)}
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

function SignatureCard({ sig, onJump }: { sig: SignatureEntry; onJump?: () => void }): React.ReactElement {
  const status = classifySignature(sig);
  const cls = {
    invalid: 'bg-red-600/20 text-red-300 border-red-600/40',
    modified: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
    valid: 'bg-green-600/15 text-green-300 border-green-600/40',
  }[status];
  const badge = { text: tChrome(SIGNATURE_STATUS_LABEL[status]), cls };

  return (
    <div data-testid="signature-card" className="rounded border border-neutral-800 bg-neutral-900/50 p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span data-testid="signature-signer" className="text-sm text-neutral-200 font-medium truncate">
          {sig.signer ?? tChrome('panel.sig.unknownSigner')}
        </span>
        <span className={`shrink-0 px-2 py-0.5 text-[11px] rounded border ${badge.cls}`}>{badge.text}</span>
      </div>
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
        {sig.trusted && <span data-testid="signature-trusted">{tChrome('panel.sig.identityTrusted')}</span>}
      </div>
      {sig.error && <div className="text-xs text-red-400">{tChrome('panel.sig.errorLine', { message: sig.error })}</div>}
    </div>
  );
}
