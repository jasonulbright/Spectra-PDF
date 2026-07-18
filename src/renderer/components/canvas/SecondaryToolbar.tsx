import React from 'react';
import { invokeCommand } from '../../commands/context';
import { COMMANDS, SECONDARY_TOOLBAR_ACTIONS, TOOL_TITLES } from '../../commands/registry';
import { toolById } from '../../commands/tools';
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
  /** The armed mode — which of the tool's buttons reads as active. */
  tool: CanvasTool;
  /** The OPEN tool (ui.activeToolId). Null = none. */
  activeToolId: string | null;
  /** Colour for NEW annotations; null = the kind's default. */
  toolColor: string | null;
  onSetToolColor: (color: string | null) => void;
  /** Stamp text preset; null = the default stamp. */
  stampPreset: StampPreset | null;
  onSetStampPreset: (preset: StampPreset | null) => void;
  /** Edit tool (7.1): whether an image is selected, and its actions — mode
   * options in the stamp-preset sense (props+callbacks, not commands: they
   * act on transient canvas selection the registry can't see). */
  editHasSelection: boolean;
  /** An action is in flight — buttons disable so a stale-index click can't
   * queue behind a mutation. */
  editBusy: boolean;
  /** Post-action status: extract's real output name, or a renderer-side
   * failure (decode/IO) that would otherwise vanish silently. */
  editNotice: { text: string; error: boolean } | null;
  onEditAction: (kind: 'delete' | 'replace' | 'extract') => void;
}

export function SecondaryToolbar({
  tool,
  activeToolId,
  toolColor,
  onSetToolColor,
  stampPreset,
  onSetStampPreset,
  editHasSelection,
  editBusy,
  editNotice,
  onEditAction,
}: SecondaryToolbarProps): React.JSX.Element | null {
  // The strip belongs to the OPEN TOOL, not to the armed mode: Escape means
  // "stop drawing", not "close Comment", and with the pill gone a strip that
  // vanished on Escape would leave no way to re-arm short of the Tools menu.
  // Only a tool that drives the canvas has one — Optimize has nothing to say
  // about a page.
  const owner = activeToolId ? toolById(activeToolId) : undefined;
  if (!owner?.canvasTools?.length) return null;

  const modes = owner.canvasTools;
  const actions = SECONDARY_TOOLBAR_ACTIONS[owner.id];
  // Only the ANNOTATION modes carry a colour; a stamp carries its preset's.
  const colored = modes.includes(tool) && tool !== 'stamp' && owner.id === 'comment';

  return (
    <div className="secondary-toolbar" data-testid="secondary-toolbar" data-tool={owner.id}>
      <span className="secondary-toolbar-title">{owner.title}</span>

      {/* The tool's modes. One button per mode it owns — the pill's job, minus
          the seven modes belonging to tools you didn't pick. */}
      {/* Every mode it owns gets a button, INCLUDING a lone one: Prepare Form
          owns only `formfields`, and § 3.2 calls for its "+ Add Field" control
          by name — gating on >1 silently deleted it, and Redact's too. */}
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
      {owner.id === 'edit' && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Image actions">
          {!editHasSelection && !editBusy && !editNotice && (
            <span className="secondary-toolbar-hint" data-testid="edit-hint">
              Click an image on the page
            </span>
          )}
          {editBusy && (
            <span className="secondary-toolbar-hint" data-testid="edit-busy" aria-live="polite">
              Working…
            </span>
          )}
          {editNotice && !editBusy && (
            <span
              className={'secondary-toolbar-hint' + (editNotice.error ? ' error' : '')}
              data-testid="edit-notice"
              aria-live="polite"
            >
              {editNotice.text}
            </span>
          )}
          <button
            type="button"
            data-testid="edit-action-replace"
            className="secondary-tool"
            disabled={!editHasSelection || editBusy}
            onClick={() => onEditAction('replace')}
          >
            Replace…
          </button>
          <button
            type="button"
            data-testid="edit-action-extract"
            className="secondary-tool"
            disabled={!editHasSelection || editBusy}
            onClick={() => onEditAction('extract')}
          >
            Extract…
          </button>
          <button
            type="button"
            data-testid="edit-action-delete"
            className="secondary-tool"
            disabled={!editHasSelection || editBusy}
            onClick={() => onEditAction('delete')}
          >
            Delete
          </button>
        </div>
      )}
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

