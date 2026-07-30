import React, { useState } from 'react';
import { invokeCommand } from '../../commands/context';
import { COMMANDS, SECONDARY_TOOLBAR_ACTIONS, TOOL_TITLES } from '../../commands/registry';
import { toolById } from '../../commands/tools';
import type { CanvasTool } from '../../state/types';
import { ANNOTATION_PALETTE, STAMP_PRESETS } from './PageCell';
import type { StampPreset } from './PageCell';
import { MEASURE_UNITS, type MeasureScale, type MeasureUnit } from '../../lib/measure';
import {
  hasStampTokens,
  loadCustomStamps,
  saveCustomStamps,
  type CustomStamp,
} from '../../lib/stamp-library';
import { dialog, file } from '../../lib/tauri-bridge';

/** Read + downscale a picked raster into a library-sized PNG data URL (long
 * edge capped — stamps are page furniture, not photo archives, and the
 * library lives in localStorage). Returns null for an unreadable image. */
async function importStampImage(path: string): Promise<{ dataUrl: string; aspect: number } | null> {
  try {
    const bytes = await file.readBuffer(path);
    const bmp = await createImageBitmap(new Blob([bytes]));
    const MAX = 800;
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return { dataUrl: canvas.toDataURL('image/png'), aspect: h / w };
  } catch {
    return null;
  }
}

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
  /** Measure (parity map § 2): the scale ratio the readouts apply, whether a
   * finished measurement lands as an ink markup, and the latest value —
   * mode options in the stamp-preset sense (props, not commands). */
  measureScale: MeasureScale;
  onSetMeasureScale: (scale: MeasureScale) => void;
  measureLeaveMarkup: boolean;
  onToggleMeasureLeaveMarkup: () => void;
  measureResult: string | null;
  /** Edit tool (7.1): whether an image is selected, and its actions — mode
   * options in the stamp-preset sense (props+callbacks, not commands: they
   * act on transient canvas selection the registry can't see). */
  editHasSelection: boolean;
  /** Which kind of edit object is selected (7.2 adds text runs; 7.5 adds
   * paragraph boxes — the primary text surface). */
  editSelectionKind: 'image' | 'text' | 'para' | null;
  /** Selected text run's/paragraph's editability + refusal reason
   * (paragraph boxes list only when editable, so 'para' is always true). */
  editTextEditable: boolean;
  editTextReason: string | null;
  /** An action is in flight — buttons disable so a stale-index click can't
   * queue behind a mutation. */
  editBusy: boolean;
  /** Post-action status: extract's real output name, or a renderer-side
   * failure (decode/IO) that would otherwise vanish silently. */
  editNotice: { text: string; error: boolean } | null;
  onEditAction: (kind: 'delete' | 'replace' | 'extract') => void;
  /** Open the inline editor for the selected text run. */
  onEditTextOpen: () => void;
  /** 9.C3 image adjustments: the selected placement's current opacity
   * (null = no image selected), commit-on-release, the crop-mode toggle,
   * and the rotate-90 steps (routed through the C1 transform). */
  editImageOpacity: number | null;
  /** C4: the selected placement's kind — inline draws can't replace or
   * extract (the engine refuses; the buttons disable with the reason). */
  editImageKind: 'inline' | 'xobject' | null;
  onSetImageOpacity: (value: number) => void;
  imageCropArmed: boolean;
  onToggleImageCrop: () => void;
  onRotateImage: (dir: 1 | -1) => void;
}

