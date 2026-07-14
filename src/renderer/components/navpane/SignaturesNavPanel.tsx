import React, { useEffect, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import {
  classifySignature,
  SIGNATURE_STATUS_LABEL,
  type SignatureEntry,
  type VerifyResult,
} from '../../lib/signatures';
import type { NavPanelComponentProps } from './types';

// Signatures nav panel (Phase 4 M3.3b, § 5) — a compact READ view over the same
// verify_signatures data the Tools ▸ Signatures panel shows. The Tools panel is
// where you SIGN; this is the persistent status readout (Acrobat's split).
// Shares the verify types + the valid/modified/invalid classifier
// (lib/signatures) so the two surfaces can't disagree on validity.
//
// No jump-to-signature-page affordance, by design (not a stub): the app's own
// signatures are invisible — they cover the whole document and sit on no page —
// and a visible-signature page jump would need the widget's /P from the engine
// (M3 is renderer-only). Recorded as explicitly absent in the phase doc § 3.3.
//
// Auto-verifies on file identity change INCLUDING post-commit (fileKey folds in
// undoStack length), so editing a signed file and committing re-runs the check
// and the badge flips; Re-check re-runs it on demand. verify_signatures rides
// the commit gate (useEngine.call), so a pending edit is flushed to the working
// file before it's read.

export function SignaturesNavPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  const { call } = useEngine();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const fileKey = activeFile
    ? `${activeFile.path}#${activeFile.pageCount}#${activeFile.undoStack.length}`
    : null;

  useEffect(() => {
    const workingPath = activeFile?.workingPath;
    if (!workingPath) {
      setResult(null);
      setStatus('');
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setStatus('');
    setResult(null);
    call('verify_signatures', { file: workingPath })
      .then((res) => {
        if (!cancelled) setResult(res as unknown as VerifyResult);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true; // a mid-verify file switch must not land the old file's result
    };
    // fileKey encodes the identity; nonce is the manual Re-check trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, nonce, call]);

  if (!activeFile) {
    return (
      <div className="navpanel-empty" data-testid="signatures-nav-panel">
        No document open.
      </div>
    );
  }

  return (
    <div className="signatures-nav-panel flex flex-col h-full min-h-0" data-testid="signatures-nav-panel">
      <div className="navpanel-scroll flex-1">
        {busy && <p className="navpanel-empty">Verifying signatures…</p>}
        {!busy && status && (
          <p className="navpanel-empty signatures-nav-error" data-testid="signatures-nav-error">
            {status}
          </p>
        )}
        {!busy && !status && result && !result.signed && (
          <p className="navpanel-empty" data-testid="signatures-nav-empty">
            This PDF has no digital signatures.
          </p>
        )}
        {!busy && result && result.signed && (
          <>
            <div className="signatures-nav-count" data-testid="signatures-nav-count">
              {result.signature_count} signature{result.signature_count === 1 ? '' : 's'}
            </div>
            {result.signatures.map((sig, i) => (
              <SignatureRow key={sig.field ?? i} sig={sig} />
            ))}
            <div className="signatures-nav-caveat" data-testid="signatures-nav-caveat">
              Signer identity is <strong>not verified against a trusted authority</strong> — these
              results confirm cryptographic validity and whether the document changed after signing,
              not who the signer really is.
            </div>
          </>
        )}
      </div>
      <div className="signatures-nav-footer">
        <button
          data-testid="signatures-nav-recheck"
          onClick={() => setNonce((n) => n + 1)}
          disabled={busy}
          className="signatures-nav-recheck-btn"
        >
          Re-check
        </button>
      </div>
    </div>
  );
}

function SignatureRow({ sig }: { sig: SignatureEntry }): React.ReactElement {
  const status = classifySignature(sig);
  return (
    <div className="signature-nav-card" data-testid="signature-nav-card" data-status={status}>
      <div className="signature-nav-head">
        <span className={`signature-nav-dot signature-nav-dot-${status}`} aria-hidden />
        <span className="signature-nav-signer" data-testid="signature-nav-signer" title={sig.signer ?? ''}>
          {sig.signer ?? '(unknown signer)'}
        </span>
      </div>
      <div className="signature-nav-status" data-testid="signature-nav-status">
        {SIGNATURE_STATUS_LABEL[status]}
      </div>
      <div className="signature-nav-detail">
        {sig.intact ? 'integrity intact' : 'integrity BROKEN'}
        {' · '}
        {sig.covers_whole_document ? 'whole document' : 'partial coverage'}
      </div>
      {sig.field && <div className="signature-nav-detail">field: {sig.field}</div>}
      {sig.signing_time && <div className="signature-nav-detail">claimed time: {sig.signing_time}</div>}
      {sig.error && <div className="signature-nav-error">error: {sig.error}</div>}
    </div>
  );
}
