import React from 'react';
import { useAppState } from '../state/AppStateProvider';
import { MAIN_TOOLBAR } from '../commands/toolbars';
import { COMMANDS, type CommandId } from '../commands/registry';
import { shortcutForCommand } from '../commands/keymap';
import { invokeCommand, isCommandEnabled } from '../commands/context';
import { ChromeIcon, type ChromeIconId } from './chrome-icons';

// The main toolbar (Phase 4 M2) — icon buttons driven by the command
// registry over commands/toolbars data. Enablement comes from each command's
// pure predicate; zoom/find self-disable off the document board (their
// commands need the canvas services), so no toolbar-side view gating.

const ICON_FOR: Record<CommandId, ChromeIconId> = {
  'file.open': 'open',
  'file.save': 'save',
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'view.zoomOut': 'zoomOut',
  'view.fit': 'fit',
  'view.zoomIn': 'zoomIn',
  'edit.find': 'find',
} as Record<CommandId, ChromeIconId>;

const TESTID_FOR: Partial<Record<CommandId, string>> = {
  'file.open': 'toolbar-open',
  'file.save': 'toolbar-save',
  'edit.undo': 'toolbar-undo',
  'edit.redo': 'toolbar-redo',
  'edit.find': 'toolbar-find',
};

function ToolbarButton({ command }: { command: CommandId }): React.ReactElement {
  const enabled = isCommandEnabled(command);
  const shortcut = shortcutForCommand(command);
  const title = shortcut ? `${COMMANDS[command].title} (${shortcut})` : COMMANDS[command].title;
  return (
    <button
      type="button"
      data-testid={TESTID_FOR[command]}
      disabled={!enabled}
      onClick={() => invokeCommand(command)}
      title={title}
      aria-label={COMMANDS[command].title}
      className="w-7 h-7 flex items-center justify-center rounded text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors"
    >
      <ChromeIcon icon={ICON_FOR[command]} />
    </button>
  );
}

export function MainToolbar(): React.ReactElement {
  useAppState(); // re-render on state change so enablement stays live
  return (
    <div
      data-testid="main-toolbar"
      className="app-shell-bar app-toolbar flex items-center gap-0.5 px-1.5 h-9 border-b border-neutral-800 shrink-0"
    >
      {MAIN_TOOLBAR.map((node, i) =>
        node.kind === 'separator' ? (
          <div key={i} className="w-px h-5 bg-neutral-700 mx-1" />
        ) : (
          <ToolbarButton key={i} command={node.command} />
        ),
      )}
    </div>
  );
}
