import React, { useEffect, useState } from 'react';
import { useEngine } from '../../hooks/useEngine';
import {
  classifySignature,
  LOCK_ACTION_LABEL,
  policyVerdict,
  POLICY_VERDICT_LABEL,
  signatureKind,
  SIGNATURE_KIND_LABEL,
  SIGNATURE_STATUS_LABEL,
  type SignatureEntry,
  type VerifyResult,
} from '../../lib/signatures';
import {
  loadTrustConfig,
  trustSummary,
  trustVerifyParams,
  type TrustConfig,
} from '../../lib/trust-store';
import { CertificationBanner } from '../CertificationBanner';
import type { NavPanelComponentProps } from './types';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../../i18n';

// Signatures nav panel — a compact READ view over the same
// verify_signatures data the Tools ▸ Signatures panel shows. The Tools panel is
// where signing occurs; this panel is the persistent status readout.
// Shares the verify types + the valid/modified/invalid classifier
// (lib/signatures) so the two surfaces can't disagree on validity.
//
// No jump-to-signature-page affordance, by design (not a stub): the app's own
// signatures are invisible — they cover the whole document and sit on no page —
// and a visible-signature page jump would need the widget's /P from the engine
// (is renderer-only). Explicitly absent, not overlooked.
//
// Verifies under the SAME trust configuration the signing panel uses
// (lib/trust-store). Reading it here is what stops one surface calling a
// document trusted while this one still shows the never-verified caveat.
//
// Auto-verifies on the working file's BYTE identity (its buffer reference), so
// editing + committing a signed file flips the badge but a Save (which doesn't
// change the working bytes) doesn't re-run it; Re-check re-runs on demand.
// verify_signatures rides the commit gate (useEngine.call), so a pending edit is
// flushed to the working file before it's read. (Keying details on the effect.)

