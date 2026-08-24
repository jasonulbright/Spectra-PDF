// The ONE explanation every bundled-colour-profile surface renders.
//
// `GsRequiredNotice` is the model and the reason for the shape: a disabled
// control that explains itself differently in the Prepress panel and in the
// output preview is two chances to say something the product does not mean.
// The affordance re-opens the licence dialog, which is where the answer
// changes — a decline is recorded so the dialog stops appearing on its own,
// and this notice is how the user gets back to it.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { iccBlocked, openIccLicense, type IccAssentState } from '../lib/icc-assent';

export interface IccLicenceNoticeProps {
  state: IccAssentState;
  /** Distinguishes the notices in the e2e walk of the disabled surfaces. */
  testId?: string;
}

/**
 * Renders nothing while the profiles are usable — and nothing while the first
 * read is still in flight, so a launch does not flash a refusal it may be
 * about to withdraw.
 */
export function IccLicenceNotice({
  state,
  testId,
}: IccLicenceNoticeProps): React.ReactElement | null {
  useTranslation();
  if (!iccBlocked(state)) return null;
  return (
    <div
      className="px-3 py-2 rounded border border-amber-700/60 bg-amber-900/20 text-xs text-amber-200 flex flex-col gap-2"
      data-testid={testId ?? 'icc-licence-required'}
      data-icc-assent={state.assent}
      role="note"
    >
      <span>{tChrome('panel.common.iccLicenceRequired')}</span>
      <button
        type="button"
        className="self-start px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-100"
        onClick={openIccLicense}
        data-testid="icc-licence-review"
      >
        {tChrome('panel.common.iccLicenceReview')}
      </button>
    </div>
  );
}
