import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { dialog, file } from '../lib/tauri-bridge';
import {
  DEFAULT_REDACTION_PROPERTIES,
  hexToRgb,
  loadRedactionProperties,
  rgbToHex,
  saveRedactionProperties,
  subscribeRedactionProperties,
  type RedactionProperties,
} from '../lib/redaction-properties';
import {
  BUILTIN_CODE_SETS,
  addCodeSet,
  codeSetToJson,
  getCodeSets,
  parseCodeSetFile,
  subscribeCodeSets,
  type RedactionCode,
  type RedactionCodeSet,
} from '../lib/redaction-codes';

// Redaction properties (F15 slice E — brief 42 § 6).
//
// The mark's APPEARANCE, in the format's own vocabulary: `/IC` fill,
// `/OverlayText`, `/Repeat`, `/Q` and the size/colour half of `/DA`. It is
// ONE control surface for BOTH producers — the band drawn on the canvas and
// every mark Search & Redact makes read the same persisted record, because
// these are how the user works rather than a property of a file.
//
// The redaction CODE picker sits here too: a code's label IS the overlay
// text (the format has no separate key), so choosing `(b)(6)` sets the
// overlay to `(b)(6)` and remembers which code that was, purely so the picker
// can show it selected again.

/** A built-in code's description, localized; a user set's, verbatim.
 *
 * The LABEL is never translated — it is the statutory citation itself, and it
 * is what gets DRAWN into the file, so a translated one would misname the
 * exemption a release is checked against. The DESCRIPTION is our prose about
 * it, and it localizes like every other built-in catalogue label does (the
 * symbol-name precedent). A user set has no catalog keys and is shown as the
 * firm wrote it. */
function describeCode(setId: string, code: RedactionCode): string {
  if (!BUILTIN_CODE_SETS.some((s) => s.id === setId)) return code.description;
  return tChrome(`panel.redactProps.desc.${setId}.${code.id}` as Parameters<typeof tChrome>[0]);
}

function setName(set: RedactionCodeSet): string {
  if (!BUILTIN_CODE_SETS.some((s) => s.id === set.id)) return set.name;
  return tChrome(`panel.redactProps.set.${set.id}` as Parameters<typeof tChrome>[0]);
}