export function SignaturesNavPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
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
  // triggers a pointless re-verify (regression). `nonce` is the manual
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
  // Re-read on every verification rather than caching at mount: the
  // configuration is edited in the signing panel, so a copy taken at mount
  // would describe a verification that used different anchors.
  const [trust, setTrust] = useState(loadTrustConfig);
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
    const config = loadTrustConfig();
    setTrust(config);
    call('verify_signatures', { file: workingPath, ...trustVerifyParams(config) })
      .then((res) => {
        if (!cancelled) setResult(res as unknown as VerifyResult);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setStatus(
            tChrome('panel.common.error', {
              message: e instanceof Error ? e.message : String(e),
            }),
          );
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
        {tChrome('nav.common.noDocument')}
      </div>
    );
  }

  return (
    <div className="signatures-nav-panel flex flex-col h-full min-h-0" data-testid="signatures-nav-panel">
      <div className="navpanel-scroll flex-1">
        {busy && <p className="navpanel-empty">{tChrome('nav.sig.verifying')}</p>}
        {!busy && status && (
          <p className="navpanel-empty signatures-nav-error" data-testid="signatures-nav-error">
            {status}
          </p>
        )}
        {!busy && !status && result && !result.signed && (
          <p className="navpanel-empty" data-testid="signatures-nav-empty">
            {tChrome('nav.sig.none')}
          </p>
        )}
        {!busy && result && result.signed && (
          <>
            <div className="signatures-nav-count" data-testid="signatures-nav-count">
              {tChromeCount('nav.sig.count', result.signature_count)}
            </div>
            <CertificationBanner result={result} />
            {result.signatures.map((sig, i) => (
              <SignatureRow
                key={sig.field ?? i}
                sig={sig}
                certified={result.certification?.certified === true}
              />
            ))}
            <TrustLine trust={trust} result={result} />
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
          {tChrome('nav.sig.recheck')}
        </button>
      </div>
    </div>
  );
}

/** The trust footer. With no trust source configured this is the standing
 * identity caveat; with one, it reports whether the chains reached it. Keeps
 * the caveat's testid in the no-source case, which is what it describes. */
function TrustLine({
  trust,
  result,
}: {
  trust: TrustConfig;
  result: VerifyResult;
}): React.ReactElement {
  const summary = trustSummary(trust, result);
  if (summary === 'none') {
    return (
      <div className="signatures-nav-caveat" data-testid="signatures-nav-caveat">
        {tChrome('nav.sig.caveat')}
      </div>
    );
  }
  return (
    <div
      className="signatures-nav-caveat"
      data-testid="signatures-nav-trust"
      data-trust={summary}
    >
      {summary === 'failed' ? tChrome('nav.sig.trustFailed') : tChrome('nav.sig.trustVerified')}
    </div>
  );
}

function SignatureRow({
  sig,
  certified,
}: {
  sig: SignatureEntry;
  // The policy line is meaningless on a document that states no policy, so it
  // is rendered only where there is one to be within or outside of.
  certified: boolean;
}): React.ReactElement {
  const status = classifySignature(sig);
  // Kind and policy are the second axis: shown BESIDE the status, never
  // instead of it — a certification signature can be valid, modified or
  // invalid exactly like an approval one.
  const kind = signatureKind(sig);
  const verdict = policyVerdict(sig);
  return (
    <div
      className="signature-nav-card"
      data-testid="signature-nav-card"
      data-status={status}
      data-kind={kind}
      data-policy={verdict}
    >
      <div className="signature-nav-head">
        <span className={`signature-nav-dot signature-nav-dot-${status}`} aria-hidden />
        <span className="signature-nav-signer" data-testid="signature-nav-signer" title={sig.signer ?? ''}>
          {sig.signer ?? tChrome('nav.sig.unknownSigner')}
        </span>
      </div>
      {kind === 'certification' && (
        <div className="signature-nav-kind" data-testid="signature-nav-kind">
          {tChrome(SIGNATURE_KIND_LABEL.certification)}
        </div>
      )}
      <div className="signature-nav-status" data-testid="signature-nav-status">
        {tChrome(SIGNATURE_STATUS_LABEL[status])}
      </div>
      {certified && verdict !== 'within-policy' && (
        <div
          className={`signature-nav-policy${verdict === 'unjudged' ? ' signature-nav-policy-unjudged' : ''}`}
          data-testid="signature-nav-policy"
        >
          {tChrome(POLICY_VERDICT_LABEL[verdict])}
        </div>
      )}
      {/* The field lock is a third fact beside validity and the policy verdict,
          and it is rendered HERE as well as on the tools panel: a persistent
          readout that omits what the other surface shows is two answers to one
          question. Both read the same label maps. */}
      {sig.lock && (
        <div
          className="signature-nav-detail"
          data-testid="signature-nav-lock"
          data-lock-action={sig.lock.action}
        >
          {tChrome(LOCK_ACTION_LABEL[sig.lock.action], { fields: sig.lock.fields.join(', ') })}
        </div>
      )}
      {sig.lock_violation && (
        <div className="signature-nav-policy" data-testid="signature-nav-lock-violation">
          {tChrome('panel.sig.lockViolated', {
            field: sig.field ?? tChrome('nav.sig.unknownSigner'),
            fields: sig.lock_violation.fields.join(', '),
          })}
        </div>
      )}
      <div className="signature-nav-detail">
        {/* One key, two finished clauses: the separator's placement is part of
            the sentence, so it lives in the catalog and not in JSX. */}
        {tChrome('nav.sig.detail', {
          integrity: sig.intact ? tChrome('nav.sig.intact') : tChrome('nav.sig.broken'),
          coverage: sig.covers_whole_document
            ? tChrome('nav.sig.wholeDocument')
            : tChrome('nav.sig.partialCoverage'),
        })}
      </div>
      {sig.field && (
        <div className="signature-nav-detail">
          {tChrome('nav.sig.field', { field: sig.field })}
        </div>
      )}
      {sig.signing_time && (
        <div className="signature-nav-detail">
          {tChrome('nav.sig.claimedTime', { time: sig.signing_time })}
        </div>
      )}
      {sig.error && (
        <div className="signature-nav-error">{tChrome('nav.sig.error', { error: sig.error })}</div>
      )}
    </div>
  );
}
