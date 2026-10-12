import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome, type UiKey } from '../i18n';
import {
  audiverisBlocked,
  audiverisStateKey,
  openAudiverisSetup,
  AUDIVERIS_MINIMUM_VERSION,
  type AudiverisStatus,
} from '../lib/audiveris-status';

/** Renders nothing while Audiveris is usable, and nothing while the first
 * answer is still pending. */
export function AudiverisRequiredNotice({ status }: { status: AudiverisStatus }): React.ReactElement | null {
  useTranslation();
  if (!audiverisBlocked(status)) return null;
  const key = (audiverisStateKey(status) ?? 'panel.common.audiverisRequired') as UiKey;
  return (
    <div
      className="px-3 py-2 rounded border border-amber-700/60 bg-amber-900/20 text-xs text-amber-200 flex flex-col gap-2"
      data-testid="audiveris-required"
      data-audiveris-kind={status.kind}
      role="note"
    >
      <span>{tChrome(key, { version: AUDIVERIS_MINIMUM_VERSION })}</span>
      <button
        type="button"
        className="self-start px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-100"
        onClick={openAudiverisSetup}
        data-testid="audiveris-setup"
      >
        {tChrome('panel.common.audiverisSetUp')}
      </button>
    </div>
  );
}