export function RedactionPropertiesFields(): React.JSX.Element {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const [props, setProps] = useState<RedactionProperties>(() => loadRedactionProperties());
  const [sets, setSets] = useState(() => getCodeSets());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeRedactionProperties(() => setProps(loadRedactionProperties())), []);
  useEffect(() => subscribeCodeSets(() => setSets(getCodeSets())), []);

  const update = useCallback((patch: Partial<RedactionProperties>) => {
    const next = { ...loadRedactionProperties(), ...patch };
    setProps(next);
    saveRedactionProperties(next);
  }, []);

  const pickCode = useCallback(
    (reference: string) => {
      if (!reference) {
        update({ codeRef: '', overlayText: '' });
        return;
      }
      const slash = reference.indexOf('/');
      const set = getCodeSets().find((s) => s.id === reference.slice(0, slash));
      const code = set?.codes.find((c) => c.id === reference.slice(slash + 1));
      if (!code) return;
      // The LABEL is the overlay text — there is no /Code key in the format,
      // and inventing a private one would make the mark unreadable to every
      // other viewer.
      update({ codeRef: reference, overlayText: code.label });
    },
    [update],
  );

  const importSet = useCallback(async () => {
    const path = await dialog.pickAnyFile();
    if (!path) return;
    const text = new TextDecoder('utf-8').decode(await file.readBuffer(path));
    const parsed = parseCodeSetFile(text);
    if (!parsed.set) {
      setNotice(
        tChrome(
          `panel.redactProps.import.${parsed.refusal}` as Parameters<typeof tChrome>[0],
        ),
      );
      return;
    }
    const outcome = addCodeSet(parsed.set);
    setSets(getCodeSets());
    setNotice(
      tChrome(
        outcome === 'added' ? 'panel.redactProps.imported' : 'panel.redactProps.updated',
        { name: parsed.set.name, count: parsed.set.codes.length },
      ),
    );
  }, []);

  const exportSet = useCallback(async () => {
    const setId = props.codeRef.split('/')[0];
    const set = getCodeSets().find((s) => s.id === setId) ?? getCodeSets()[0];
    if (!set) return;
    const target = await dialog.saveFile({ defaultPath: `${set.id}.json` });
    if (!target) return;
    await file.writeBuffer(target, new TextEncoder().encode(codeSetToJson(set)));
    setNotice(tChrome('panel.redactProps.exported', { name: set.name }));
  }, [props.codeRef]);

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="redaction-properties">
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400 w-24">
          {tChrome('panel.redactProps.fill')}
        </label>
        <input
          type="color"
          value={rgbToHex(props.fill)}
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) update({ fill: rgb });
          }}
          aria-label={tChrome('panel.redactProps.fill')}
          data-testid="redact-props-fill"
          className="h-7 w-12 bg-neutral-800 border border-neutral-700 rounded"
        />
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400 w-24">
          {tChrome('panel.redactProps.code')}
        </label>
        <select
          value={props.codeRef}
          onChange={(e) => pickCode(e.target.value)}
          aria-label={tChrome('panel.redactProps.code')}
          data-testid="redact-props-code"
          className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="">{tChrome('panel.redactProps.noCode')}</option>
          {sets.map((set) => (
            <optgroup key={set.id} label={setName(set)}>
              {set.codes.map((code) => (
                <option key={code.id} value={`${set.id}/${code.id}`}>
                  {code.label} — {describeCode(set.id, code)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-400 w-24">
          {tChrome('panel.redactProps.overlay')}
        </label>
        <input
          type="text"
          value={props.overlayText}
          onChange={(e) => update({ overlayText: e.target.value, codeRef: '' })}
          placeholder={tChrome('panel.redactProps.overlayPlaceholder')}
          aria-label={tChrome('panel.redactProps.overlay')}
          data-testid="redact-props-overlay"
          className="flex-1 min-w-0 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
        />
      </div>

      {props.overlayText !== '' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-sm text-neutral-400 w-24">
              {tChrome('panel.redactProps.align')}
            </label>
            <select
              value={props.align}
              onChange={(e) => update({ align: Number(e.target.value) as 0 | 1 | 2 })}
              aria-label={tChrome('panel.redactProps.align')}
              data-testid="redact-props-align"
              className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
            >
              <option value={0}>{tChrome('panel.redactProps.alignLeft')}</option>
              <option value={1}>{tChrome('panel.redactProps.alignCenter')}</option>
              <option value={2}>{tChrome('panel.redactProps.alignRight')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-neutral-400 w-24">
              {tChrome('panel.redactProps.size')}
            </label>
            <input
              type="number"
              min={0}
              max={144}
              step={0.5}
              value={props.fontSize}
              onChange={(e) => update({ fontSize: Math.max(Number(e.target.value) || 0, 0) })}
              aria-label={tChrome('panel.redactProps.size')}
              data-testid="redact-props-size"
              className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
            />
            <span className="text-xs text-neutral-500">
              {tChrome('panel.redactProps.sizeAuto')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-neutral-400 w-24">
              {tChrome('panel.redactProps.textColor')}
            </label>
            <input
              type="color"
              value={rgbToHex(props.textColor ?? [1, 1, 1])}
              onChange={(e) => {
                const rgb = hexToRgb(e.target.value);
                if (rgb) update({ textColor: rgb });
              }}
              aria-label={tChrome('panel.redactProps.textColor')}
              data-testid="redact-props-textcolor"
              className="h-7 w-12 bg-neutral-800 border border-neutral-700 rounded"
            />
            {props.textColor && (
              <button
                type="button"
                onClick={() => update({ textColor: null })}
                className="text-xs text-neutral-400 hover:text-white"
              >
                {tChrome('panel.redactProps.textColorAuto')}
              </button>
            )}
          </div>

          <label className="flex items-center gap-1.5 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={props.repeatOverlay}
              onChange={(e) => update({ repeatOverlay: e.target.checked })}
              data-testid="redact-props-repeat"
            />
            {tChrome('panel.redactProps.repeat')}
          </label>
        </>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void importSet()}
          data-testid="redact-props-import"
          className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
        >
          {tChrome('panel.redactProps.importSet')}
        </button>
        <button
          type="button"
          onClick={() => void exportSet()}
          data-testid="redact-props-export"
          className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
        >
          {tChrome('panel.redactProps.exportSet')}
        </button>
        <button
          type="button"
          onClick={() => {
            setProps(DEFAULT_REDACTION_PROPERTIES);
            saveRedactionProperties(DEFAULT_REDACTION_PROPERTIES);
          }}
          data-testid="redact-props-reset"
          className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
        >
          {tChrome('panel.redactProps.reset')}
        </button>
      </div>
      {notice && <div className="text-xs text-neutral-400">{notice}</div>}
    </div>
  );
}
