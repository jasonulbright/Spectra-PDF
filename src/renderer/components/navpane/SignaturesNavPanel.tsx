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
// Auto-verifies on the working file's BYTE identity (its buffer reference), so
// editing + committing a signed file flips the badge but a Save (which doesn't
// change the working bytes) doesn't re-run it; Re-check re-runs on demand.
// verify_signatures rides the commit gate (useEngine.call), so a pending edit is
// flushed to the working file before it's read. (Keying details on the effect.)

export function SignaturesNavPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  const { call } = useEngine();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Re-verify on the WORKING FILE's byte identity, not an edit counter. The
  // buffer reference is replaced on exactly the ops that rewrite the working
  // file: UPDATE_FILE / COMMIT_PAGE_EDITS through `applyFileUpdate`, and
  // UNDO / REDO through the `REFRESH_BUFFER` their handlers dispatch right after
  // (undo/redo themselves only move snapshot stacks). So editing a signed file
  // flips the badge; the buffer is UNCHANGED by Save (MARK_SAVED only clears
  // dirty/undoStack — the on-disk bytes are the same), so Save no longer
  // triggers a pointless re-verify (review-caught). `nonce` is the manual
  // Re-check trigger.
  //
  // Known, accepted: opening the panel while the active file has UNCOMMITTED
  // page edits verifies twice — verify runs the commit gate (useEngine.call),
  // which commits those edits and installs a new buffer, re-triggering this
  // effect once. It converges (the second pass' gate is a no-op) and the
  // cancelled-guard discards the first pass, so only the correct post-commit
  // result ever renders; the cost is one extra engine round-trip in that flow.
  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  useEffect(() => {
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
    // buffer is the byte-identity signal (see above); workingPath covers a
    // file switch that keeps the same buffer object identity (it can't, but the
    // dep is honest); nonce is Re-check.
  }, [workingPath, buffer, nonce, call]);

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
