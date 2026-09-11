// The question belongs to one operation and one exact document revision.
// Disposing cancels a pending question, never an already dispatched write.
import React from 'react';
import { EncryptionConsentDialog } from '../components/EncryptionConsentDialog';
import { isEncryptionConsentRefusal } from '../lib/encryption-consent';
import { useActiveFile } from './useActiveFile';
import { useAppState } from '../state/AppStateProvider';
import {
  createEncryptionConsentCoordinator, CONSENT_ABANDONED, CONSENT_BUSY, CONSENT_DECLINED,
  type ConsentOutcome, type EncryptionConsentCoordinator,
} from '../lib/encryption-consent-coordinator';

export { CONSENT_DECLINED };
export function consentStopped(value: unknown): value is ConsentOutcome {
  return value === CONSENT_DECLINED || value === CONSENT_BUSY || value === CONSENT_ABANDONED;
}
export interface EncryptionConsent {
  readonly runWithConsent: <T>(attempt: (dropEncryption: boolean) => Promise<T>,
    owner: { isCurrent: () => boolean; subject: string }) => Promise<T | ConsentOutcome>;
  readonly consentDialog: React.ReactElement;
}
export function useEncryptionConsent(): EncryptionConsent {
  const { activeFile } = useActiveFile();
  const { pageDirtyPaths } = useAppState();
  const coordinator = React.useRef<EncryptionConsentCoordinator | null>(null);
  const ownerCheck = React.useRef<(() => boolean) | null>(null);
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    // StrictMode setup-cleanup-setup must not revive a disposed coordinator.
    const instance = createEncryptionConsentCoordinator(isEncryptionConsentRefusal);
    coordinator.current = instance;
    const detach = instance.subscribe(() => redraw());
    redraw();
    return () => {
      detach(); instance.dispose();
      if (coordinator.current === instance) coordinator.current = null;
    };
  }, []);
  React.useEffect(() => {
    if (ownerCheck.current && !ownerCheck.current()) coordinator.current?.invalidate();
  }, [activeFile, pageDirtyPaths]);
  const runWithConsent = React.useCallback(async <T,>(
    attempt: (dropEncryption: boolean) => Promise<T>,
    owner: { isCurrent: () => boolean; subject: string },
  ): Promise<T | ConsentOutcome> => {
    const instance = coordinator.current;
    if (!instance) return CONSENT_ABANDONED;
    if (!instance.isBusy()) ownerCheck.current = owner.isCurrent;
    return instance.run({ attempt, ...owner });
  }, []);
  // Capture the actual coordinator as well as its ticket. Tickets are only
  // unique within an instance, and a StrictMode remount starts a new instance.
  const instance = coordinator.current, prompt = instance?.prompt();
  return {
    runWithConsent,
    consentDialog: <EncryptionConsentDialog open={!!prompt}
      subject={typeof prompt?.subject === 'string' ? prompt.subject : undefined}
      onResult={proceed => { if (instance && prompt) instance.answer(prompt.ticket, proceed); }} />,
  };
}
