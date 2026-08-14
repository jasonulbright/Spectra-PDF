// The Format / Accepted range / Calculate editor, shared by every surface that
// authors a form field so the placement card, the detection review row and the
// field-properties editor cannot offer different vocabularies for one `/AA`.
//
// Two rules this control exists to hold:
//
//   • A typographic choice is shown as a SAMPLE, never as a number. `sepStyle`
//     2 means "1.234,56"; a user choosing between five numbered separator
//     styles is choosing blind. The sample is rendered by the same evaluator
//     that will format the saved value, so what the picker shows is what the
//     page draws — and it follows the FORM's conventions, not the UI locale.
//   • An expression is validated as it is typed, by the recognizer that will
//     have to read it back. An expression this app cannot read is one no
//     viewer would compute the same way, so it is refused before the field is
//     created rather than after.
import React, { useMemo } from 'react';
import { tChrome } from '../i18n';
import { DATE_FORMATS, TIME_FORMATS, asStored, recognize, run } from '../lib/af-calc';
import {
  CALC_FUNCTIONS,
  NEG_STYLES,
  SEP_STYLES,
  SPECIAL_KINDS,
  formatScripts,
  type CalcFunction,
  type FieldCalculate,
  type FieldFormat,
  type NegStyle,
  type SepStyle,
  type SpecialKind,
} from '../lib/af-emit';
import type { FieldActions } from '../lib/form-candidates';

/** The control's own state: every member present, `null` meaning "not
 * authored". A draft is edited in place, so a half-typed expression survives a
 * re-render — which a `FieldActions` (whose absent members mean absent) could
 * not express. */
export interface FieldActionsDraft {
  format: FieldFormat | null;
  /** The accepted range, held as the two raw text inputs: an empty box is "no
   * bound", which is a different answer from zero. */
  min: string;
  max: string;
  calculate: FieldCalculate | null;
  /** The raw expression text, kept even while it does not parse. */
  expression: string;
  defaultValue: string;
}

export const EMPTY_ACTIONS: FieldActionsDraft = {
  format: null,
  min: '',
  max: '',
  calculate: null,
  expression: '',
  defaultValue: '',
};

const DEFAULT_NUMBER: FieldFormat = {
  kind: 'number',
  decimals: 2,
  sepStyle: 0,
  negStyle: 0,
  currency: '',
  currencyPrepend: true,
};
const DEFAULT_PERCENT: FieldFormat = { kind: 'percent', decimals: 2, sepStyle: 0, prepend: false };
const DEFAULT_DATE: FieldFormat = { kind: 'date', mask: 'mm/dd/yy' };
const DEFAULT_TIME: FieldFormat = { kind: 'time', mask: 'HH:MM' };
const DEFAULT_SPECIAL: FieldFormat = { kind: 'special', psf: 0 };
const DEFAULT_MASK: FieldFormat = { kind: 'mask', mask: '' };

const FORMAT_DEFAULT: Record<FieldFormat['kind'], FieldFormat> = {
  number: DEFAULT_NUMBER,
  percent: DEFAULT_PERCENT,
  date: DEFAULT_DATE,
  time: DEFAULT_TIME,
  special: DEFAULT_SPECIAL,
  mask: DEFAULT_MASK,
};

const FORMAT_LABEL = {
  number: 'panel.fieldActions.formatNumber',
  percent: 'panel.fieldActions.formatPercent',
  date: 'panel.fieldActions.formatDate',
  time: 'panel.fieldActions.formatTime',
  special: 'panel.fieldActions.formatSpecial',
  mask: 'panel.fieldActions.formatMask',
} as const satisfies Record<FieldFormat['kind'], string>;

const OP_LABEL = {
  SUM: 'panel.fieldActions.opSum',
  PRD: 'panel.fieldActions.opPrd',
  AVG: 'panel.fieldActions.opAvg',
  MIN: 'panel.fieldActions.opMin',
  MAX: 'panel.fieldActions.opMax',
} as const satisfies Record<CalcFunction, string>;

/** The masks `AFSpecial_Format` selects by index. Notation, not prose: the
 * option shows the mask itself, which is what the field will accept. */
const SPECIAL_MASK: Record<SpecialKind, string> = {
  0: '99999',
  1: '99999-9999',
  2: '(999) 999-9999',
  3: '999-99-9999',
};

/** One number rendered through each separator style — the whole i18n rule for
 * a formatted number, shown rather than numbered. */
