import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

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
