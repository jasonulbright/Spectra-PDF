// The security boundary for a form submission.
//
// A `/SubmitForm` action names a destination the DOCUMENT chose. Nothing is
// transmitted until a person reads that destination here and clicks Submit,
// and this dialog is the only surface in the app that can start an outbound
// form post. Three properties it exists to hold:
//
//   • **The address is shown WHOLE** — scheme included, no elision, no
//     shortening in the middle. A destination that is plain HTTP says so, in
//     its own line, because the address bar convention people have learned
//     does not exist here.
//   • **The payload is shown** — the exact bytes of the file that will be
//     sent, decoded as text where the format is text. A PDF submission is the
//     document itself and is summarized by size and field count rather than
//     rendered as mojibake; the summary says that it is a summary.
//   • **The answer is not remembered.** No per-host consent, no "always allow",
//     no auto-submit. The dialog opens from a user gesture on a widget and
//     closes with one decision that applies to one request.
//
// The third button, Save a copy, transmits nothing: it is the pre-transmit
// behaviour kept, so a submission can still be built and handed over by hand.

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome } from '../i18n';
import { isPlainHttp, type PayloadPreview } from '../lib/form-submit';
import type { SubmitFormat } from '../lib/field-actions';

export type SubmitConsentAnswer = 'submit' | 'save' | 'cancel';

interface SubmitConsentDialogProps {
  fieldName: string;
  url: string;
  format: SubmitFormat;
  preview: PayloadPreview;
  /** How many fields the payload carries — what a PDF submission is summarized
   * by, alongside its size. */
  fieldCount: number;
  onAnswer: (answer: SubmitConsentAnswer) => void;
}

const FORMAT_LABEL = {
  fdf: 'dialog.submitConsent.formatFdf',
  xfdf: 'dialog.submitConsent.formatXfdf',
  html: 'dialog.submitConsent.formatHtml',
  pdf: 'dialog.submitConsent.formatPdf',
} as const satisfies Record<SubmitFormat, string>;

export function SubmitConsentDialog({
  fieldName,
  url,
  format,
  preview,
  fieldCount,
  onAnswer,
}: SubmitConsentDialogProps): React.ReactElement {
  useTranslation();
  const shellRef = useAppModal(() => onAnswer('cancel'));
  const [busy, setBusy] = React.useState(false);

  const answer = React.useCallback(
    (choice: SubmitConsentAnswer) => {
      if (choice === 'submit') setBusy(true);
      onAnswer(choice);
    },
    [onAnswer],
  );

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      data-testid="submit-consent-dialog"
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.submitConsent.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[680px] max-w-[92vw] flex flex-col"
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold">{tChrome('dialog.submitConsent.title')}</h2>
          <p className="text-xs text-neutral-400 mt-2">
            {tChrome('dialog.submitConsent.blurb', { field: fieldName })}
          </p>
        </div>

        <div className="px-5">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">
            {tChrome('dialog.submitConsent.destinationLabel')}
          </div>
          {/* The whole address, wrapped rather than truncated: a destination
              that does not fit is exactly the one worth reading in full. */}
          <div
            data-testid="submit-consent-url"
            className="mt-1 rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-[12px] break-all text-neutral-200"
          >
            {url}
          </div>
          {isPlainHttp(url) ? (
            <p
              data-testid="submit-consent-http-warning"
              className="mt-2 text-xs text-amber-300"
            >
              {tChrome('dialog.submitConsent.plainHttp')}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-neutral-400">
            {tChrome('dialog.submitConsent.format', {
              format: tChrome(FORMAT_LABEL[format]),
            })}
          </p>
        </div>

        <div className="px-5 pt-3">
          <label className="text-[11px] uppercase tracking-wide text-neutral-500" htmlFor="submit-consent-payload">
            {tChrome('dialog.submitConsent.payloadLabel')}
          </label>
          {preview.kind === 'text' ? (
            <textarea
              id="submit-consent-payload"
              data-testid="submit-consent-payload"
              readOnly
              value={preview.text}
              className="mt-1 w-full h-[34vh] resize-none rounded border border-neutral-700 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300"
            />
          ) : (
            <p
              id="submit-consent-payload"
              data-testid="submit-consent-payload-summary"
              className="mt-1 rounded border border-neutral-700 bg-neutral-950 p-3 text-xs text-neutral-300"
            >
              {tChrome('dialog.submitConsent.documentSummary', {
                bytes: preview.bytes,
                count: fieldCount,
              })}
            </p>
          )}
        </div>

        <p className="px-5 pt-3 text-xs text-neutral-400">
          {tChrome('dialog.submitConsent.consequence')}
        </p>

        <div className="flex justify-end gap-2 px-5 py-3 mt-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={() => answer('save')}
            disabled={busy}
            data-testid="submit-consent-save"
            className="mr-auto px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
          >
            {tChrome('dialog.submitConsent.save')}
          </button>
          <button
            type="button"
            onClick={() => answer('cancel')}
            disabled={busy}
            data-testid="submit-consent-cancel"
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded font-medium"
          >
            {tChrome('dialog.submitConsent.cancel')}
          </button>
          <button
            type="button"
            onClick={() => answer('submit')}
            disabled={busy}
            data-testid="submit-consent-submit"
            className="px-3 py-1 text-sm bg-accent hover:brightness-110 disabled:opacity-50 rounded font-medium text-[var(--accent-text)]"
          >
            {tChrome('dialog.submitConsent.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
