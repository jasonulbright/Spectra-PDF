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
  ACTION_KIND_LABEL,
  ACTION_TRIGGERS,
  ACTION_TRIGGER_LABEL,
  AUTHORED_KINDS,
  SUBMIT_FORMATS,
  defaultAction,
  type ActionTrigger,
  type AuthoredAction,
  type AuthoredKind,
  type SubmitFormat,
} from '../lib/field-actions';
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

// ── the data actions ──────────────────────────────────────────────────────
//
// The `/AA` and `/A` kinds that carry no code, and are therefore both authored
// here and PERFORMED on the canvas. Kept a separate control from the value
// actions above because they answer a different question — that one is "what
// does this field hold", this one is "what does this field DO" — and because
// only the field-properties home edits them.
//
// One rule it exists to hold: a submission is described honestly at the point
// it is authored. The note under the address says what will happen when the
// button is used, so nobody authors a submit expecting this app to send it.

/** The field names an action may scope itself to, plus what a page picker
 * ranges over. */
export interface ActionContext {
  fieldNames: readonly string[];
  pageCount: number;
}

function scopeMode(action: AuthoredAction): 'all' | 'only' | 'except' {
  if (action.kind !== 'reset' && action.kind !== 'submit') return 'all';
  if (!action.fields || action.fields.length === 0) return 'all';
  return action.exclude ? 'except' : 'only';
}

