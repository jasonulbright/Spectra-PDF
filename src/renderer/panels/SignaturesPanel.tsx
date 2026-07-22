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
import {
  classifySignature,
  SIGNATURE_STATUS_LABEL,
  type SignatureEntry,
  type VerifyResult,
} from '../lib/signatures';

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

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const runVerify = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setStatus('Verifying signatures…');
    setResult(null);
    try {
      const res = (await call('verify_signatures', { file: workingPath })) as unknown as VerifyResult;
      setResult(res);
      setStatus('');
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [workingPath, call]);

  // Auto-verify when the active file changes (mount + switch).
  useEffect(() => {
    if (path) void runVerify();
    else setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

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
    ): Promise<SignResult> => {
      if (!activeFile) throw new Error('No active file to sign.');
      return (await call('sign_pdf', {
        file: activeFile.workingPath,
        output,
        ...sourceParams,
        password: pw,
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
        ...(appearance ? { appearance } : {}),
      })) as unknown as SignResult;
    },
    [activeFile, call],
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
      setSignError('Enter the signer password.');
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
      const res = await doSign(resolved.params!, password, dest, reason, location);
      setSignResult(res);
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Clear the secret from component state on EVERY exit — success,
      // failure, or a cancelled save dialog (review-caught: a cancel used to
      // strand the typed password in state).
      setPassword('');
      signingRef.current = false;
      setSigning(false);
    }
  }, [activeFile, source, password, reason, location, doSign]);

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
        password: pw,
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
      });
      // The now-signed working copy (same path, new bytes) re-verifies.
      return (await call('verify_signatures', {
        file: activeFile.workingPath,
      })) as unknown as VerifyResult;
    },
    [activeFile, performOperation, call],
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
      setSignError('Enter the signer password.');
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
      setSignError(`Error: ${e instanceof Error ? e.message : String(e)}`);
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

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to check its signatures" />;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="shrink-0 flex items-center gap-3">
        <div className="text-sm text-neutral-400">
          Signatures in <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="signatures-recheck"
          onClick={() => void runVerify()}
          disabled={busy}
          className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
        >
          Re-check
        </button>
        <button
          data-testid="sign-open"
          onClick={() => {
            setShowSign((v) => !v);
            setSignError(null);
          }}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium"
        >
          Sign this PDF…
        </button>
      </div>

      {result && !result.signed && !busy && (
        <div data-testid="signatures-empty" className="text-sm text-neutral-500">
          This PDF has no digital signatures.
        </div>
      )}

      {result && result.signed && (
        <>
          <div
            data-testid="signatures-summary"
            className="shrink-0 text-sm text-neutral-300"
          >
            {result.signature_count} signature{result.signature_count === 1 ? '' : 's'} found.
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
            {result.signatures.map((sig, i) => (
              <SignatureCard key={sig.field ?? i} sig={sig} />
            ))}
          </div>
          {/* Standing trust caveat — this slice verifies cryptography and
              document integrity, NOT signer identity against a trust store. */}
          <div
            data-testid="trust-caveat"
            className="shrink-0 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200/90"
          >
            Signer identity is <strong>not verified against a trusted authority</strong> — these
            results confirm cryptographic validity and whether the document was changed after
            signing, not who the signer really is.
          </div>
        </>
      )}

      {showSign && (
        <div
          data-testid="sign-form"
          className="shrink-0 rounded border border-neutral-700 bg-neutral-900/60 p-3 flex flex-col gap-3"
        >
          <div className="text-sm text-neutral-300 font-medium">Sign this document</div>
          <p className="text-xs text-neutral-500 -mt-1">
            Applies an invisible signature. <strong>Sign in place</strong> signs the open document
            (undoable; written to disk on Save); <strong>Sign &amp; Save a copy</strong> writes a new
            signed file and leaves the current one unchanged. Any later edit to a signed document
            invalidates its signature.
          </p>
          <SignerSourceFields value={source} onChange={setSource} idPrefix="sign" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Password</span>
            <input
              data-testid="sign-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Reason</span>
            <input
              data-testid="sign-reason"
              type="text"
              value={reason}
              placeholder="optional"
              onChange={(e) => setReason(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Location</span>
            <input
              data-testid="sign-location"
              type="text"
              value={location}
              placeholder="optional"
              onChange={(e) => setLocation(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
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
              Cancel
            </button>
            <button
              data-testid="sign-in-place"
              onClick={() => void handleSignInPlace()}
              disabled={signing}
              className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {signing ? 'Signing…' : 'Sign in place'}
            </button>
            <button
              data-testid="sign-apply"
              onClick={() => void handleSign()}
              disabled={signing}
              className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
            >
              {signing ? 'Signing…' : 'Sign & Save a copy…'}
            </button>
          </div>
        </div>
      )}

      {signResult && (
        <div
          data-testid="sign-result"
          className="shrink-0 px-3 py-2 bg-green-600/15 border border-green-600/40 rounded text-sm text-green-200"
        >
          Signed as <strong>{signResult.signer ?? '(unknown)'}</strong>
          {signResult.valid && signResult.intact && signResult.covers_whole_document
            ? ' — cryptographically valid, covers the whole document.'
            : ' — but the produced signature did not verify as expected.'}
          <div className="text-xs text-green-300/70 mt-0.5 truncate" title={signResult.output}>
            Saved to {signResult.output}
          </div>
        </div>
      )}
      {signError && !showSign && <div data-testid="sign-error" className="shrink-0 text-xs text-red-400">{signError}</div>}

      <StatusBar message={status} busy={busy} />
    </div>
  );
}

function SignatureCard({ sig }: { sig: SignatureEntry }): React.ReactElement {
  const status = classifySignature(sig);
  const cls = {
    invalid: 'bg-red-600/20 text-red-300 border-red-600/40',
    modified: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
    valid: 'bg-green-600/15 text-green-300 border-green-600/40',
  }[status];
  const badge = { text: SIGNATURE_STATUS_LABEL[status], cls };

  return (
    <div data-testid="signature-card" className="rounded border border-neutral-800 bg-neutral-900/50 p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span data-testid="signature-signer" className="text-sm text-neutral-200 font-medium truncate">
          {sig.signer ?? '(unknown signer)'}
        </span>
        <span className={`shrink-0 px-2 py-0.5 text-[11px] rounded border ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="text-xs text-neutral-500 flex flex-wrap gap-x-4 gap-y-0.5">
        {sig.field && <span>field: {sig.field}</span>}
        <span>
          integrity: {sig.intact ? 'intact' : 'BROKEN'}
          {' · '}
          {sig.covers_whole_document ? 'covers whole document' : 'does not cover whole document'}
        </span>
        {sig.digest_algorithm && <span>digest: {sig.digest_algorithm}</span>}
        {sig.signing_time && <span>claimed time: {sig.signing_time}</span>}
      </div>
      {sig.error && <div className="text-xs text-red-400">error: {sig.error}</div>}
    </div>
  );
}
