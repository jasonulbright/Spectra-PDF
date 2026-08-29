// The launch offer for a copy with no Ghostscript anywhere.
//
// Ghostscript is a user-supplied prerequisite: the distribution ships none.
// Every dependent surface names itself disabled (`GsRequiredNotice`), but a
// user who never opens one of those ten surfaces never learns that a program
// they can install is what stands between them and the feature — so the gap
// is stated once, at launch, on the primary window only.
//
// Nothing here is a warning: the product is fully usable without Ghostscript,
// and the copy says so rather than implying a broken install. Declining is a
// legitimate answer, and "Don't ask again" makes it permanent; Settings ▸
// Engine stays the always-open door either way.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome } from '../i18n';
import { openGsSetup, suppressGsLaunchPrompt } from '../lib/gs-capability';

interface GsMissingDialogProps {
  onClose: () => void;
}

export function GsMissingDialog({ onClose }: GsMissingDialogProps): React.ReactElement {
  useTranslation();
  const [dontAsk, setDontAsk] = React.useState(false);

  // The checkbox is honoured on EVERY exit — Cancel and Escape included. A
  // user who ticks it and then dismisses has answered the question the
  // checkbox asks, and re-asking at the next launch would ignore that answer.
  const dismiss = React.useCallback(
    (openSettings: boolean) => {
      if (dontAsk) suppressGsLaunchPrompt();
      onClose();
      if (openSettings) openGsSetup();
    },
    [dontAsk, onClose],
  );
  const shellRef = useAppModal(React.useCallback(() => dismiss(false), [dismiss]));

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      data-testid="gs-missing-dialog"
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.gsMissing.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[520px] max-w-[92vw] flex flex-col"
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold">{tChrome('dialog.gsMissing.title')}</h2>
          <p className="text-sm text-neutral-400 mt-2">{tChrome('dialog.gsMissing.blurb')}</p>
          <p className="text-sm text-neutral-400 mt-2">{tChrome('dialog.gsMissing.usedFor')}</p>
          <p className="text-sm text-neutral-400 mt-2">{tChrome('dialog.gsMissing.route')}</p>
        </div>

        <div className="px-5 pb-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="gs-missing-dont-ask"
              checked={dontAsk}
              onChange={() => setDontAsk((on) => !on)}
              className="rounded bg-neutral-800 border-neutral-700"
            />
            <span className="text-sm text-neutral-400">{tChrome('dialog.gsMissing.dontAsk')}</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 mt-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={() => dismiss(false)}
            data-testid="gs-missing-cancel"
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          >
            {tChrome('dialog.common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => dismiss(true)}
            autoFocus
            data-testid="gs-missing-ok"
            className="px-3 py-1 text-sm bg-accent hover:brightness-110 rounded font-medium text-[var(--accent-text)]"
          >
            {tChrome('dialog.common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