export function FieldDataActionsControl({
  value,
  onChange,
  context,
  idPrefix,
  unauthorable = [],
}: {
  value: readonly AuthoredAction[];
  onChange: (next: AuthoredAction[]) => void;
  context: ActionContext;
  idPrefix: string;
  /** Triggers carrying a kind this app does not author. Applying here removes
   * them, so the editor says so rather than dropping them silently. */
  unauthorable?: readonly ActionTrigger[];
}): React.ReactElement {
  const used = new Set(value.map((a) => a.trigger));
  const free = ACTION_TRIGGERS.filter((t) => !used.has(t));
  const replace = (index: number, next: AuthoredAction): void =>
    onChange(value.map((a, i) => (i === index ? next : a)));
  const names = (list: string[] | null): string[] => list ?? [];

  const scopeControls = (
    action: Extract<AuthoredAction, { kind: 'reset' | 'submit' }>,
    index: number,
  ): React.ReactElement => {
    const mode = scopeMode(action);
    return (
      <>
        {labelled(
          tChrome('panel.fieldActions.actionScope'),
          <select
            data-testid={`${idPrefix}-action-${index}-scope`}
            aria-label={tChrome('panel.fieldActions.actionScope')}
            className={SELECT}
            value={mode}
            onChange={(e) => {
              const next = e.target.value;
              replace(index, {
                ...action,
                fields: next === 'all' ? null : names(action.fields),
                exclude: next === 'except',
              });
            }}
          >
            <option value="all">{tChrome('panel.fieldActions.actionScopeAll')}</option>
            <option value="only">{tChrome('panel.fieldActions.actionScopeOnly')}</option>
            <option value="except">{tChrome('panel.fieldActions.actionScopeExcept')}</option>
          </select>,
        )}
        {mode !== 'all' &&
          fieldPicker(
            `${idPrefix}-action-${index}-fields`,
            context.fieldNames,
            names(action.fields),
            (next) => replace(index, { ...action, fields: next }),
          )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`${idPrefix}-data-actions`}>
      <span className="text-xs text-neutral-400">{tChrome('panel.fieldActions.actions')}</span>
      {value.length === 0 && (
        <p className="text-[11px] text-neutral-500">
          {tChrome('panel.fieldActions.actionsNone')}
        </p>
      )}
      {value.map((action, index) => (
        <div
          key={action.trigger}
          className="flex flex-col gap-1.5 rounded border border-neutral-700 p-2"
          data-testid={`${idPrefix}-action-${index}`}
        >
          {labelled(
            tChrome('panel.fieldActions.actionTrigger'),
            <select
              data-testid={`${idPrefix}-action-${index}-trigger`}
              aria-label={tChrome('panel.fieldActions.actionTrigger')}
              className={SELECT}
              value={action.trigger}
              onChange={(e) =>
                replace(index, { ...action, trigger: e.target.value as ActionTrigger })
              }
            >
              {ACTION_TRIGGERS.filter((t) => t === action.trigger || !used.has(t)).map((t) => (
                <option key={t} value={t}>
                  {tChrome(ACTION_TRIGGER_LABEL[t])}
                </option>
              ))}
            </select>,
          )}
          {labelled(
            tChrome('panel.fieldActions.actionKind'),
            <select
              data-testid={`${idPrefix}-action-${index}-kind`}
              aria-label={tChrome('panel.fieldActions.actionKind')}
              className={SELECT}
              value={action.kind}
              onChange={(e) =>
                // A fresh action of the new kind: switching from Go to a page
                // to Submit must not leave a page behind as the new kind's
                // only member.
                replace(index, defaultAction(e.target.value as AuthoredKind, action.trigger))
              }
            >
              {AUTHORED_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {tChrome(ACTION_KIND_LABEL[kind])}
                </option>
              ))}
            </select>,
          )}

          {action.kind === 'goto' &&
            labelled(
              tChrome('panel.fieldActions.actionPage'),
              <input
                data-testid={`${idPrefix}-action-${index}-page`}
                type="number"
                min={1}
                max={Math.max(1, context.pageCount)}
                className={INPUT}
                value={action.page + 1}
                onChange={(e) =>
                  replace(index, {
                    ...action,
                    page: Math.max(0, Number(e.target.value) - 1),
                  })
                }
              />,
            )}

          {action.kind === 'uri' &&
            labelled(
              tChrome('panel.fieldActions.actionAddress'),
              <input
                data-testid={`${idPrefix}-action-${index}-uri`}
                type="text"
                className={INPUT}
                value={action.uri}
                onChange={(e) => replace(index, { ...action, uri: e.target.value })}
              />,
            )}

          {action.kind === 'import' &&
            labelled(
              tChrome('panel.fieldActions.actionFile'),
              <input
                data-testid={`${idPrefix}-action-${index}-file`}
                type="text"
                className={INPUT}
                value={action.file}
                onChange={(e) => replace(index, { ...action, file: e.target.value })}
              />,
            )}

          {action.kind === 'hide' && (
            <>
              {labelled(
                tChrome('panel.fieldActions.actionDirection'),
                <select
                  data-testid={`${idPrefix}-action-${index}-hide`}
                  aria-label={tChrome('panel.fieldActions.actionDirection')}
                  className={SELECT}
                  value={action.hide ? 'hide' : 'show'}
                  onChange={(e) =>
                    replace(index, { ...action, hide: e.target.value === 'hide' })
                  }
                >
                  <option value="hide">{tChrome('panel.fieldActions.actionHideThem')}</option>
                  <option value="show">{tChrome('panel.fieldActions.actionShow')}</option>
                </select>,
              )}
              {fieldPicker(
                `${idPrefix}-action-${index}-targets`,
                context.fieldNames,
                action.targets,
                (next) => replace(index, { ...action, targets: next }),
              )}
            </>
          )}

          {action.kind === 'reset' && scopeControls(action, index)}

          {action.kind === 'submit' && (
            <>
              {labelled(
                tChrome('panel.fieldActions.actionAddress'),
                <input
                  data-testid={`${idPrefix}-action-${index}-url`}
                  type="text"
                  className={INPUT}
                  value={action.url}
                  onChange={(e) => replace(index, { ...action, url: e.target.value })}
                />,
              )}
              {labelled(
                tChrome('panel.fieldActions.actionFormat'),
                <select
                  data-testid={`${idPrefix}-action-${index}-format`}
                  aria-label={tChrome('panel.fieldActions.actionFormat')}
                  className={SELECT}
                  value={action.format}
                  onChange={(e) =>
                    replace(index, { ...action, format: e.target.value as SubmitFormat })
                  }
                >
                  {SUBMIT_FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {format.toUpperCase()}
                    </option>
                  ))}
                </select>,
              )}
              {labelled(
                tChrome('panel.fieldActions.actionMethod'),
                <select
                  data-testid={`${idPrefix}-action-${index}-method`}
                  aria-label={tChrome('panel.fieldActions.actionMethod')}
                  className={SELECT}
                  value={action.method}
                  onChange={(e) =>
                    replace(index, { ...action, method: e.target.value === 'get' ? 'get' : 'post' })
                  }
                >
                  <option value="post">{tChrome('panel.fieldActions.actionMethodPost')}</option>
                  <option value="get">{tChrome('panel.fieldActions.actionMethodGet')}</option>
                </select>,
              )}
              <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={action.includeEmpty}
                  onChange={() => replace(index, { ...action, includeEmpty: !action.includeEmpty })}
                  className="rounded bg-neutral-800 border-neutral-700"
                />
                {tChrome('panel.fieldActions.actionIncludeEmpty')}
              </label>
              {scopeControls(action, index)}
              <p className="text-[11px] text-neutral-500">
                {tChrome('panel.fieldActions.actionSubmitNote')}
              </p>
            </>
          )}

          <button
            type="button"
            data-testid={`${idPrefix}-action-${index}-remove`}
            className="self-start text-[11px] danger-action is-quiet"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            {tChrome('panel.fieldActions.actionRemove')}
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <button
          type="button"
          data-testid={`${idPrefix}-action-add`}
          className="self-start rounded border border-neutral-700 px-2 py-1 text-xs hover:border-neutral-500"
          onClick={() => onChange([...value, defaultAction('goto', free[0])])}
        >
          {tChrome('panel.fieldActions.actionAdd')}
        </button>
      )}
      {unauthorable.length > 0 && (
        <p className="text-[11px] text-amber-300" data-testid={`${idPrefix}-action-unauthorable`}>
          {tChrome('panel.fieldActions.actionUnauthorable', {
            kinds: unauthorable.join(', '),
          })}
        </p>
      )}
    </div>
  );
}

/** A checkbox list of field names — the shape the calculate picker already
 * uses, shared so a scope and a calculation are chosen the same way. */
function fieldPicker(
  id: string,
  names: readonly string[],
  chosen: readonly string[],
  onChange: (next: string[]) => void,
): React.ReactElement {
  if (names.length === 0) {
    return <p className="text-[11px] text-neutral-500">{tChrome('panel.fieldActions.noFields')}</p>;
  }
  return (
    <div
      className="max-h-32 overflow-auto rounded border border-neutral-700 bg-neutral-800 p-1.5 flex flex-col gap-1"
      role="group"
      aria-label={tChrome('panel.fieldActions.actionTargets')}
    >
      {names.map((name) => (
        <label key={name} className="flex items-center gap-2 text-xs text-neutral-300">
          <input
            data-testid={`${id}-${name}`}
            type="checkbox"
            checked={chosen.includes(name)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...chosen, name] : chosen.filter((n) => n !== name),
              )
            }
          />
          <span className="truncate">{name}</span>
        </label>
      ))}
    </div>
  );
}