export function SecondaryToolbar({
  tool,
  activeToolId,
  toolColor,
  onSetToolColor,
  stampPreset,
  onSetStampPreset,
  measureScale,
  onSetMeasureScale,
  measureLeaveMarkup,
  onToggleMeasureLeaveMarkup,
  measureResult,
  editHasSelection,
  editSelectionKind,
  editTextEditable,
  editTextReason,
  editBusy,
  editNotice,
  onEditAction,
  onEditTextOpen,
  editImageOpacity,
  editImageKind,
  onSetImageOpacity,
  imageCropArmed,
  onToggleImageCrop,
  onRotateImage,
}: SecondaryToolbarProps): React.JSX.Element | null {
  // Custom stamp library (parity map § 2): loaded once, persisted on every
  // change. Hooks live above the early return (rules of hooks).
  const [customStamps, setCustomStamps] = useState<CustomStamp[]>(() => loadCustomStamps());
  const [showNewStamp, setShowNewStamp] = useState(false);
  const [newStampLabel, setNewStampLabel] = useState('');
  const [newStampColor, setNewStampColor] = useState(ANNOTATION_PALETTE[3]);
  const persistStamps = (list: CustomStamp[]): void => {
    setCustomStamps(list);
    saveCustomStamps(list);
  };
  const addTextStamp = (): void => {
    const label = newStampLabel.trim();
    if (!label) return;
    persistStamps([
      ...customStamps,
      { id: crypto.randomUUID(), label, color: newStampColor },
    ]);
    setNewStampLabel('');
    setShowNewStamp(false);
  };
  const addImageStamp = async (): Promise<void> => {
    const path = await dialog.pickImageFile();
    if (!path) return;
    const img = await importStampImage(path);
    if (!img) return;
    const stem = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Stamp';
    persistStamps([
      ...customStamps,
      {
        id: crypto.randomUUID(),
        label: stem,
        color: '#2f6fed',
        imageData: img.dataUrl,
        aspect: img.aspect,
      },
    ]);
  };
  const removeCustomStamp = (id: string): void => {
    const gone = customStamps.find((s) => s.id === id);
    persistStamps(customStamps.filter((s) => s.id !== id));
    // Removing the SELECTED stamp also clears the armed preset — a click
    // placing a stamp that no longer exists in the library would be spooky.
    if (
      gone &&
      stampPreset?.label === gone.label &&
      (stampPreset?.imageData ?? undefined) === gone.imageData
    ) {
      onSetStampPreset(null);
    }
  };
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
      {owner.id === 'measure' && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Measure options">
          <span className="secondary-toolbar-hint">Scale</span>
          <input
            type="number"
            min={0}
            step="any"
            value={measureScale.from}
            data-testid="measure-scale-from"
            aria-label="Scale: paper amount"
            className="measure-scale-input"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, from: parseFloat(e.target.value) || 0 })
            }
          />
          <select
            value={measureScale.fromUnit}
            data-testid="measure-scale-from-unit"
            aria-label="Scale: paper unit"
            className="measure-scale-select"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, fromUnit: e.target.value as MeasureUnit })
            }
          >
            {MEASURE_UNITS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          <span className="secondary-toolbar-hint">=</span>
          <input
            type="number"
            min={0}
            step="any"
            value={measureScale.to}
            data-testid="measure-scale-to"
            aria-label="Scale: real-world amount"
            className="measure-scale-input"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, to: parseFloat(e.target.value) || 0 })
            }
          />
          <select
            value={measureScale.toUnit}
            data-testid="measure-scale-to-unit"
            aria-label="Scale: real-world unit"
            className="measure-scale-select"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, toUnit: e.target.value as MeasureUnit })
            }
          >
            {MEASURE_UNITS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          <label className="secondary-toolbar-hint measure-leave-label">
            <input
              type="checkbox"
              checked={measureLeaveMarkup}
              data-testid="measure-leave-markup"
              onChange={onToggleMeasureLeaveMarkup}
            />
            Leave markup
          </label>
          {measureResult && (
            <span className="secondary-toolbar-hint measure-result" data-testid="measure-result" aria-live="polite">
              {measureResult}
            </span>
          )}
        </div>
      )}
      {owner.id === 'edit' && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Image actions">
          {!editHasSelection && !editBusy && !editNotice && (
            <span className="secondary-toolbar-hint" data-testid="edit-hint">
              Click an image, a paragraph, or a line of text on the page
            </span>
          )}
          {editSelectionKind === 'text' && !editBusy && !editTextEditable && editTextReason && (
            <span className="secondary-toolbar-hint error" data-testid="edit-text-reason">
              {editTextReason}
            </span>
          )}
          {(editSelectionKind === 'text' || editSelectionKind === 'para') && (
            <button
              type="button"
              data-testid="edit-action-text"
              className="secondary-tool"
              disabled={!editTextEditable || editBusy}
              onClick={onEditTextOpen}
            >
              {editSelectionKind === 'para' ? 'Edit Paragraph…' : 'Edit Text…'}
            </button>
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
            disabled={editSelectionKind !== 'image' || editBusy || editImageKind === 'inline'}
            title={
              editImageKind === 'inline'
                ? 'An inline image cannot be replaced — delete it and add an image instead'
                : undefined
            }
            onClick={() => onEditAction('replace')}
          >
            Replace…
          </button>
          <button
            type="button"
            data-testid="edit-action-extract"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy || editImageKind === 'inline'}
            title={
              editImageKind === 'inline' ? 'An inline image cannot be extracted' : undefined
            }
            onClick={() => onEditAction('extract')}
          >
            Extract…
          </button>
          <button
            type="button"
            data-testid="edit-action-delete"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            onClick={() => onEditAction('delete')}
          >
            Delete
          </button>
          {/* 9.C3 image adjustments — enabled only with an image selected. */}
          <button
            type="button"
            data-testid="edit-action-crop"
            className="secondary-tool"
            aria-pressed={imageCropArmed}
            disabled={editSelectionKind !== 'image' || editBusy}
            title="Crop — drag inside the image to keep a region"
            onClick={onToggleImageCrop}
          >
            Crop
          </button>
          <button
            type="button"
            data-testid="edit-action-rotate-ccw"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            title="Rotate 90° counter-clockwise"
            onClick={() => onRotateImage(1)}
          >
            ↺ 90°
          </button>
          <button
            type="button"
            data-testid="edit-action-rotate-cw"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            title="Rotate 90° clockwise"
            onClick={() => onRotateImage(-1)}
          >
            ↻ 90°
          </button>
          {editSelectionKind === 'image' && editImageOpacity !== null && (
            <OpacitySlider
              key={`${editImageOpacity}`}
              seed={editImageOpacity}
              disabled={editBusy}
              onCommit={onSetImageOpacity}
            />
          )}
        </div>
      )}
      {tool === 'stamp' && (
        <div className="secondary-toolbar-opts" role="group" aria-label="Stamp preset">
          {STAMP_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              data-testid={`stamp-preset-${p.label.toLowerCase()}`}
              aria-pressed={stampPreset?.label === p.label && !stampPreset?.imageData}
              title={p.label}
              className="stamp-preset"
              onClick={() => onSetStampPreset(stampPreset?.label === p.label && !stampPreset?.imageData ? null : p)}
              style={{
                color: p.color,
                borderColor: p.color,
                backgroundColor: stampPreset?.label === p.label && !stampPreset?.imageData ? `${p.color}33` : 'transparent',
              }}
            >
              {p.label}
            </button>
          ))}
          {customStamps.map((s) => {
            const active =
              stampPreset?.label === s.label && (stampPreset?.imageData ?? undefined) === s.imageData;
            return (
              <span key={s.id} className="stamp-custom-wrap">
                <button
                  type="button"
                  data-testid={`stamp-custom-${s.id}`}
                  aria-pressed={active}
                  title={
                    s.imageData
                      ? s.label
                      : hasStampTokens(s.label)
                        ? `${s.label} — dynamic: tokens resolve when placed`
                        : s.label
                  }
                  className="stamp-preset"
                  onClick={() =>
                    onSetStampPreset(
                      active
                        ? null
                        : { label: s.label, color: s.color, imageData: s.imageData, aspect: s.aspect },
                    )
                  }
                  style={
                    s.imageData
                      ? { borderColor: '#45454c', backgroundColor: active ? '#2f6fed33' : 'transparent' }
                      : {
                          color: s.color,
                          borderColor: s.color,
                          backgroundColor: active ? `${s.color}33` : 'transparent',
                        }
                  }
                >
                  {s.imageData ? (
                    <img src={s.imageData} alt={s.label} className="stamp-custom-thumb" />
                  ) : (
                    s.label
                  )}
                </button>
                <button
                  type="button"
                  data-testid={`stamp-custom-del-${s.id}`}
                  className="stamp-custom-del"
                  title="Remove this stamp from the library"
                  onClick={() => removeCustomStamp(s.id)}
                >
                  ×
                </button>
              </span>
            );
          })}
          <button
            type="button"
            data-testid="stamp-new-text"
            className="secondary-tool"
            aria-expanded={showNewStamp}
            onClick={() => setShowNewStamp((v) => !v)}
          >
            New stamp…
          </button>
          <button
            type="button"
            data-testid="stamp-new-image"
            className="secondary-tool"
            onClick={() => void addImageStamp()}
          >
            From image…
          </button>
        </div>
      )}
      {tool === 'stamp' && showNewStamp && (
        <div className="secondary-toolbar-opts" role="group" aria-label="New custom stamp">
          <input
            type="text"
            data-testid="stamp-new-label"
            value={newStampLabel}
            onChange={(e) => setNewStampLabel(e.target.value)}
            placeholder="Label — {date} {time} {name} allowed"
            className="stamp-new-label"
          />
          {ANNOTATION_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`stamp-new-color-${c.slice(1)}`}
              aria-pressed={newStampColor === c}
              title={c}
              className="annot-swatch"
              style={{ backgroundColor: c, outline: newStampColor === c ? `2px solid ${c}` : 'none' }}
              onClick={() => setNewStampColor(c)}
            />
          ))}
          <button
            type="button"
            data-testid="stamp-new-add"
            className="secondary-tool"
            disabled={!newStampLabel.trim()}
            onClick={addTextStamp}
          >
            Add
          </button>
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

/** 9.C3: opacity with commit-on-release — dragging previews the number
 * locally; only releasing (pointer or keyboard) commits, so one drag is ONE
 * undoable engine op, not thirty. The parent keys this by the seed, so a
 * fresh listing remounts it holding the committed value. */
function OpacitySlider({
  seed,
  disabled,
  onCommit,
}: {
  seed: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(Math.round(seed * 100));
  const commit = (): void => {
    const v = value / 100;
    // Sub-percent wiggle back to the seed is a no-op, not an engine call.
    if (Math.abs(v - seed) > 0.004) onCommit(v);
  };
  const commitKeys = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]);
  return (
    <label className="secondary-toolbar-opacity" title="Image opacity">
      Opacity
      <input
        type="range"
        data-testid="edit-image-opacity"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={(e) => {
          if (commitKeys.has(e.key)) commit();
        }}
      />
      <span data-testid="edit-image-opacity-value">{value}%</span>
    </label>
  );
}
