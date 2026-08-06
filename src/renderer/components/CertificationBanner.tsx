import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  CERTIFICATION_LEVEL_LABEL,
  modificationLevelLabel,
  type VerifyResult,
} from '../lib/signatures';

// The document-level certification readout, shared by the Signatures tool
// panel and the nav-pane status panel. Both render the same verify result, so
// the wording and the violation treatment live in one place — the reason the
// status classifier does too.
//
// Certification is a DOCUMENT property (the catalog's /Perms /DocMDP), which is
// why it is a banner rather than a per-signature badge; which signature wrote
// it is reported on the card.

export function CertificationBanner({ result }: { result: VerifyResult }): React.ReactElement | null {
  useTranslation();
  const certification = result.certification;
  if (!certification) return null;

  if (!certification.certified) {
    // A certification that is present but unreadable is reported, never
    // silently rendered as an uncertified document.
    if (!certification.error) return null;
    return (
      <div className="certification-banner certification-banner-caveat" data-testid="certification-unreadable">
        {tChrome('panel.sig.certificationUnreadable', { message: certification.error })}
      </div>
    );
  }

  const author = result.signatures.find((s) => s.field === certification.field);
  const violations = result.signatures.filter((s) => s.policy_ok === false);
  const violated = violations.length > 0;

  return (
    <div
      className={`certification-banner ${violated ? 'certification-banner-violation' : 'certification-banner-ok'}`}
      data-testid="certification-banner"
      data-level={certification.level ?? 'unknown'}
      data-violated={violated ? 'true' : 'false'}
    >
      <div className="certification-banner-head" data-testid="certification-author">
        {tChrome('panel.sig.certifiedBy', {
          signer: author?.signer ?? tChrome('panel.sig.unknownSigner'),
        })}
      </div>
      <div className="certification-banner-level" data-testid="certification-level">
        {certification.level
          ? tChrome(CERTIFICATION_LEVEL_LABEL[certification.level])
          : tChrome('panel.sig.certifiedLevelUnknown')}
      </div>
      {violations.map((sig) => (
        <div
          className="certification-banner-violated"
          data-testid="certification-violation"
          key={sig.field ?? 'unnamed'}
        >
          {tChrome('panel.sig.certificationViolated', {
            field: sig.field ?? tChrome('panel.sig.unnamedField'),
            change: changeText(sig.modification_level),
          })}
        </div>
      ))}
    </div>
  );
}

/** The class of change, in words. An unreported or unrecognised level says so
 * rather than leaving the sentence with a hole in it. */
function changeText(modificationLevel: string | null | undefined): string {
  const key = modificationLevelLabel(modificationLevel);
  return key ? tChrome(key) : tChrome('panel.sig.changesUnknown');
}