const SEP_SAMPLE: Record<SepStyle, string> = {
  0: '1,234.56',
  1: '1234.56',
  2: '1.234,56',
  3: '1234,56',
  4: "1'234.56",
};

/** How a negative number reads under each style. The two red styles are named
 * by their own sample; the colour is the document's, not the UI's. */
const NEG_SAMPLE: Record<NegStyle, string> = {
  0: '-1,234.56',
  1: '(1,234.56)',
  2: '-1,234.56',
  3: '(1,234.56)',
};
const NEG_RED: Record<NegStyle, boolean> = { 0: false, 1: false, 2: true, 3: true };

/** The value each format kind is sampled with. A date and a time sample from
 * the clock so the mask reads as a real one; everything else is a fixed number
 * so the sample changes only when the setting does. */
function sampleSource(kind: FieldFormat['kind']): string {
  if (kind === 'date') {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  if (kind === 'time') {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  if (kind === 'special') return '123456789';
  if (kind === 'percent') return '0.125';
  return '1234.5';
}

/** What the page will draw for this format, computed by the evaluator that
 * will draw it. Null when the setting cannot produce one — a half-typed mask,
 * or a keystroke-only kind that has no display form. */
export function formatSample(format: FieldFormat | null): string | null {
  if (format === null) return null;
  try {
    const { F } = formatScripts(format);
    if (F === undefined) return null;
    const script = recognize(F);
    if (script === null) return null;
    return asStored(run(script, sampleSource(format.kind)).value);
  } catch {
    return null;
  }
}

/** The draft as the spec members the writers take. An empty member is absent,
 * not empty: `validate: {}` would refuse and `format: null` is not a format. */
export function draftToActions(draft: FieldActionsDraft): FieldActions {
  const out: FieldActions = {};
  if (draft.format !== null) out.format = draft.format;
  const min = draft.min.trim();
  const max = draft.max.trim();
  if (min !== '' || max !== '') {
    out.validate = {
      ...(min !== '' ? { min: Number(min) } : {}),
      ...(max !== '' ? { max: Number(max) } : {}),
    };
  }
  if (draft.calculate !== null) {
    out.calculate =
      'sfn' in draft.calculate ? { sfn: draft.expression.trim() } : draft.calculate;
  }
  if (draft.defaultValue !== '') out.defaultValue = draft.defaultValue;
  return out;
}

/** A stored `FieldActions` back as a draft — the properties editor seeds from
 * what the document already carries. */
export function actionsToDraft(actions: FieldActions | null): FieldActionsDraft {
  if (!actions) return EMPTY_ACTIONS;
  const calculate = actions.calculate ?? null;
  return {
    format: actions.format ?? null,
    min: actions.validate?.min !== undefined ? String(actions.validate.min) : '',
    max: actions.validate?.max !== undefined ? String(actions.validate.max) : '',
    calculate,
    expression: calculate !== null && 'sfn' in calculate ? calculate.sfn : '',
    defaultValue: actions.defaultValue ?? '',
  };
}

function labelled(text: string, body: React.ReactNode): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-400 w-24 shrink-0">{text}</span>
      {body}
    </div>
  );
}

const INPUT =
  'flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500';
const SELECT = 'flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs';

