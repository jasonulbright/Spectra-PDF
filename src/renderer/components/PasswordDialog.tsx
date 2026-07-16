import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export type PasswordResult = { password: string } | 'cancel';

interface PasswordDialogProps {
  open: boolean;
  fileName: string;
  error?: string;
  onResult: (result: PasswordResult) => void;
}

export function PasswordDialog({ open, fileName, error, onResult }: PasswordDialogProps): React.ReactElement {
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (open) setPassword('');
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onResult({ password });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onResult('cancel'); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[400px] p-5"
          onEscapeKeyDown={() => onResult('cancel')}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-sm font-semibold text-neutral-100 mb-1">
            Password Required
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-400 mb-4">
            "{fileName}" is password-protected. Enter the password to open it.
          </Dialog.Description>
          <form onSubmit={handleSubmit}>
            <input
              data-testid="password-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoFocus
              className="w-full px-3 py-2 text-sm bg-neutral-800 border border-neutral-700 rounded text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 mb-2"
            />
            {error && (
              <p className="text-xs text-red-400 mb-2">{error}</p>
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
                data-testid="password-submit"
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
