// The named consent for an operation that cannot keep a document's protection.
//
// Compress, Grayscale and Rebuild rewrite the document through a renderer
// subprocess, which cannot carry the source's encryption. The engine refuses
// by default; this dialog is the other half of that answer — it names the
// consequence in the user's own words (the protection is not kept, the copy
// that comes out is unprotected) and lets them proceed anyway.
//
// Cancel is the default focus: proceeding is the consequential choice, so a
// reflexive Enter must not take it (the ConfirmDialog 'proceed' precedent).
import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

interface EncryptionConsentDialogProps {
  open: boolean;
  /** True when the user chose to proceed, false on every dismissal. */
  onResult: (proceed: boolean) => void;
}

export function EncryptionConsentDialog({
  open,
  onResult,
}: EncryptionConsentDialogProps): React.ReactElement {
  useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onResult(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
        <Dialog.Content
          data-testid="encryption-consent-dialog"
          aria-label={tChrome('dialog.encryptionConsent.aria')}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[440px] max-w-[92vw] p-5"
          onEscapeKeyDown={() => onResult(false)}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-sm font-semibold text-neutral-100 mb-1">
            {tChrome('dialog.encryptionConsent.title')}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-400 mb-2">
            {tChrome('dialog.encryptionConsent.blurb')}
          </Dialog.Description>
          <p className="text-sm text-neutral-400 mb-5">
            {tChrome('dialog.encryptionConsent.consequence')}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="encryption-consent-cancel"
              onClick={() => onResult(false)}
              autoFocus
              className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
            >
              {tChrome('dialog.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="encryption-consent-proceed"
              onClick={() => onResult(true)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
            >
              {tChrome('dialog.encryptionConsent.proceed')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
