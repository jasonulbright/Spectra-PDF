import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useAppState } from '../state/AppStateProvider';
import { MENUS, type MenuNode } from '../commands/menus';
import { COMMANDS, type CommandId } from '../commands/registry';
import { shortcutForCommand } from '../commands/keymap';
import { getCommandContext, invokeCommand, isCommandEnabled } from '../commands/context';

// The workbench menu bar (Phase 4 M2) — rendered entirely from commands/menus
// data over the command registry (§ 4.1). No handlers live here: a `command`
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
          onSelect={() => invokeCommand(node.command)}
          className={itemCls}
        >
          <span>{cmd.title}</span>
          <Shortcut command={node.command} />
        </Menubar.Item>
      );
    }
    if (node.kind === 'submenu') {
      return (
        <Menubar.Sub key={i}>
          <Menubar.SubTrigger className={itemCls}>
            <span>{node.label}</span>
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
  return (
    <Menubar.Root
      data-testid="menubar"
      className="app-shell-bar app-menubar flex items-center gap-0.5 px-1.5 h-8 border-b border-neutral-800 shrink-0 text-[13px]"
    >
      {MENUS.map((menu) => (
        <Menubar.Menu key={menu.id}>
          <Menubar.Trigger
            data-testid={`menu-${menu.id}`}
            className="px-2.5 py-1 rounded-sm text-neutral-300 outline-none cursor-default select-none data-[state=open]:bg-neutral-700 data-[state=open]:text-white hover:bg-neutral-700"
          >
            {menu.label}
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
