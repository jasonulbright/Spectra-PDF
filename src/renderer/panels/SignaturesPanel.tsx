import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerSignHandler } from '../testHarness';

interface SignResult {
  output: string;
  field: string;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  covers_whole_document: boolean;
  signature_count: number;
}

interface SignatureEntry {
  field: string | null;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  trusted: boolean;
  coverage: string;
  covers_whole_document: boolean;
  modified_after_signing: boolean;
  digest_algorithm: string | null;
  signing_time: string | null;
  error?: string;
}

interface VerifyResult {
  signed: boolean;
  signature_count: number;
  signatures: SignatureEntry[];
  summary: { all_valid: boolean; any_modified_after_signing: boolean; trust_verified: boolean };
}

export function SignaturesPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Signing (produces a NEW file; the active file's working copy is untouched).
  const [showSign, setShowSign] = useState(false);
  const [pfxPath, setPfxPath] = useState<string | null>(null);
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
    setPfxPath(null);
    setSignResult(null);
    setSignError(null);
  }, [path]);

  const handlePickPfx = useCallback(async () => {
    const p = await dialog.pickCertificate();
    if (p) setPfxPath(p);
  }, []);

  // The core engine call, shared by the UI handler and the e2e harness hook
  // (native .pfx/save dialogs aren't WebDriver-drivable). No dialog / no state
  // — just paths in, self-verify summary out.
  const doSign = useCallback(
    async (
      pfx: string,
      pw: string,
      output: string,
      rsn?: string,
      loc?: string,
    ): Promise<SignResult> => {
      if (!activeFile) throw new Error('No active file to sign.');
      return (await call('sign_pdf', {
        file: activeFile.workingPath,
        output,
        pfx_path: pfx,
        password: pw,
        ...(rsn && rsn.trim() ? { reason: rsn.trim() } : {}),
        ...(loc && loc.trim() ? { location: loc.trim() } : {}),
      })) as unknown as SignResult;
    },
    [activeFile, call],
  );

  const handleSign = useCallback(async () => {
    if (!activeFile) return;
    if (!pfxPath) {
      setSignError('Choose a signer (.pfx) file first.');
      return;
    }
    if (!password) {
      setSignError('Enter the signer password.');
      return;
    }
    const suggested = activeFile.name.replace(/\.pdfx?$/i, '') + '-signed.pdf';
    const dest = await dialog.saveFile({ defaultPath: suggested });
    if (!dest) return; // cancelled
    setSigning(true);
    setSignError(null);
    setSignResult(null);
    try {
      const res = await doSign(pfxPath, password, dest, reason, location);
      setSignResult(res);
      setShowSign(false);
    } catch (e: unknown) {
      setSignError(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Clear the secret from component state regardless of outcome.
      setPassword('');
      setSigning(false);
    }
  }, [activeFile, pfxPath, password, reason, location, doSign]);

  // e2e-only: register the real sign call so the harness can drive it with
  // injected paths (the native dialogs can't be driven by WebDriver).
  const doSignRef = useRef(doSign);
  doSignRef.current = doSign;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerSignHandler({
      sign: (p) => doSignRef.current(p.pfxPath, p.password, p.output, p.reason, p.location),
    });
    return () => registerSignHandler(null);
  }, []);

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
            Applies an invisible signature and writes a new signed file — the current file is left
            unchanged. Any later edit to a signed file invalidates its signature.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Signer (.pfx)</span>
            <span
              data-testid="sign-pfx-path"
              className="flex-1 text-xs text-neutral-300 truncate"
              title={pfxPath ?? undefined}
            >
              {pfxPath ? pfxPath.split(/[\\/]/).pop() : <span className="text-neutral-600">none chosen</span>}
            </span>
            <button
              data-testid="sign-pick-pfx"
              onClick={() => void handlePickPfx()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Choose…
            </button>
          </div>
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
              data-testid="sign-apply"
              onClick={() => void handleSign()}
              disabled={signing}
              className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {signing ? 'Signing…' : 'Sign & Save…'}
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
  const ok = sig.valid && sig.intact;
  const badge = !ok
    ? { text: 'Invalid', cls: 'bg-red-600/20 text-red-300 border-red-600/40' }
    : sig.modified_after_signing
      ? { text: 'Valid — document changed after signing', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/40' }
      : { text: 'Cryptographically valid', cls: 'bg-green-600/15 text-green-300 border-green-600/40' };

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
