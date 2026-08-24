// The visible stamp's appearance section, shared by both signing surfaces
// (the Signatures panel's sign form and the canvas sign card) so the two
// cannot offer different vocabularies for the same appearance.
//
// The preview is the ENGINE'S drawing, rasterized. Nothing in this file draws
// a stamp: `renderStampPreview` asks the engine for the appearance as a
// one-page PDF and pdf.js paints it, so what the user approves here is the
// drawing the signature carries (lib/stamp-appearance).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { tChrome } from '../i18n';
import { dialog } from '../lib/tauri-bridge';
import {
  STAMP_FIELDS,
  STAMP_LAYOUTS,
  STAMP_POSITIONS,
  resolveStampFace,
  renderStampPreview,
  STAMP_FACE_MISSING,
  STAMP_FACE_UNREADABLE,
  type StampAppearanceOptions,
  type StampField,
  type StampLayout,
  type StampPosition,
} from '../lib/stamp-appearance';
import type { SignatureAsset } from '../lib/signature-assets';

const FIELD_LABEL = {
  name: 'panel.stamp.fieldName',
  date: 'panel.stamp.fieldDate',
  reason: 'panel.stamp.fieldReason',
  location: 'panel.stamp.fieldLocation',
  label: 'panel.stamp.fieldLabel',
} as const satisfies Record<StampField, string>;

const LAYOUT_LABEL = {
  over: 'panel.stamp.layoutOver',
  beside: 'panel.stamp.layoutBeside',
} as const satisfies Record<StampLayout, string>;

const POSITION_LABEL = {
  left: 'panel.stamp.positionLeft',
  right: 'panel.stamp.positionRight',
  top: 'panel.stamp.positionTop',
  bottom: 'panel.stamp.positionBottom',
} as const satisfies Record<StampPosition, string>;

/** The preview's own box, in points. A stamp's real box comes from the
 * placement or the field's widget; the preview states one so the fit rule has
 * something to answer about before either exists. */
const PREVIEW_WIDTH = 220;
const PREVIEW_HEIGHT = 70;

