import React from 'react';
import { invokeCommand } from '../../commands/context';
import { COMMANDS, SECONDARY_TOOLBAR_ACTIONS, TOOL_TITLES } from '../../commands/registry';
import { toolForCanvasTool } from '../../commands/tools';
import type { CanvasTool } from '../../state/types';
import { ANNOTATION_PALETTE, STAMP_PRESETS } from './PageCell';
import type { StampPreset } from './PageCell';

// The secondary toolbar (§ 3.1): "a contextual strip that appears while a tool
// mode is active, hosting that tool's actions". It sits at the top of the
// document pane, under the tab strip — Acrobat's placement, and § 3's layout.
//
// It replaces the floating pill, which listed all eight canvas modes flat, at
// all times, and made the user infer which belonged together. This shows ONE
// tool's modes, because a tool is what you picked — and it can, because
// `canvasTools` made mode→tool ownership a fact rather than a guess (M5.3).
//
// WHICH tool: the one owning the armed MODE, per § 3.1's own wording ("while a
// tool mode is active"). Deliberately NOT `ui.activeToolId` — that names the
// tool whose pane the TOOLS TAB is showing, a different question with a
// different answer. Nothing armed (`select`) ⇒ no tool ⇒ no strip.
//
// What stays OUT of here, deliberately: the pending-state buttons ("Fill 3
// fields", "Redact 2 regions"). They are not tool options — they report work
// the user has queued, and the canvas invariant is that pending state is never
// invisible (the redaction-mark precedent). Scoping them to a tool would hide
// them the moment you pressed Escape.

export interface SecondaryToolbarProps {
  tool: CanvasTool;
  /** Colour for NEW annotations; null = the kind's default. */
  toolColor: string | null;
  onSetToolColor: (color: string | null) => void;
  /** Stamp text preset; null = the default stamp. */
  stampPreset: StampPreset | null;
  onSetStampPreset: (preset: StampPreset | null) => void;
}

export function SecondaryToolbar({
  tool,
  toolColor,
  onSetToolColor,
  stampPreset,
  onSetStampPreset,
}: SecondaryToolbarProps): React.JSX.Element | null {
  const owner = toolForCanvasTool(tool);
  if (!owner) return null; // Select: no tool is active, so there is nothing to show.

  const modes = owner.canvasTools ?? [];
  const actions = SECONDARY_TOOLBAR_ACTIONS[owner.id];
  // Only the ANNOTATION modes carry a colour; a stamp carries its preset's.
  const colored = modes.includes(tool) && tool !== 'stamp' && owner.id === 'comment';

  return (
    <div className="secondary-toolbar" data-testid="secondary-toolbar" data-tool={owner.id}>
      <span className="secondary-toolbar-title">{owner.title}</span>

      {/* The tool's modes. One button per mode it owns — the pill's job, minus
          the seven modes belonging to tools you didn't pick. */}
      {modes.length > 1 && (
        <div className="secondary-toolbar-modes" role="group" aria-label={`${owner.title} tools`}>
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`tool-${m}`}
              aria-pressed={tool === m}
              className={'secondary-tool' + (tool === m ? ' active' : '')}
              onClick={() => invokeCommand(`tools.${m}`)}
            >
              {TOOL_TITLES[m]}
            </button>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div className="secondary-toolbar-actions">
          {actions.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`secondary-action-${id}`}
              className="secondary-tool"
              onClick={() => invokeCommand(id)}
            >
              {COMMANDS[id].title}
            </button>
          ))}
        </div>
      )}

      {/* Mode OPTIONS — they configure the armed mode, so they belong to the
          tool and move here from the floating cluster. */}
      {tool === 'stamp' && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Stamp preset">
          {STAMP_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              data-testid={`stamp-preset-${p.label.toLowerCase()}`}
              aria-pressed={stampPreset?.label === p.label}
              title={p.label}
              className="stamp-preset"
              onClick={() => onSetStampPreset(stampPreset?.label === p.label ? null : p)}
              style={{
                color: p.color,
                borderColor: p.color,
                backgroundColor: stampPreset?.label === p.label ? `${p.color}33` : 'transparent',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {colored && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Annotation colour">
          {ANNOTATION_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`annot-color-${c.slice(1)}`}
              aria-pressed={toolColor === c}
              title={c}
              className="annot-swatch"
              onClick={() => onSetToolColor(toolColor === c ? null : c)}
              style={{
                backgroundColor: c,
                outline: toolColor === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

