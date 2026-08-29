// The refuse → ask → re-run cycle for an operation that cannot keep a
// document's protection.
//
// One implementation for the three panels that share the seam (Compress,
// Grayscale, Rebuild): a second copy is how one of them ends up still
// surfacing the bare refusal. The panel passes a runner that takes the answer
// and builds its own parameters, so nothing here knows any op's arguments.
//
// The first attempt always runs WITHOUT consent. The dialog is raised by the
// engine's own refusal, never by a renderer-side guess about whether a
// document is encrypted — the engine is the authority on that, and asking
// first would put the question in front of users whose document the operation
// would have handled untouched.
import React from 'react';
import { EncryptionConsentDialog } from '../components/EncryptionConsentDialog';
import { isEncryptionConsentRefusal } from '../lib/encryption-consent';

/** The user's answer was Cancel: the operation did not run and nothing changed. */
export const CONSENT_DECLINED = Symbol('encryption-consent-declined');

export interface EncryptionConsent {
  /**
   * Run `attempt`, and on the consent-able encryption refusal ask the user
   * whether to proceed without the document's protection. Re-runs with the
   * answer, or returns `CONSENT_DECLINED` when it was Cancel. Every other
   * failure — including the refusals consent cannot answer — throws as it is.
   */
  readonly runWithConsent: <T>(
    attempt: (dropEncryption: boolean) => Promise<T>,
  ) => Promise<T | typeof CONSENT_DECLINED>;
  /** Render this inside the panel. */
  readonly consentDialog: React.ReactElement;
}

export function useEncryptionConsent(): EncryptionConsent {
  const [open, setOpen] = React.useState(false);
  // The pending question's resolver. A ref, not state: it is read once by the
  // dialog's answer and must not drive a render of its own.
  const answer = React.useRef<((proceed: boolean) => void) | null>(null);

  const onResult = React.useCallback((proceed: boolean) => {
    setOpen(false);
    const resolve = answer.current;
    answer.current = null;
    resolve?.(proceed);
  }, []);

  const runWithConsent = React.useCallback(
    async <T,>(
      attempt: (dropEncryption: boolean) => Promise<T>,
    ): Promise<T | typeof CONSENT_DECLINED> => {
      try {
        return await attempt(false);
      } catch (e: unknown) {
        if (!isEncryptionConsentRefusal(e)) throw e;
        const proceed = await new Promise<boolean>((resolve) => {
          answer.current = resolve;
          setOpen(true);
        });
        if (!proceed) return CONSENT_DECLINED;
        return await attempt(true);
      }
    },
    [],
  );

  return {
    runWithConsent,
    consentDialog: <EncryptionConsentDialog open={open} onResult={onResult} />,
  };
}
