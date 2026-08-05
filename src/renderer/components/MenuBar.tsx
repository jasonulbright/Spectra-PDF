import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useAppState } from '../state/AppStateProvider';
import { MENUS, type MenuNode } from '../commands/menus';
import { COMMANDS, type CommandId } from '../commands/registry';
import { shortcutForCommand } from '../commands/keymap';
import { getCommandContext, invokeCommand, isCommandEnabled } from '../commands/context';
import { useTranslation } from 'react-i18next';
import { tCommandTitle, tMenuLabel } from '../i18n';

// The workbench menu bar — rendered entirely from commands/menus
// data over the command registry. No handlers live here: a `command`
// node invokes its id; a `dynamic` node's leaves carry their own ad-hoc run
// (path-parameterized). Shortcuts are read from the keymap table via
// shortcutForCommand, so a label can never drift from its binding.

const itemCls =
  'flex items-center justify-between gap-6 px-2.5 py-1 text-[13px] rounded-sm cursor-default select-none ' +
  'text-neutral-200 outline-none data-[highlighted]:bg-blue-600 data-[highlighted]:text-white ' +
  'data-[disabled]:text-neutral-600 data-[disabled]:pointer-events-none';
const contentCls =
  'app-menu-content min-w-[200px] bg-neutral-800 border border-neutral-700 rounded-md shadow-2xl p-1 z-50';
const shortcutCls = 'text-[11px] text-neutral-500 data-[highlighted]:text-blue-100';

function Shortcut({ command }: { command: CommandId }): React.ReactElement | null {
  const s = shortcutForCommand(command);
  return s ? <span className={shortcutCls}>{s}</span> : null;
}

function renderNodes(nodes: MenuNode[]): React.ReactNode {
  return nodes.map((node, i) => {
    if (node.kind === 'separator') {
      return <Menubar.Separator key={i} className="h-px bg-neutral-700 my-1" />;
    }
    if (node.kind === 'command') {
      const cmd = COMMANDS[node.command];
      return (
        <Menubar.Item
          key={i}
          data-testid={node.testid}
          disabled={!isCommandEnabled(node.command)}
          // A real mouse press on a menu item would COLLAPSE the document's
          // text selection before onSelect runs (mousedown outside a selection
          // clears it) — which made Edit ▸ Copy copy nothing, ever, by mouse
          // (regression). Radix's own MenubarTrigger prevents its
          // pointerdown default for exactly this reason; items don't, so we
          // do. Keyboard activation never had the problem (synthetic click).
          onPointerDown={(e) => e.preventDefault()}
          onSelect={() => invokeCommand(node.command)}
          className={itemCls}
        >
          <span>{tCommandTitle(node.command, cmd.title)}</span>
          <Shortcut command={node.command} />
        </Menubar.Item>
      );
    }
    if (node.kind === 'submenu') {
      return (
        <Menubar.Sub key={i}>
          <Menubar.SubTrigger className={itemCls} data-testid={`submenu-${node.id}`}>
            <span>{tMenuLabel(node.id, node.label)}</span>
            <span className="text-[11px] text-neutral-500">▸</span>
          </Menubar.SubTrigger>
          <Menubar.Portal>
            <Menubar.SubContent className={contentCls} alignOffset={-4}>
              {renderNodes(node.items)}
            </Menubar.SubContent>
          </Menubar.Portal>
        </Menubar.Sub>
      );
    }
    // dynamic: resolve to ad-hoc action leaves against the live context.
    const ctx = getCommandContext();
    const leaves = ctx ? node.build(ctx) : [];
    return (
      <React.Fragment key={i}>
        {leaves.map((leaf, j) => (
          <Menubar.Item
            key={j}
            data-testid={leaf.testid}
            disabled={leaf.disabled}
            onPointerDown={(e) => e.preventDefault()}
            onSelect={() => {
              const c = getCommandContext();
              if (c) leaf.run(c);
            }}
            className={itemCls}
          >
            <span className="truncate max-w-[280px]">{leaf.label}</span>
          </Menubar.Item>
        ))}
      </React.Fragment>
    );
  });
}

export function MenuBar(): React.ReactElement {
  // Subscribe to state so enablement predicates + dynamic sections re-resolve.
  useAppState();
  // Re-render on language change (the hook's only job here — labels
  // resolve through tCommandTitle/tMenuLabel at render).
  useTranslation();
  // Menus also re-resolve on OPEN (native-menu semantics): an enablement
  // input that isn't app state — edit.copy reads the live DOM selection —
  // otherwise stays stale from the last app dispatch (regression).
  const [, bumpOnOpen] = React.useReducer((n: number) => n + 1, 0);
  return (
    <Menubar.Root
      data-testid="menubar"
      onValueChange={bumpOnOpen}
      className="app-shell-bar app-menubar flex items-center gap-0.5 px-1.5 h-8 border-b border-neutral-800 shrink-0 text-[13px]"
    >
      {MENUS.map((menu) => (
        <Menubar.Menu key={menu.id}>
          <Menubar.Trigger
            data-testid={`menu-${menu.id}`}
            className="px-2.5 py-1 rounded-sm text-neutral-300 outline-none cursor-default select-none data-[state=open]:bg-neutral-700 data-[state=open]:text-white hover:bg-neutral-700"
          >
            {tMenuLabel(menu.id, menu.label)}
          </Menubar.Trigger>
          <Menubar.Portal>
            <Menubar.Content className={contentCls} align="start" sideOffset={2}>
              {renderNodes(menu.items)}
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      ))}
    </Menubar.Root>
  );
}
