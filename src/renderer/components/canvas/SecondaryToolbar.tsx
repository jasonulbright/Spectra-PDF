import React, { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { invokeCommand } from '../../commands/context';
import { COMMANDS, SECONDARY_TOOLBAR_ACTIONS, TOOL_TITLES } from '../../commands/registry';
import { toolById } from '../../commands/tools';
import type { CanvasTool, ShapeType } from '../../state/types';
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
import { CountSymbolGlyph } from '../CountSymbolGlyph';
import { SymbolPalette, symbolDisplayName } from '../SymbolPalette';
import type { CountGroup } from '../../lib/count-marks';
import {
  armCountGroup,
  getTakeoffSettings,
  subscribeTakeoffSettings,
} from '../../lib/takeoff-settings';
import {
  tChrome,
  tChromeCount,
  tCommandTitle,
  tNumber,
  tToolTitle,
} from '../../i18n';

/** N11 slice D: the colour a symbol arms in when the tool has no colour set —
 * markup red, the same default a drawing shape takes. */
const SYMBOL_STAMP_COLOR = '#e0393e';

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
  /** N11 slice C (count mode): the groups the picker offers — the DOCUMENT's
   * own groups merged with the remembered ones, resolved by the canvas view
   * because that is what holds the document. Which one is ARMED comes from the
   * module store this component reads directly, so the strip and the Takeoff
   * panel cannot disagree about it. */
  countGroups: readonly CountGroup[];
  /** Shape mode (rung 2): which figure the gesture draws — a mode option in
   * the stamp-preset sense. */
  shapeType: ShapeType;
  onSetShapeType: (type: ShapeType) => void;
  /** Measure (parity map § 2): the scale ratio the readouts apply, whether a
   * finished measurement lands as an ink markup, and the latest value —
   * mode options in the stamp-preset sense (props, not commands). */
  measureScale: MeasureScale;
  onSetMeasureScale: (scale: MeasureScale) => void;
  measureLeaveMarkup: boolean;
  onToggleMeasureLeaveMarkup: () => void;
  measureResult: string | null;
  /** Rung 3: the calibration drag span (PDF points) awaiting its value. */
  calibration: number | null;
  onApplyCalibration: (value: number, unit: MeasureUnit) => void;
  onCancelCalibration: () => void;
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
  onSetImageOpacity: (value: number) => void;
  /** P7 slice D: the selected placement's blend mode seed (null = no single
   * image selected) + commit. */
  editImageBlend: string | null;
  onSetImageBlend: (blend: string) => void;
  /** P7 slice E: the selected placement's gradient-mask seed ({kind:'none'}
   * when a single image has no tool mask; null = no single selection) +
   * commit (the wire shape — full params or {kind:'none'} to clear). */
  editImageMask:
    | {
        kind: 'linear' | 'radial';
        from: [number, number];
        to: [number, number];
        startAlpha: number;
        endAlpha: number;
      }
    | { kind: 'none' }
    | null;
  onSetImageMask: (
    mask:
      | { kind: 'none' }
      | {
          kind: 'linear' | 'radial';
          from: [number, number];
          to: [number, number];
          start_alpha: number;
          end_alpha: number;
        },
  ) => void;
  imageCropArmed: boolean;
  onToggleImageCrop: () => void;
  onRotateImage: (dir: 1 | -1) => void;
  /** P7 slice F: the single selected placement's kind — replace/extract
   * disable for a placed vector graphic (null = no single selection). */
  editImagePlacementKind: 'inline' | 'xobject' | 'vector' | null;
  /** P7 multi-select: how many images are selected (0 when the selection is
   * not images). Single-target actions disable above 1; the align/distribute
   * row appears at 2+ (distribute needs 3+). */
  editImageCount: number;
  onAlignImages: (
    mode: 'left' | 'centerh' | 'right' | 'top' | 'centerv' | 'bottom' | 'disth' | 'distv',
  ) => void;
}

type CanvasStringKey = Parameters<typeof tChrome>[0];

/** The tooltip key for an align/distribute mode. The GLYPH stays in the table
 * (it is the same visual language as the PropertiesBar's annotation row); only
 * the wording crosses into the catalog. */
function alignTitleKey(
  mode: 'left' | 'centerh' | 'right' | 'top' | 'centerv' | 'bottom' | 'disth' | 'distv',
): CanvasStringKey {
  return `canvas.edit.align${mode.charAt(0).toUpperCase()}${mode.slice(1)}` as CanvasStringKey;
}

