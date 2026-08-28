// The bundled colour profiles' end-user licence, presented in the app.
//
// The profiles ship under a bundling agreement that requires their Exhibit B
// end-user licence to be PRESENTED and accepted. The installed build obtains
// that through the installer's licence page — the bundler's `licenseFile`
// points at the same text file — so it never reaches here. A portable copy has
// no installer, so this is where the presentation happens, on first run and
// before any profile is read.
//
// **The text is READ, never restated.** It comes from
// `icc/Adobe-Color-Profile-License.txt` in the payload tree, which
// `bundle-icc.ps1` copies from the same source the installer's licence page is
// built from. Nothing in this file paraphrases it, and there is no second copy
// to drift.
//
// Declining is a legitimate answer that is RECORDED: the app stays fully
// running, the three profile-dependent surfaces name themselves disabled
// (`IccLicenceNotice`), and this dialog does not reappear on its own.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome } from '../i18n';
import { iccLicenseText, recordIccAssent } from '../lib/icc-assent';

interface IccLicenseDialogProps {
  onClose: () => void;
}

export function IccLicenseDialog({ onClose }: IccLicenseDialogProps): React.ReactElement {
  useTranslation();
  const shellRef = useAppModal(onClose);
  const [text, setText] = React.useState<string | null>(null);
  const [unreadable, setUnreadable] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    iccLicenseText()
      .then((body) => {
        if (!live) return;
        // An empty file is unreadable for this purpose: a licence that shows
        // nothing has not been presented, so it cannot be accepted.
        if (body.trim()) setText(body);
        else setUnreadable(true);
      })
      .catch(() => {
        if (live) setUnreadable(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const answer = React.useCallback(
    (accepted: boolean) => {
      setBusy(true);
      setFailure('');
      recordIccAssent(accepted)
        .then(() => onClose())
        .catch((error: unknown) => {
          setFailure(String(error));
          setBusy(false);
        });
    },
    [onClose],
  );

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      data-testid="icc-license-dialog"
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.iccLicense.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[640px] max-w-[92vw] flex flex-col"
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold">{tChrome('dialog.iccLicense.title')}</h2>
          <p className="text-xs text-neutral-400 mt-2">{tChrome('dialog.iccLicense.blurb')}</p>
        </div>

        <label className="sr-only" htmlFor="icc-license-text">
          {tChrome('dialog.iccLicense.textLabel')}
        </label>
        <textarea
          id="icc-license-text"
          data-testid="icc-license-text"
          readOnly
          value={unreadable ? tChrome('dialog.iccLicense.unreadable') : (text ?? tChrome('dialog.iccLicense.loading'))}
          className="mx-5 h-[46vh] resize-none rounded border border-neutral-700 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300"
        />

        <p className="px-5 pt-3 text-xs text-neutral-400">
          {tChrome('dialog.iccLicense.consequence')}
        </p>
        {failure ? (
          <p className="px-5 pt-2 text-xs text-amber-300" data-testid="icc-license-failure">
            {tChrome('dialog.iccLicense.recordFailed', { detail: failure })}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 px-5 py-3 mt-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={() => answer(false)}
            disabled={busy}
            data-testid="icc-license-decline"
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded font-medium"
          >
            {tChrome('dialog.iccLicense.decline')}
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            // Unreadable text cannot be accepted: acceptance of a licence
            // nobody was shown is not acceptance.
            disabled={busy || unreadable || text === null}
            data-testid="icc-license-accept"
            className="px-3 py-1 text-sm bg-accent hover:brightness-110 disabled:opacity-60 rounded font-medium text-[var(--accent-text)]"
          >
            {tChrome('dialog.iccLicense.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