type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function StampAppearanceFields({
  value,
  onChange,
  assets,
  fontDir,
  signer,
  reason,
  location,
  call,
  idPrefix,
}: {
  value: StampAppearanceOptions;
  onChange: (next: StampAppearanceOptions) => void;
  /** The saved personal signatures, offered as face choices. */
  assets: readonly SignatureAsset[];
  /** The app's bundled fonts directory — where a typed face is resolved. */
  fontDir: string;
  /** What the stamp's name line will say. The certificate's subject when one
   * is known; a placeholder is honest about being one. */
  signer: string;
  reason: string;
  location: string;
  call: EngineCall;
  idPrefix: string;
}): React.ReactElement {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // The signing time the preview interpolates. Fixed for the section's life so
  // a preview does not re-render on every clock tick.
  const timestampRef = useRef(new Date().toISOString().slice(0, 19).replace('T', ' '));

  const toggleField = (field: StampField, on: boolean) => {
    // The order is the record's order, not click order: the engine renders
    // the lines in the order it is given them, and a stamp whose lines
    // shuffle by the order the boxes were ticked is not a design.
    const next = STAMP_FIELDS.filter((f) => (f === field ? on : value.fields.includes(f)));
    onChange({ ...value, fields: [...next] });
  };

  const pickImage = useCallback(async () => {
    const picked = await dialog.pickWatermarkImage();
    if (picked) onChange({ ...value, imagePath: picked });
  }, [value, onChange]);

  useEffect(() => {
    let cancelled = false;
    let face;
    try {
      face = resolveStampFace(value.signatureAssetId, assets);
    } catch (e) {
      const key =
        e instanceof Error && e.message === STAMP_FACE_MISSING
          ? 'panel.stamp.faceMissing'
          : e instanceof Error && e.message === STAMP_FACE_UNREADABLE
            ? 'panel.stamp.faceUnreadable'
            : null;
      setPreview(null);
      setPreviewError(key ? tChrome(key) : String(e));
      return;
    }
    void renderStampPreview(call, {
      options: value,
      face,
      fontDir,
      signer,
      reason,
      location,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      timestamp: timestampRef.current,
    })
      .then((url) => {
        if (cancelled) return;
        setPreview(url);
        setPreviewError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // The engine's refusal, shown as it is: it is the same refusal
        // signing would raise, raised before the user commits to it.
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [value, assets, fontDir, signer, reason, location, call]);

  const control = 'px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500';

  return (
    <div className="flex flex-col gap-2" data-testid={`${idPrefix}-stamp-group`}>
      <span className="text-xs text-neutral-400">{tChrome('panel.stamp.heading')}</span>

      <div className="flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={tChrome('panel.stamp.lines')}>
        {STAMP_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-1 text-xs text-neutral-300">
            <input
              type="checkbox"
              data-testid={`${idPrefix}-stamp-field-${field}`}
              checked={value.fields.includes(field)}
              onChange={(e) => toggleField(field, e.target.checked)}
            />
            {tChrome(FIELD_LABEL[field])}
          </label>
        ))}
      </div>

      {value.fields.includes('label') && (
        <input
          type="text"
          data-testid={`${idPrefix}-stamp-label`}
          value={value.label}
          aria-label={tChrome('panel.stamp.labelText')}
          placeholder={tChrome('panel.stamp.labelPlaceholder')}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          className={control}
        />
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${idPrefix}-stamp-image-pick`}
          onClick={() => void pickImage()}
          className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs hover:border-blue-500"
        >
          {tChrome('panel.stamp.chooseImage')}
        </button>
        <span className="text-[11px] text-neutral-500 truncate flex-1" data-testid={`${idPrefix}-stamp-image-path`}>
          {value.imagePath ?? tChrome('panel.stamp.noImage')}
        </span>
        {value.imagePath && (
          <button
            type="button"
            data-testid={`${idPrefix}-stamp-image-clear`}
            onClick={() => onChange({ ...value, imagePath: null })}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            {tChrome('panel.stamp.removeImage')}
          </button>
        )}
      </div>

      {value.imagePath && (
        <div className="flex items-center gap-2">
          <select
            data-testid={`${idPrefix}-stamp-layout`}
            value={value.layout}
            aria-label={tChrome('panel.stamp.layout')}
            onChange={(e) => onChange({ ...value, layout: e.target.value as StampLayout })}
            className={control}
          >
            {STAMP_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {tChrome(LAYOUT_LABEL[l])}
              </option>
            ))}
          </select>
          {value.layout === 'beside' ? (
            <select
              data-testid={`${idPrefix}-stamp-image-position`}
              value={value.imagePosition}
              aria-label={tChrome('panel.stamp.imagePosition')}
              onChange={(e) =>
                onChange({ ...value, imagePosition: e.target.value as StampPosition })
              }
              className={control}
            >
              {STAMP_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {tChrome(POSITION_LABEL[p])}
                </option>
              ))}
            </select>
          ) : (
            <label className="flex items-center gap-1 text-xs text-neutral-400">
              {tChrome('panel.stamp.imageOpacity')}
              <input
                type="range"
                min={0}
                max={100}
                data-testid={`${idPrefix}-stamp-image-opacity`}
                value={Math.round(value.imageOpacity * 100)}
                onChange={(e) =>
                  onChange({ ...value, imageOpacity: Number(e.target.value) / 100 })
                }
              />
            </label>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          data-testid={`${idPrefix}-stamp-signature`}
          value={value.signatureAssetId ?? ''}
          aria-label={tChrome('panel.stamp.face')}
          onChange={(e) =>
            onChange({ ...value, signatureAssetId: e.target.value || null })
          }
          className={`${control} flex-1`}
        >
          <option value="">{tChrome('panel.stamp.faceNone')}</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {value.signatureAssetId && (
          <select
            data-testid={`${idPrefix}-stamp-signature-position`}
            value={value.signaturePosition}
            aria-label={tChrome('panel.stamp.facePosition')}
            onChange={(e) =>
              onChange({ ...value, signaturePosition: e.target.value as StampPosition })
            }
            className={control}
          >
            {STAMP_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {tChrome(POSITION_LABEL[p])}
              </option>
            ))}
          </select>
        )}
      </div>
      {assets.length === 0 && (
        <p className="text-[11px] text-neutral-500">{tChrome('panel.stamp.faceEmpty')}</p>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400">{tChrome('panel.stamp.preview')}</span>
        {previewError ? (
          <p
            data-testid={`${idPrefix}-stamp-preview-error`}
            className="text-[11px] text-amber-400"
          >
            {previewError}
          </p>
        ) : preview ? (
          <img
            data-testid={`${idPrefix}-stamp-preview`}
            src={preview}
            alt={tChrome('panel.stamp.previewAlt')}
            className="border border-neutral-700 rounded bg-white self-start max-w-full"
          />
        ) : (
          <p className="text-[11px] text-neutral-500">{tChrome('panel.stamp.previewPending')}</p>
        )}
      </div>
    </div>
  );
}