/** Rung 3: "Measured N pt = [value][unit] Apply" — the calibration drag's
 * follow-up. Local state per pending span (keyed remount on lengthPts). */
function CalibrationApplyRow({
  lengthPts,
  onApply,
  onCancel,
}: {
  lengthPts: number;
  onApply: (value: number, unit: MeasureUnit) => void;
  onCancel: () => void;
}): React.JSX.Element {
  useTranslation();
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<MeasureUnit>('ft');
  const parsed = parseFloat(value);
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <div className="secondary-toolbar-opts" role="group"
      aria-label={tChrome('canvas.measure.calibrationGroup')}
      data-testid="calibration-row">
      <span className="secondary-toolbar-hint">
        {tChrome('canvas.measure.measured', {
          length: tNumber(lengthPts, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        })}
      </span>
      <input
        type="number"
        min={0}
        step="any"
        autoFocus
        data-testid="calibration-value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onApply(parsed, unit);
        }}
      />
      <select
        data-testid="calibration-unit"
        value={unit}
        onChange={(e) => setUnit(e.target.value as MeasureUnit)}
      >
        {MEASURE_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
      <button type="button" className="secondary-tool" data-testid="calibration-apply" disabled={!valid} onClick={() => onApply(parsed, unit)}>
        {tChrome('canvas.common.apply')}
      </button>
      <button type="button" className="secondary-tool" data-testid="calibration-cancel" onClick={onCancel}>
        {tChrome('canvas.common.cancel')}
      </button>
    </div>
  );
}

