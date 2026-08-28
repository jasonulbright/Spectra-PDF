import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome, tCommandTitle, tToolbarGroup } from '../i18n';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { TOOLBAR_CATALOG } from '../commands/toolbars';
import { COMMANDS } from '../commands/registry';
import { ChromeIcon } from './chrome-icons';
import {
  NO_OVERRIDES,
  isToolbarItemVisible,
  withToolbarVisibility,
} from '../lib/toolbar-layout';

// Toolbar customization changes item visibility while preserving order and
// groups. Checkboxes apply
// LIVE (the toolbar renders the same ui.toolbarOverrides), Reset returns to
// the shipped default, and App persists the overrides to localStorage.

interface CustomizeToolbarDialogProps {
  onClose: () => void;
}

export function CustomizeToolbarDialog({ onClose }: CustomizeToolbarDialogProps): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const overrides = state.ui.toolbarOverrides;
  const shellRef = useAppModal(onClose);
  const isDefault = overrides.shown.length === 0 && overrides.hidden.length === 0;
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
      data-testid="customize-toolbar-dialog"
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.customize.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[420px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-lg font-semibold">{tChrome('dialog.customize.title')}</h2>
          <p className="text-xs text-neutral-500 mt-1">
            {tChrome('dialog.customize.blurb')}
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2 flex flex-col gap-3">
          {TOOLBAR_CATALOG.map((group) => (
            <div key={group.id}>
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
                {tToolbarGroup(group.id, group.label)}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const visible = isToolbarItemVisible(item.command, item.byDefault, overrides);
                  return (
                    <label
                      key={item.command}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        data-testid={`customize-item-${item.command}`}
                        checked={visible}
                        onChange={(e) =>
                          dispatch({
                            type: 'UI_SET_TOOLBAR_OVERRIDES',
                            overrides: withToolbarVisibility(
                              overrides,
                              item.command,
                              item.byDefault,
                              e.target.checked,
                            ),
                          })
                        }
                        className="rounded bg-neutral-800 border-neutral-700"
                      />
                      <span className="w-5 h-5 flex items-center justify-center text-neutral-400">
                        <ChromeIcon icon={item.icon} />
                      </span>
                      <span className="text-sm text-neutral-200">
                        {tCommandTitle(item.command, COMMANDS[item.command].title)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center px-5 py-3 border-t border-neutral-800">
          <button
            data-testid="customize-toolbar-reset"
            onClick={() => dispatch({ type: 'UI_SET_TOOLBAR_OVERRIDES', overrides: NO_OVERRIDES })}
            disabled={isDefault}
            className="px-3 py-1 text-sm bg-neutral-800 hover:bg-neutral-700 disabled:opacity-60 rounded"
          >
            {tChrome('dialog.customize.reset')}
          </button>
          <div className="flex-1" />
          <button
            data-testid="customize-toolbar-close"
            onClick={onClose}
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
