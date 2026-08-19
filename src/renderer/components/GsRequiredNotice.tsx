// The ONE explanation every Ghostscript-gated surface renders.
//
// 25 surfaces gate on this prerequisite. One component rather than 25
// wordings: a disabled control that explains itself differently in the
// Compress panel and in the Print dialog is 25 chances to say something the
// product does not mean, and the set-up route would be re-invented in each.
// The affordance opens Settings ▸ Engine, which is where the answer changes.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { gsBlocked, gsStateKey, openGsSetup, type GsCapability } from '../lib/gs-capability';
import type { PanelKey } from '../i18n-panels';

export interface GsRequiredNoticeProps {
  capability: GsCapability;
  /** Distinguishes the notices in the e2e walk of the disabled surfaces. */
  testId?: string;
}

/**
 * Renders nothing while Ghostscript is usable — and nothing while the first
 * probe is still in flight, so a launch does not flash a refusal it may be
 * about to withdraw.
 */
export function GsRequiredNotice({ capability, testId }: GsRequiredNoticeProps): React.ReactElement | null {
  useTranslation();
  if (!gsBlocked(capability)) return null;
  const key = gsStateKey(capability) as PanelKey | null;
  return (
    <div
      className="px-3 py-2 rounded border border-amber-700/60 bg-amber-900/20 text-xs text-amber-200 flex flex-col gap-2"
      data-testid={testId ?? 'gs-required'}
      data-gs-reason={capability.reason}
      role="note"
    >
      <span>{tChrome(key ?? 'panel.common.gsRequired')}</span>
      <button
        type="button"
        className="self-start px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-100"
        onClick={openGsSetup}
        data-testid="gs-setup"
      >
        {tChrome('panel.common.gsSetUp')}
      </button>
    </div>
  );
}
