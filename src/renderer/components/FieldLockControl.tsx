// The field-lock control, shared by both signing surfaces (the Signatures
// panel's sign form and the canvas sign card) so the two cannot offer
// different vocabularies for the same `/FieldMDP` policy.
//
// Field names are PICKED, never typed: the engine refuses a lock naming a
// field the document does not carry, and it refuses because a mistyped name
// locks nothing under `include` and everything-but-a-typo under `exclude` —
// invisible in both directions. It is the document that knows its names.
import React from 'react';
import { tChrome } from '../i18n';
import {
  LOCK_ACTIONS,
  lockNeedsFields,
  type LockAction,
  type LockOptions,
} from '../lib/signatures';

const ACTION_LABEL = {
  all: 'panel.sig.lockActionAll',
  include: 'panel.sig.lockActionInclude',
  exclude: 'panel.sig.lockActionExclude',
} as const satisfies Record<LockAction, string>;

export function FieldLockControl({
  value,
  onChange,
  fieldNames,
  idPrefix,
}: {
  value: LockOptions;
  onChange: (next: LockOptions) => void;
  /** The document's fillable field names; signature fields are not among them. */
  fieldNames: readonly string[];
  idPrefix: string;
}): React.ReactElement {
  if (fieldNames.length === 0) {
    return (
      <p data-testid={`${idPrefix}-lock-unavailable`} className="text-[11px] text-neutral-500">
        {tChrome('panel.sig.lockNoFields')}
      </p>
    );
  }
  const toggle = (name: string, on: boolean) =>
    onChange({
      ...value,
      fields: on ? [...value.fields, name] : value.fields.filter((f) => f !== name),
    });
  return (
    <div className="flex flex-col gap-1.5" data-testid={`${idPrefix}-lock-group`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400 w-20 shrink-0">{tChrome('panel.sig.lock')}</span>
        <select
          data-testid={`${idPrefix}-lock-action`}
          value={value.action ?? ''}
          aria-label={tChrome('panel.sig.lock')}
          onChange={(e) =>
            onChange({
              action: (e.target.value || null) as LockAction | null,
              // Names chosen for one action stay chosen when it changes; the
              // request drops them only where the format ignores them.
              fields: value.fields,
            })
          }
          className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="">{tChrome('panel.sig.lockOff')}</option>
          {LOCK_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {tChrome(ACTION_LABEL[action])}
            </option>
          ))}
        </select>
      </div>
      {value.action !== null && (
        <p className="text-[11px] text-neutral-500">{tChrome('panel.sig.lockHint')}</p>
      )}
      {lockNeedsFields(value.action) && (
        <div className="flex items-start gap-2">
          <span className="text-xs text-neutral-400 w-20 shrink-0 pt-0.5">
            {tChrome('panel.sig.lockFields')}
          </span>
          <div
            className="flex-1 max-h-32 overflow-auto rounded border border-neutral-700 bg-neutral-800 p-1.5 flex flex-col gap-1"
            role="group"
            aria-label={tChrome('panel.sig.lockFields')}
          >
            {fieldNames.map((name) => (
              <label key={name} className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  data-testid={`${idPrefix}-lock-field-${name}`}
                  type="checkbox"
                  checked={value.fields.includes(name)}
                  onChange={(e) => toggle(name, e.target.checked)}
                />
                <span className="truncate">{name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
