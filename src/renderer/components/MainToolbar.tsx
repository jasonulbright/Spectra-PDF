import React, { useRef, useState } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { MAIN_TOOLBAR, type ToolbarNode } from '../commands/toolbars';
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

function ToolbarButton({
  command,
  icon,
  pressed,
  tabbable,
  buttonRef,
  onFocus,
}: {
  command: CommandId;
  icon: ChromeIconId;
  pressed?: boolean;
  tabbable: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
}): React.ReactElement {
  const enabled = isCommandEnabled(command);
  const shortcut = shortcutForCommand(command);
  const title = shortcut ? `${COMMANDS[command].title} (${shortcut})` : COMMANDS[command].title;
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid={TESTID_FOR[command]}
      disabled={!enabled}
      aria-pressed={pressed}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
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
  // Roving tabindex (§ 10.5, M6.5): the toolbar is ONE Tab stop; arrows move
  // within it, skipping disabled buttons. The roving index follows real focus
  // (mouse clicks included), so Tab always leaves from where the user was.
  const buttons = MAIN_TOOLBAR.filter(
    (n): n is Extract<ToolbarNode, { kind: 'command' }> => n.kind === 'command',
  );
  const [rovingIdx, setRovingIdx] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The roving index is a FOCUS memory, not a truth about tabbability: the
  // remembered button can be DISABLED by state it doesn't control (Save
  // after saving, Undo at the bottom of its stack) — and a disabled button
  // is excluded from Tab regardless of tabIndex, which left the whole
  // toolbar Tab-unreachable (review-caught). The tab stop is re-derived
  // against live enablement every render.
  const effectiveIdx = isCommandEnabled(buttons[rovingIdx]?.command)
    ? rovingIdx
    : buttons.findIndex((b) => isCommandEnabled(b.command));
  const moveFocus = (from: number, delta: 1 | -1 | 'home' | 'end'): void => {
    const enabled = (i: number): boolean => !!buttonRefs.current[i] && !buttonRefs.current[i]!.disabled;
    let target = -1;
    if (delta === 'home') target = buttons.findIndex((_, i) => enabled(i));
    else if (delta === 'end') {
      for (let i = buttons.length - 1; i >= 0; i--) if (enabled(i)) { target = i; break; }
    } else {
      for (let i = from + delta; i >= 0 && i < buttons.length; i += delta) {
        if (enabled(i)) { target = i; break; }
      }
    }
    if (target === -1) return;
    setRovingIdx(target);
    buttonRefs.current[target]?.focus();
  };
  const onToolbarKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus(rovingIdx, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(rovingIdx, -1); }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(rovingIdx, 'home'); }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(rovingIdx, 'end'); }
  };
  let commandIdx = -1;
  return (
    <div
      data-testid="main-toolbar"
      role="toolbar"
      aria-label="Main toolbar"
      onKeyDown={onToolbarKeyDown}
      className="app-shell-bar app-toolbar flex items-center gap-0.5 px-1.5 h-9 border-b border-neutral-800 shrink-0"
    >
      {MAIN_TOOLBAR.map((node, i) => {
        if (node.kind === 'separator') {
          return <div key={i} className="w-px h-5 bg-neutral-700 mx-1" />;
        }
        commandIdx += 1;
        const idx = commandIdx;
        return (
          <ToolbarButton
            key={i}
            command={node.command}
            icon={node.icon}
            pressed={pressedFor(node.command)}
            tabbable={idx === effectiveIdx}
            buttonRef={(el) => { buttonRefs.current[idx] = el; }}
            onFocus={() => setRovingIdx(idx)}
          />
        );
      })}
    </div>
  );
}
