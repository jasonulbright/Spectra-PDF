import React from 'react';
import { invokeCommand } from '../commands/context';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

// A panel operates on the open document; the same operation over a whole tree
// is an ACTION, and the two surfaces had nothing pointing at each other. This
// is that pointer — a sentence and the command that opens the wizard, not a
// second way to run the operation.

export function FolderRouteHint(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  return (
    <p className="text-xs text-neutral-500 max-w-md" data-testid="folder-route-hint">
      {tChrome('panel.common.folderRouteHint')}{' '}
      <button
        type="button"
        data-testid="folder-route-open"
        onClick={() => invokeCommand('tools.open.actions')}
        className="link-action"
      >
        {tChrome('panel.common.folderRouteOpen')}
      </button>
    </p>
  );
}
