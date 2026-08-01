import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { dialog } from '../lib/tauri-bridge';

/** F9: unlocking a certificate-encrypted (Adobe.PubSec) file — the pubkey
 * sibling of PasswordDialog. The user picks their PKCS#12 key bundle and
 * enters ITS password (the .pfx password, not a document password). */
export type CertUnlockResult = { pfx: string; password: string } | 'cancel';

interface CertUnlockDialogProps {
  open: boolean;
  fileName: string;
  error?: string;
  onResult: (result: CertUnlockResult) => void;
}

export function CertUnlockDialog({
  open,
  fileName,
  error,
  onResult,
}: CertUnlockDialogProps): React.ReactElement {
  const [pfx, setPfx] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Keep the picked key across a wrong-password retry; clear the rest.
      setPassword('');
      setLocalError(null);
    }
  }, [open, error]);

  const pickPfx = async (): Promise<void> => {
    const p = await dialog.pickCertificate();
    if (p) {
      setPfx(p);
      setLocalError(null);
    }
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!pfx) {
      setLocalError('Choose your key file (.pfx / .p12) first.');
      return;
    }
    onResult({ pfx, password });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onResult('cancel'); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[440px] p-5"
          onEscapeKeyDown={() => onResult('cancel')}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-sm font-semibold text-neutral-100 mb-1">
            Certificate Required
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-400 mb-4">
            "{fileName}" is encrypted to certificate recipients. Open it with
            your key file (.pfx / .p12) and that file's password.
          </Dialog.Description>
          <form onSubmit={handleSubmit}>
            <div className="flex items-center gap-2 mb-2">
              <button
                data-testid="certunlock-pick"
                type="button"
                onClick={() => void pickPfx()}
                className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors shrink-0"
              >
                Choose key file…
              </button>
              <span className="text-xs text-neutral-400 truncate" title={pfx ?? undefined}>
                {pfx ? pfx.split(/[\\/]/).pop() : 'No key file chosen'}
              </span>
            </div>
            <input
              data-testid="certunlock-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Key file password"
              autoFocus
              className="w-full px-3 py-2 text-sm bg-neutral-800 border border-neutral-700 rounded text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 mb-2"
            />
            {(localError ?? error) && (
              <p className="text-xs text-red-400 mb-2">{localError ?? error}</p>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                onClick={() => onResult('cancel')}
                className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="certunlock-submit"
                type="submit"
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
              >
                Open
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
