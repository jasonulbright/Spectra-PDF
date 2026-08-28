import React, { useRef, useState } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { visibleToolbarNodes, type ToolbarNode } from '../commands/toolbars';
import { COMMANDS, type CommandId } from '../commands/registry';
import { shortcutForCommand } from '../commands/keymap';
import { invokeCommand, isCommandEnabled } from '../commands/context';
import { ChromeIcon, type ChromeIconId } from './chrome-icons';
import { useTranslation } from 'react-i18next';
import { tChrome, tCommandTitle } from '../i18n';
import { ContextMenu } from './ContextMenu';
import { OmniSearch } from './OmniSearch';

// The main toolbar — icon buttons driven by the command
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
  'view.navPanel.pages': 'toolbar-nav-pages',
  'view.navPanel.bookmarks': 'toolbar-nav-bookmarks',
  'view.navPanel.attachments': 'toolbar-nav-attachments',
  'view.navPanel.layers': 'toolbar-nav-layers',
  'view.navPanel.tags': 'toolbar-nav-tags',
  'view.navPanel.signatures': 'toolbar-nav-signatures',
  'view.toolsPane': 'toolbar-tools-pane',
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
  const cmdTitle = tCommandTitle(command, COMMANDS[command].title);
  const title = shortcut
    ? tChrome('chrome.toolbar.titleWithShortcut', { title: cmdTitle, shortcut })
    : cmdTitle;
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
      aria-label={cmdTitle}
      className={
        'w-7 h-7 flex items-center justify-center rounded text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:opacity-60 disabled:pointer-events-none transition-colors' +
        (pressed ? ' bg-neutral-700 text-white' : '')
      }
    >
      <ChromeIcon icon={icon} />
    </button>
  );
}

export function MainToolbar(): React.ReactElement {
  // Re-render on language change; labels resolve via tChrome/tCommandTitle.
  useTranslation();
  const state = useAppState(); // re-render on state change so enablement stays live
  // Hand and Select are modes, so the armed one reads pressed. Select is
  // pressed for any non-hand mode
  // only when nothing more specific is armed: an armed Highlight shows in the
  // secondary toolbar, not here.
  const pressedFor = (command: CommandId): boolean | undefined => {
    if (command === 'tools.hand') return state.ui.tool === 'hand';
    if (command === 'tools.select') return state.ui.tool === 'select';
    return undefined;
  };
  // The rendered layout: the catalog filtered by the user's show/hide
  // overrides (I.6 toolbar customization) — reactive, so the customize
  // dialog's checkboxes apply live.
  const nodes = visibleToolbarNodes(state.ui.toolbarOverrides);
  // Right-click anywhere on the strip opens the customize entry point.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // Roving tabindex: the toolbar is ONE Tab stop; arrows move
  // within it, skipping disabled buttons. The roving index follows real focus
  // (mouse clicks included), so Tab always leaves from where the user was.
  const buttons = nodes.filter(
    (n): n is Extract<ToolbarNode, { kind: 'command' }> => n.kind === 'command',
  );
  const [rovingIdx, setRovingIdx] = useState(0);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The roving index is a FOCUS memory, not a truth about tabbability: the
  // remembered button can be DISABLED by state it doesn't control (Save
  // after saving, Undo at the bottom of its stack) — and a disabled button
  // is excluded from Tab regardless of tabIndex, which left the whole
  // toolbar Tab-unreachable (regression). The tab stop is re-derived
  // against live enablement every render.
  // (Customization can SHRINK the list, so the remembered index may now be
  // past the end — an out-of-range command must read as "not enabled", not
  // crash the lookup.)
  const rovingCommand = buttons[rovingIdx]?.command;
  const effectiveIdx = rovingCommand !== undefined && isCommandEnabled(rovingCommand)
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
      aria-label={tChrome('chrome.toolbar.mainLabel')}
      onKeyDown={onToolbarKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      className="app-shell-bar app-toolbar flex items-center gap-0.5 px-1.5 h-9 border-b border-neutral-800 shrink-0"
    >
      {nodes.map((node, i) => {
        if (node.kind === 'separator') {
          return <div key={i} className="chrome-divider w-px h-5 bg-neutral-700 mx-1" />;
        }
        commandIdx += 1;
        const idx = commandIdx;
        return (
          <ToolbarButton
            key={node.command}
            command={node.command}
            icon={node.icon}
            pressed={pressedFor(node.command)}
            tabbable={idx === effectiveIdx}
            buttonRef={(el) => { buttonRefs.current[idx] = el; }}
            onFocus={() => setRovingIdx(idx)}
          />
        );
      })}
      {/* The universal search box lives in this row, pushed right — it is
          fixed chrome, NOT a catalog item, because the customizable catalog is
          a set of glyph buttons and a text field is not one of those. */}
      <div className="ms-auto ps-2">
        <OmniSearch />
      </div>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={[
            {
              label: tChrome('chrome.toolbar.customize'),
              onClick: () => invokeCommand('view.customizeToolbar'),
            },
          ]}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}
