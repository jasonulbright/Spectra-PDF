import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

export type ConfirmResult = 'save' | 'discard' | 'cancel';

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  onResult: (result: ConfirmResult) => void;
  /** 'unsaved' (default): the 3-choice Save / Don't Save / Cancel dialog.
   * 'proceed': a 2-choice Continue / Cancel confirmation — 'save' doubles as
   * the affirmative result (one result type, one dialog, two shapes).
   * 'notice': a one-button OK notice (errors and outcomes with no choice to
   * make); resolves 'cancel' however dismissed. */
  kind?: 'unsaved' | 'proceed' | 'notice';
  /** Title override; defaults per kind. */
  title?: string;
}

export function ConfirmDialog({ open, message, onResult, kind = 'unsaved', title }: ConfirmDialogProps): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
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
            {title ?? tChrome(
              kind === 'proceed'
                ? 'dialog.confirm.titleProceed'
                : kind === 'notice'
                  ? 'dialog.confirm.titleNotice'
                  : 'dialog.confirm.titleUnsaved',
            )}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-400 mb-5" data-testid="confirm-message">
            {message}
          </Dialog.Description>
          {kind === 'notice' ? (
            <div className="flex justify-end">
              <button
                data-testid="notice-ok"
                onClick={() => onResult('cancel')}
                autoFocus
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
              >
                {tChrome('dialog.common.ok')}
              </button>
            </div>
          ) : (
          <div className="flex justify-end gap-2">
            {kind === 'unsaved' && (
              <button
                onClick={() => onResult('discard')}
                className="px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-800 hover:bg-neutral-700 rounded transition-colors"
              >
                {tChrome('dialog.confirm.dontSave')}
              </button>
            )}
            <button
              onClick={() => onResult('cancel')}
              className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
              autoFocus={kind === 'proceed'}
            >
              {tChrome('dialog.common.cancel')}
            </button>
            <button
              data-testid="confirm-affirm"
              onClick={() => onResult('save')}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
              // 'unsaved': Save is the data-PRESERVING default. 'proceed':
              // Continue is the CONSEQUENTIAL choice — a reflexive Enter must
              // not commit it, so focus starts on Cancel (review-caught).
              autoFocus={kind !== 'proceed'}
            >
              {tChrome(kind === 'proceed' ? 'dialog.confirm.continue' : 'dialog.common.save')}
            </button>
          </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