export function SecondaryToolbar({
  tool,
  activeToolId,
  toolColor,
  onSetToolColor,
  stampPreset,
  onSetStampPreset,
  countGroups,
  shapeType,
  onSetShapeType,
  measureScale,
  onSetMeasureScale,
  measureLeaveMarkup,
  onToggleMeasureLeaveMarkup,
  measureResult,
  calibration,
  onApplyCalibration,
  onCancelCalibration,
  editHasSelection,
  editSelectionKind,
  editTextEditable,
  editTextReason,
  editBusy,
  editNotice,
  onEditAction,
  onEditTextOpen,
  editImageOpacity,
  editImageBlend,
  onSetImageBlend,
  editImageMask,
  onSetImageMask,
  editImagePlacementKind,
  editImageCount,
  onAlignImages,
  onSetImageOpacity,
  imageCropArmed,
  onToggleImageCrop,
  onRotateImage,
}: SecondaryToolbarProps): React.JSX.Element | null {
  useTranslation();
  // Custom stamp library (parity map § 2): loaded once, persisted on every
  // change. Hooks live above the early return (rules of hooks).
  const [customStamps, setCustomStamps] = useState<CustomStamp[]>(() => loadCustomStamps());
  // N11 slice C: which count group is armed. Read from the module store, not
  // a prop — the Takeoff panel writes it and this strip must show the same
  // answer without a second owner in between.
  const takeoff = useSyncExternalStore(
    subscribeTakeoffSettings,
    getTakeoffSettings,
    getTakeoffSettings,
  );
  const [showNewStamp, setShowNewStamp] = useState(false);
  // N11 slice D: the symbol palette rides in the stamp picker, collapsed by
  // default — it is a searchable library, not a row of pills, and the strip is
  // a strip.
  const [showSymbols, setShowSymbols] = useState(false);
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
    const stem =
      path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ||
      tChrome('canvas.stamp.defaultName');
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
      // A BUILT-IN preset carries an id; only a custom one can be the stamp
      // being removed, whatever its label happens to say.
      !stampPreset?.id &&
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
  // Only the ANNOTATION modes carry a colour; a stamp carries its preset's —
  // except a SYMBOL stamp (N11 slice D), which is line art the drafter colours
  // like any other markup, and placing twenty of them in the wrong colour to
  // recolour them one by one afterwards is not a workflow.
  const colored =
    modes.includes(tool) &&
    (tool !== 'stamp' || !!stampPreset?.symbolParts) &&
    owner.id === 'comment';

  return (
    <div className="secondary-toolbar" data-testid="secondary-toolbar" data-tool={owner.id}>
      <span className="secondary-toolbar-title">{tToolTitle(owner.id, owner.title)}</span>

      {/* The tool's modes. One button per mode it owns — the pill's job, minus
          the seven modes belonging to tools you didn't pick. */}
      {/* Every mode it owns gets a button, INCLUDING a lone one: Prepare Form
          owns only `formfields`, and § 3.2 calls for its "+ Add Field" control
          by name — gating on >1 silently deleted it, and Redact's too. */}
      <div className="secondary-toolbar-modes" role="group" aria-label={tChrome('canvas.toolbar.modes', { tool: tToolTitle(owner.id, owner.title) })}>
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`tool-${m}`}
              aria-pressed={tool === m}
              className={'secondary-tool' + (tool === m ? ' active' : '')}
              onClick={() => invokeCommand(`tools.${m}`)}
            >
              {tCommandTitle(`tools.${m}`, TOOL_TITLES[m])}
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
              {tCommandTitle(id, COMMANDS[id].title)}
            </button>
          ))}
        </div>
      )}

      {/* Mode OPTIONS — they configure the armed mode, so they belong to the
          tool and move here from the floating cluster. */}
      {owner.id === 'comment' && tool === 'shape' && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.toolbar.shapeGroup')}
        >
          {(
            [
              ['rect', 'canvas.shape.rect'],
              ['ellipse', 'canvas.shape.ellipse'],
              ['line', 'canvas.shape.line'],
              ['arrow', 'canvas.shape.arrow'],
              ['polygon', 'canvas.shape.polygon'],
              ['polyline', 'canvas.shape.polyline'],
              ['cloud', 'canvas.shape.cloud'],
            ] as [ShapeType, CanvasStringKey][]
          ).map(([t, labelKey]) => (
            <button
              key={t}
              type="button"
              data-testid={`shape-type-${t}`}
              aria-pressed={shapeType === t}
              className={'secondary-tool' + (shapeType === t ? ' active' : '')}
              onClick={() => onSetShapeType(t)}
            >
              {tChrome(labelKey)}
            </button>
          ))}
        </div>
      )}
      {owner.id === 'measure' && tool === 'measurecal' && calibration !== null && (
        <CalibrationApplyRow
          lengthPts={calibration}
          onApply={onApplyCalibration}
          onCancel={onCancelCalibration}
        />
      )}
      {owner.id === 'measure' && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.measure.optionsGroup')}
        >
          <span className="secondary-toolbar-hint">{tChrome('canvas.measure.scale')}</span>
          <input
            type="number"
            min={0}
            step="any"
            value={measureScale.from}
            data-testid="measure-scale-from"
            aria-label={tChrome('canvas.measure.paperAmount')}
            className="measure-scale-input"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, from: parseFloat(e.target.value) || 0 })
            }
          />
          <select
            value={measureScale.fromUnit}
            data-testid="measure-scale-from-unit"
            aria-label={tChrome('canvas.measure.paperUnit')}
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
            aria-label={tChrome('canvas.measure.realAmount')}
            className="measure-scale-input"
            onChange={(e) =>
              onSetMeasureScale({ ...measureScale, to: parseFloat(e.target.value) || 0 })
            }
          />
          <select
            value={measureScale.toUnit}
            data-testid="measure-scale-to-unit"
            aria-label={tChrome('canvas.measure.realUnit')}
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
            {tChrome('canvas.measure.leaveMarkup')}
          </label>
          {measureResult && (
            <span className="secondary-toolbar-hint measure-result" data-testid="measure-result" aria-live="polite">
              {measureResult}
            </span>
          )}
        </div>
      )}
      {owner.id === 'edit' && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.edit.actionsGroup')}
        >
          {!editHasSelection && !editBusy && !editNotice && (
            <span className="secondary-toolbar-hint" data-testid="edit-hint">
              {tChrome('canvas.edit.hint')}
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
              {tChrome(
                editSelectionKind === 'para'
                  ? 'canvas.edit.editParagraph'
                  : 'canvas.edit.editText',
              )}
            </button>
          )}
          {editBusy && (
            <span className="secondary-toolbar-hint" data-testid="edit-busy" aria-live="polite">
              {tChrome('canvas.common.working')}
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
          {/* P6: inline images replace (promoted to an ordinary embedded
              image) and extract like any other — the old disable is gone.
              P7: replace/extract/crop are single-target — they disable on a
              group; delete and rotate act on the whole selection. */}
          <button
            type="button"
            data-testid="edit-action-replace"
            className="secondary-tool"
            disabled={
              editSelectionKind !== 'image' ||
              editImageCount > 1 ||
              editImagePlacementKind === 'vector' ||
              editBusy
            }
            title={
              editImagePlacementKind === 'vector'
                ? tChrome('canvas.edit.vectorNoReplace')
                : undefined
            }
            onClick={() => onEditAction('replace')}
          >
            {tChrome('canvas.edit.replace')}
          </button>
          <button
            type="button"
            data-testid="edit-action-extract"
            className="secondary-tool"
            disabled={
              editSelectionKind !== 'image' ||
              editImageCount > 1 ||
              editImagePlacementKind === 'vector' ||
              editBusy
            }
            title={
              editImagePlacementKind === 'vector'
                ? tChrome('canvas.edit.vectorNoExtract')
                : undefined
            }
            onClick={() => onEditAction('extract')}
          >
            {tChrome('canvas.edit.extract')}
          </button>
          <button
            type="button"
            data-testid="edit-action-delete"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            onClick={() => onEditAction('delete')}
          >
            {tChrome('canvas.common.delete')}
          </button>
          {/* 9.C3 image adjustments — enabled only with an image selected. */}
          <button
            type="button"
            data-testid="edit-action-crop"
            className="secondary-tool"
            aria-pressed={imageCropArmed}
            disabled={editSelectionKind !== 'image' || editImageCount > 1 || editBusy}
            title={tChrome('canvas.edit.cropTitle')}
            onClick={onToggleImageCrop}
          >
            {tChrome('canvas.edit.crop')}
          </button>
          <button
            type="button"
            data-testid="edit-action-rotate-ccw"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            title={tChrome('canvas.edit.rotateCcw')}
            onClick={() => onRotateImage(1)}
          >
            ↺ 90°
          </button>
          <button
            type="button"
            data-testid="edit-action-rotate-cw"
            className="secondary-tool"
            disabled={editSelectionKind !== 'image' || editBusy}
            title={tChrome('canvas.edit.rotateCw')}
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
          {/* P7 slice D: blend mode — seeded from the listing, committed
              through the same gs frame as opacity (one merged frame). */}
          {editSelectionKind === 'image' && editImageBlend !== null && (
            <label
              className="secondary-toolbar-blend"
              title={tChrome('canvas.edit.blendTitle')}
            >
              <span>{tChrome('canvas.edit.blend')}</span>
              <select
                data-testid="edit-image-blend"
                value={editImageBlend}
                disabled={editBusy}
                onChange={(e) => onSetImageBlend(e.target.value)}
              >
                {[
                  'Normal',
                  'Multiply',
                  'Screen',
                  'Overlay',
                  'Darken',
                  'Lighten',
                  'ColorDodge',
                  'ColorBurn',
                  'HardLight',
                  'SoftLight',
                  'Difference',
                  'Exclusion',
                  'Hue',
                  'Saturation',
                  'Color',
                  'Luminosity',
                ].map((m) => (
                  <option key={m} value={m}>
                    {tChrome(`canvas.blend.${m}` as CanvasStringKey)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* P7 slice E: gradient mask — kind select seeds/starts the fade;
              the on-canvas dots then steer its direction; alphas here. */}
          {editSelectionKind === 'image' && editImageMask !== null && (
            <label
              className="secondary-toolbar-blend"
              title={tChrome('canvas.edit.fadeTitle')}
            >
              <span>{tChrome('canvas.edit.fade')}</span>
              <select
                data-testid="edit-image-mask-kind"
                value={editImageMask.kind}
                disabled={editBusy}
                onChange={(e) => {
                  const kind = e.target.value;
                  if (kind === 'none') {
                    onSetImageMask({ kind: 'none' });
                  } else if (kind === 'linear' || kind === 'radial') {
                    // Keep the current geometry when switching kind; seed a
                    // fresh default axis otherwise.
                    const cur = editImageMask.kind !== 'none' ? editImageMask : null;
                    onSetImageMask({
                      kind,
                      from: cur?.from ?? (kind === 'linear' ? [0, 0.5] : [0.5, 0.5]),
                      to: cur?.to ?? [1, 0.5],
                      start_alpha: cur?.startAlpha ?? 1,
                      end_alpha: cur?.endAlpha ?? 0,
                    });
                  }
                }}
              >
                <option value="none">{tChrome('canvas.edit.fadeNone')}</option>
                <option value="linear">{tChrome('canvas.edit.fadeLinear')}</option>
                <option value="radial">{tChrome('canvas.edit.fadeRadial')}</option>
              </select>
            </label>
          )}
          {editSelectionKind === 'image' &&
            editImageMask !== null &&
            editImageMask.kind !== 'none' && (
              <label
                className="secondary-toolbar-blend"
                title={tChrome('canvas.edit.fadeAlphaTitle')}
              >
                <input
                  type="number"
                  data-testid="edit-image-mask-a0"
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={Math.round(editImageMask.startAlpha * 100)}
                  disabled={editBusy}
                  onBlur={(e) => {
                    const v = Math.max(0, Math.min(100, Number(e.target.value))) / 100;
                    if (Math.abs(v - editImageMask.startAlpha) < 0.005) return;
                    onSetImageMask({
                      kind: editImageMask.kind,
                      from: editImageMask.from,
                      to: editImageMask.to,
                      start_alpha: v,
                      end_alpha: editImageMask.endAlpha,
                    });
                  }}
                  style={{ width: 46 }}
                />
                <span>→</span>
                <input
                  type="number"
                  data-testid="edit-image-mask-a1"
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={Math.round(editImageMask.endAlpha * 100)}
                  disabled={editBusy}
                  onBlur={(e) => {
                    const v = Math.max(0, Math.min(100, Number(e.target.value))) / 100;
                    if (Math.abs(v - editImageMask.endAlpha) < 0.005) return;
                    onSetImageMask({
                      kind: editImageMask.kind,
                      from: editImageMask.from,
                      to: editImageMask.to,
                      start_alpha: editImageMask.startAlpha,
                      end_alpha: v,
                    });
                  }}
                  style={{ width: 46 }}
                />
              </label>
            )}
          {/* P7 multi-select: align/distribute the group — per-member
              translates through the ONE multi commit (one undo entry). */}
          {editImageCount > 1 && (
            <span
              role="group"
              aria-label={tChrome('canvas.edit.alignGroup')}
              className="secondary-toolbar-align"
            >
              {/* Same glyph set as the PropertiesBar's annotation align row —
                  one visual language for "align" across the product. */}
              {(
                [
                  ['left', '⭰'],
                  ['centerh', '⇹'],
                  ['right', '⭲'],
                  ['top', '⭱'],
                  ['centerv', '⇳'],
                  ['bottom', '⭳'],
                ] as const
              ).map(([mode, glyph]) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`edit-align-${mode}`}
                  className="secondary-tool"
                  disabled={editBusy}
                  title={tChrome(alignTitleKey(mode))}
                  onClick={() => onAlignImages(mode)}
                >
                  {glyph}
                </button>
              ))}
              {editImageCount > 2 &&
                (
                  [
                    ['disth', '⇢⇠'],
                    ['distv', '⇣⇡'],
                  ] as const
                ).map(([mode, glyph]) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`edit-align-${mode}`}
                    className="secondary-tool"
                    disabled={editBusy}
                    title={tChrome(alignTitleKey(mode))}
                    onClick={() => onAlignImages(mode)}
                  >
                    {glyph}
                  </button>
                ))}
              <span className="secondary-toolbar-hint" data-testid="edit-group-count">
                {tChromeCount('canvas.edit.groupCount', editImageCount)}
              </span>
            </span>
          )}
        </div>
      )}
      {tool === 'count' && (
        // N11 slice C — the armed count group, on the strip where the mode is.
        // The full manager (colours, symbols, tallies, legend, CSV) is the
        // Takeoff dock panel; this is the one control the GESTURE needs, and
        // it reads the same module store the panel writes.
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.count.groupPicker')}
        >
          {countGroups.length === 0 ? (
            <span className="secondary-toolbar-hint" data-testid="count-no-groups">
              {tChrome('canvas.count.noGroups')}
            </span>
          ) : (
            countGroups.map((g) => (
              <button
                key={g.name}
                type="button"
                data-testid={`count-group-${g.name}`}
                className={'secondary-tool' + (takeoff.armed === g.name ? ' active' : '')}
                aria-pressed={takeoff.armed === g.name}
                title={tChrome('canvas.count.armTitle', { group: g.name })}
                onClick={() => armCountGroup(g)}
              >
                <CountSymbolGlyph symbol={g.symbol} color={g.color} size={14} />
                <span>{g.name}</span>
              </button>
            ))
          )}
        </div>
      )}
      {tool === 'stamp' && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.stamp.presetGroup')}
        >
          {STAMP_PRESETS.map((preset) => {
            // The WORD localizes (it is stamped into the document); the
            // stable id is what identity, test ids and comparisons use.
            const p: StampPreset = {
              ...preset,
              label: tChrome(`canvas.stamp.preset.${preset.id}` as CanvasStringKey),
            };
            // Armed-ness reads the stable ID, never the label: a live language
            // switch rewords the armed preset, and a label comparison would
            // silently unpress the button the user is standing on.
            const armed = stampPreset?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`stamp-preset-${preset.id}`}
                aria-pressed={armed}
                title={p.label}
                className="stamp-preset"
                onClick={() => onSetStampPreset(armed ? null : p)}
                style={{
                  color: p.color,
                  borderColor: p.color,
                  backgroundColor: armed ? `${p.color}33` : 'transparent',
                }}
              >
                {p.label}
              </button>
            );
          })}
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
                        ? tChrome('canvas.stamp.dynamic', { label: s.label })
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
                  title={tChrome('canvas.stamp.remove')}
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
            {tChrome('canvas.stamp.new')}
          </button>
          <button
            type="button"
            data-testid="stamp-new-image"
            className="secondary-tool"
            onClick={() => void addImageStamp()}
          >
            {tChrome('canvas.stamp.fromImage')}
          </button>
          <button
            type="button"
            data-testid="stamp-symbols-toggle"
            className={'secondary-tool' + (showSymbols ? ' active' : '')}
            aria-expanded={showSymbols}
            title={tChrome('canvas.stamp.symbolsHint')}
            onClick={() => setShowSymbols((v) => !v)}
          >
            {tChrome('canvas.stamp.symbols')}
          </button>
        </div>
      )}
      {tool === 'stamp' && showSymbols && (
        // N11 slice D — the SAME palette the Takeoff panel picks markers from
        // (one registry, two consumers). Dragging a symbol onto the page
        // places it; clicking arms it for click-placement, exactly like a
        // preset pill.
        //
        // A POPOVER, not another row of the strip (the snap-popover
        // precedent). A wrapped full-width row inside the strip overflowed its
        // box and was painted UNDER the document view, which left a palette
        // that looked present, answered `waitForDisplayed`, and could not be
        // pressed. It would also have reflowed the page every time it opened.
        <div
          className="symbol-palette-popover"
          role="group"
          aria-label={tChrome('panel.symbols.title')}
        >
          <SymbolPalette
            mode="place"
            idPrefix="stamp-symbol"
            compact
            color={toolColor ?? SYMBOL_STAMP_COLOR}
            selectedId={stampPreset?.symbolId}
            onPick={(hit) =>
              onSetStampPreset(
                stampPreset?.symbolId === hit.symbol.id
                  ? null
                  : {
                      // The ID is identity; the localized name is the stamp's
                      // TEXT (it lands in /Contents like a preset's word).
                      label: symbolDisplayName(hit.set, hit.symbol),
                      color: toolColor ?? SYMBOL_STAMP_COLOR,
                      symbolId: hit.symbol.id,
                      symbolParts: hit.symbol.parts,
                    },
              )
            }
          />
        </div>
      )}
      {tool === 'stamp' && showNewStamp && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.stamp.newGroup')}
        >
          <input
            type="text"
            data-testid="stamp-new-label"
            value={newStampLabel}
            onChange={(e) => setNewStampLabel(e.target.value)}
            placeholder={tChrome('canvas.stamp.labelPlaceholder')}
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
            {tChrome('canvas.stamp.add')}
          </button>
        </div>
      )}

      {colored && (
        <div
          className="secondary-toolbar-opts"
          role="group"
          aria-label={tChrome('canvas.toolbar.colorGroup')}
        >
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
  useTranslation();
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
    <label className="secondary-toolbar-opacity" title={tChrome('canvas.edit.opacityTitle')}>
      {tChrome('canvas.edit.opacity')}
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
      <span data-testid="edit-image-opacity-value">
        {tChrome('canvas.edit.opacityValue', { value: tNumber(value) })}
      </span>
    </label>
  );
}