export function FieldActionsControl({
  value,
  onChange,
  fieldNames,
  idPrefix,
  showCalculate = true,
}: {
  value: FieldActionsDraft;
  onChange: (next: FieldActionsDraft) => void;
  /** The names this field's calculation may read: the document's other fields
   * plus whatever the same batch is creating. */
  fieldNames: readonly string[];
  idPrefix: string;
  /** Only a text field can be calculated; a dropdown still takes a format and
   * a range. */
  showCalculate?: boolean;
}): React.ReactElement {
  const set = (patch: Partial<FieldActionsDraft>): void => onChange({ ...value, ...patch });
  const format = value.format;
  const sample = useMemo(() => formatSample(format), [format]);
  const calculate = value.calculate;
  const mode: 'none' | CalcFunction | 'sfn' =
    calculate === null ? 'none' : 'sfn' in calculate ? 'sfn' : calculate.op;
  const chosen = calculate !== null && !('sfn' in calculate) ? calculate.fields : [];
  const expressionOk =
    mode !== 'sfn' ||
    value.expression.trim() === '' ||
    recognize(`event.value = ${value.expression.trim()};`) !== null;

  return (
    <div className="flex flex-col gap-1.5" data-testid={`${idPrefix}-actions`}>
      {labelled(
        tChrome('panel.fieldActions.format'),
        <select
          data-testid={`${idPrefix}-format-kind`}
          aria-label={tChrome('panel.fieldActions.format')}
          className={SELECT}
          value={format?.kind ?? ''}
          onChange={(e) =>
            set({ format: e.target.value === '' ? null : FORMAT_DEFAULT[e.target.value as FieldFormat['kind']] })
          }
        >
          <option value="">{tChrome('panel.fieldActions.formatNone')}</option>
          {(Object.keys(FORMAT_LABEL) as FieldFormat['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {tChrome(FORMAT_LABEL[kind])}
            </option>
          ))}
        </select>,
      )}

      {(format?.kind === 'number' || format?.kind === 'percent') && (
        <>
          {labelled(
            tChrome('panel.fieldActions.decimals'),
            <input
              data-testid={`${idPrefix}-decimals`}
              type="number"
              min={0}
              max={15}
              className={INPUT}
              value={format.decimals}
              onChange={(e) => set({ format: { ...format, decimals: Number(e.target.value) } })}
            />,
          )}
          {labelled(
            tChrome('panel.fieldActions.separator'),
            <select
              data-testid={`${idPrefix}-separator`}
              aria-label={tChrome('panel.fieldActions.separator')}
              className={SELECT}
              value={format.sepStyle}
              onChange={(e) => set({ format: { ...format, sepStyle: Number(e.target.value) as SepStyle } })}
            >
              {SEP_STYLES.map((style) => (
                <option key={style} value={style}>
                  {SEP_SAMPLE[style]}
                </option>
              ))}
            </select>,
          )}
        </>
      )}

      {format?.kind === 'number' && (
        <>
          {labelled(
            tChrome('panel.fieldActions.negative'),
            <select
              data-testid={`${idPrefix}-negative`}
              aria-label={tChrome('panel.fieldActions.negative')}
              className={SELECT}
              value={format.negStyle}
              onChange={(e) => set({ format: { ...format, negStyle: Number(e.target.value) as NegStyle } })}
            >
              {NEG_STYLES.map((style) => (
                <option key={style} value={style} className={NEG_RED[style] ? 'text-red-400' : undefined}>
                  {NEG_SAMPLE[style]}
                </option>
              ))}
            </select>,
          )}
          {labelled(
            tChrome('panel.fieldActions.currency'),
            <input
              data-testid={`${idPrefix}-currency`}
              type="text"
              className={INPUT}
              value={format.currency}
              onChange={(e) => set({ format: { ...format, currency: e.target.value } })}
            />,
          )}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={format.currencyPrepend}
              onChange={() => set({ format: { ...format, currencyPrepend: !format.currencyPrepend } })}
              className="rounded bg-neutral-800 border-neutral-700"
            />
            {tChrome('panel.fieldActions.currencyPrepend')}
          </label>
        </>
      )}

      {format?.kind === 'percent' && (
        <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={format.prepend}
            onChange={() => set({ format: { ...format, prepend: !format.prepend } })}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          {tChrome('panel.fieldActions.currencyPrepend')}
        </label>
      )}

      {(format?.kind === 'date' || format?.kind === 'time') &&
        labelled(
          tChrome('panel.fieldActions.mask'),
          <input
            data-testid={`${idPrefix}-mask`}
            type="text"
            list={`${idPrefix}-mask-list`}
            className={INPUT}
            value={format.mask}
            onChange={(e) => set({ format: { ...format, mask: e.target.value } })}
          />,
        )}
      {(format?.kind === 'date' || format?.kind === 'time') && (
        <datalist id={`${idPrefix}-mask-list`}>
          {(format.kind === 'date' ? DATE_FORMATS : TIME_FORMATS).map((mask) => (
            <option key={mask} value={mask} />
          ))}
        </datalist>
      )}

      {format?.kind === 'special' &&
        labelled(
          tChrome('panel.fieldActions.mask'),
          <select
            data-testid={`${idPrefix}-special`}
            aria-label={tChrome('panel.fieldActions.mask')}
            className={SELECT}
            value={format.psf}
            onChange={(e) => set({ format: { ...format, psf: Number(e.target.value) as SpecialKind } })}
          >
            {SPECIAL_KINDS.map((psf) => (
              <option key={psf} value={psf}>
                {SPECIAL_MASK[psf]}
              </option>
            ))}
          </select>,
        )}

      {format?.kind === 'mask' && (
        <>
          {labelled(
            tChrome('panel.fieldActions.mask'),
            <input
              data-testid={`${idPrefix}-custom-mask`}
              type="text"
              className={INPUT}
              value={format.mask}
              onChange={(e) => set({ format: { ...format, mask: e.target.value } })}
            />,
          )}
          <p className="text-[11px] text-neutral-500">{tChrome('panel.fieldActions.maskHint')}</p>
        </>
      )}

      {sample !== null && (
        <p className="text-[11px] text-neutral-500" data-testid={`${idPrefix}-sample`}>
          {tChrome('panel.fieldActions.sample', { sample })}
        </p>
      )}

      {labelled(
        tChrome('panel.fieldActions.validate'),
        <div className="flex-1 flex items-center gap-1.5">
          <input
            data-testid={`${idPrefix}-min`}
            type="text"
            inputMode="decimal"
            aria-label={tChrome('panel.fieldActions.min')}
            placeholder={tChrome('panel.fieldActions.min')}
            className={INPUT}
            value={value.min}
            onChange={(e) => set({ min: e.target.value })}
          />
          <input
            data-testid={`${idPrefix}-max`}
            type="text"
            inputMode="decimal"
            aria-label={tChrome('panel.fieldActions.max')}
            placeholder={tChrome('panel.fieldActions.max')}
            className={INPUT}
            value={value.max}
            onChange={(e) => set({ max: e.target.value })}
          />
        </div>,
      )}

      {showCalculate &&
        labelled(
          tChrome('panel.fieldActions.calculate'),
          <select
            data-testid={`${idPrefix}-calculate`}
            aria-label={tChrome('panel.fieldActions.calculate')}
            className={SELECT}
            value={mode}
            onChange={(e) => {
              const next = e.target.value;
              if (next === 'none') set({ calculate: null });
              else if (next === 'sfn') set({ calculate: { sfn: value.expression } });
              else set({ calculate: { op: next as CalcFunction, fields: chosen } });
            }}
          >
            <option value="none">{tChrome('panel.fieldActions.calculateNone')}</option>
            {CALC_FUNCTIONS.map((op) => (
              <option key={op} value={op}>
                {tChrome(OP_LABEL[op])}
              </option>
            ))}
            <option value="sfn">{tChrome('panel.fieldActions.calculateExpression')}</option>
          </select>,
        )}

      {showCalculate && calculate !== null && !('sfn' in calculate) && (
        <div className="flex items-start gap-2">
          <span className="text-xs text-neutral-400 w-24 shrink-0 pt-0.5">
            {tChrome('panel.fieldActions.fields')}
          </span>
          {fieldNames.length === 0 ? (
            <p className="flex-1 text-[11px] text-neutral-500">
              {tChrome('panel.fieldActions.noFields')}
            </p>
          ) : (
            <div
              className="flex-1 max-h-32 overflow-auto rounded border border-neutral-700 bg-neutral-800 p-1.5 flex flex-col gap-1"
              role="group"
              aria-label={tChrome('panel.fieldActions.fields')}
            >
              {fieldNames.map((name) => (
                <label key={name} className="flex items-center gap-2 text-xs text-neutral-300">
                  <input
                    data-testid={`${idPrefix}-calc-field-${name}`}
                    type="checkbox"
                    checked={calculate.fields.includes(name)}
                    onChange={(e) =>
                      set({
                        calculate: {
                          op: calculate.op,
                          fields: e.target.checked
                            ? [...calculate.fields, name]
                            : calculate.fields.filter((f) => f !== name),
                        },
                      })
                    }
                  />
                  <span className="truncate">{name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {showCalculate && calculate !== null && 'sfn' in calculate && (
        <>
          {labelled(
            tChrome('panel.fieldActions.expression'),
            <input
              data-testid={`${idPrefix}-expression`}
              type="text"
              className={INPUT}
              placeholder={tChrome('panel.fieldActions.expressionPlaceholder')}
              value={value.expression}
              onChange={(e) => set({ expression: e.target.value, calculate: { sfn: e.target.value } })}
            />,
          )}
          {!expressionOk && (
            <p className="text-[11px] text-red-400" data-testid={`${idPrefix}-expression-invalid`}>
              {tChrome('panel.fieldActions.expressionInvalid')}
            </p>
          )}
        </>
      )}

      {labelled(
        tChrome('panel.fieldActions.defaultValue'),
        <input
          data-testid={`${idPrefix}-default`}
          type="text"
          className={INPUT}
          value={value.defaultValue}
          onChange={(e) => set({ defaultValue: e.target.value })}
        />,
      )}
    </div>
  );
}
