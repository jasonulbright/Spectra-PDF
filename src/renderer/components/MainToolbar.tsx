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
// commands need the canvas services), so no toolbar-side view gating. The
// glyph rides on the toolbar node (tsc-total by construction — no side map).

const TESTID_FOR: Partial<Record<CommandId, string>> = {
  'file.open': 'toolbar-open',
  'file.save': 'toolbar-save',
  'edit.undo': 'toolbar-undo',
  'edit.redo': 'toolbar-redo',
  'tools.hand': 'toolbar-hand',
  'tools.select': 'toolbar-select',
  'edit.find': 'toolbar-find',
};

function ToolbarButton({ command, icon, pressed }: { command: CommandId; icon: ChromeIconId; pressed?: boolean }): React.ReactElement {
  const enabled = isCommandEnabled(command);
  const shortcut = shortcutForCommand(command);
  const title = shortcut ? `${COMMANDS[command].title} (${shortcut})` : COMMANDS[command].title;
  return (
    <button
      type="button"
      data-testid={TESTID_FOR[command]}
      disabled={!enabled}
      aria-pressed={pressed}
      onClick={() => invokeCommand(command)}
      title={title}
      aria-label={COMMANDS[command].title}
      className={
        'w-7 h-7 flex items-center justify-center rounded text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors' +
        (pressed ? ' bg-neutral-700 text-white' : '')
      }
    >
      <ChromeIcon icon={icon} />
    </button>
  );
}

export function MainToolbar(): React.ReactElement {
  const state = useAppState(); // re-render on state change so enablement stays live
  // The Hand/Select pair are MODES (M6.2) — the armed one reads pressed, the
  // way Acrobat's own pair does. Select is "pressed" for any non-hand mode
  // only when nothing more specific is armed: an armed Highlight shows in the
  // secondary toolbar, not here.
  const pressedFor = (command: CommandId): boolean | undefined => {
    if (command === 'tools.hand') return state.ui.tool === 'hand';
    if (command === 'tools.select') return state.ui.tool === 'select';
    return undefined;
  };
  return (
    <div
      data-testid="main-toolbar"
      className="app-shell-bar app-toolbar flex items-center gap-0.5 px-1.5 h-9 border-b border-neutral-800 shrink-0"
    >
      {MAIN_TOOLBAR.map((node, i) =>
        node.kind === 'separator' ? (
          <div key={i} className="w-px h-5 bg-neutral-700 mx-1" />
        ) : (
          <ToolbarButton key={i} command={node.command} icon={node.icon} pressed={pressedFor(node.command)} />
        ),
      )}
    </div>
  );
}
