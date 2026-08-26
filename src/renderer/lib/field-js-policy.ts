// Which field scripts run where, and what a body is allowed to reach.
//
// One partition, used by the FormsPanel, the canvas overlay and the sandbox
// host alike: a body the declarative recognizer accepts is DECLARATIVE and is
// evaluated by `af-calc.ts` with no JavaScript engine in the process; anything
// else is CUSTOM and is a candidate for the QuickJS sandbox. A custom body
// never becomes declarative and a declarative body never reaches the sandbox,
// whatever the preference reads — `tests/fixtures/af-corpus.json` stays
// authoritative for the declarative set.
//
// Pure module: no worker, no DOM, no Tauri. `field-js-host.ts` owns the
// engine; this owns the rules about it.
import { recognize, unrunnable } from './af-calc';
import type { FormField, FormFieldActions } from './forms';

/** The `/AA` triggers whose `/JS` this app can execute. `/K` `/F` `/V` `/C`
 * carry value semantics (F23's four); `/Fo` and `/Bl` are the focus pair the
 * wild corpus shows driving field appearance. */
export const JS_TRIGGERS = ['K', 'F', 'V', 'C', 'Fo', 'Bl'] as const;
export type JsTrigger = (typeof JS_TRIGGERS)[number];

/** The four triggers F23 reports on when scripting is OFF. Kept separate from
 * `JS_TRIGGERS` on purpose: the off-state report is preserved exactly as it
 * shipped, so turning the preference on is the only thing that changes it. */
export const DECLARATIVE_TRIGGERS = ['K', 'V', 'C', 'F'] as const;

/** Members of the object model that exist by name and do nothing — the
 * vendored sandbox stubs each of these, so no script can reach the network,
 * the filesystem, a mail client or a printer through one. Named here only so a
 * body that calls one can be REPORTED; the incapability is upstream's, not a
 * denylist this code enforces. */
export const REFUSED_CAPABILITIES = [
  'launchURL',
  'mailDoc',
  'mailForm',
  'submitForm',
  'saveAs',
  'exportAsFDF',
  'exportAsFDFStr',
  'exportDataObject',
  'importAnFDF',
  'importDataObject',
  'importTextData',
  'createDataObject',
  'getDataObjectContents',
  'setDataObjectContents',
  'print',
  'getOCGs',
  'browseForDoc',
  'openDoc',
  'closeDoc',
  'execMenuItem',
] as const;

// Word-boundary match on the member name. A body is source text, so this is a
// report over text and is described as one: it can over-report (the name in a
// string literal) and cannot under-report a plain call, which is the direction
// that matters for a disclosure.
const REFUSED_PATTERN = new RegExp(`\\b(?:${REFUSED_CAPABILITIES.join('|')})\\s*\\(`, 'g');

/** The refused capabilities a body names, in source order, without repeats. */
export function refusedCapabilities(js: string): string[] {
  const found: string[] = [];
  REFUSED_PATTERN.lastIndex = 0;
  for (let m = REFUSED_PATTERN.exec(js); m !== null; m = REFUSED_PATTERN.exec(js)) {
    const name = m[0].slice(0, m[0].indexOf('(')).trim();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Whether a body is one the declarative evaluator runs. A recognized script
 * that `unrunnable` rejects (a shape recognized but not executable for any
 * value) is NOT declarative — it is exactly what F23 refused. */
export function isDeclarative(js: string): boolean {
  const script = recognize(js);
  return script !== null && !unrunnable(script);
}

export interface ScriptEntry {
  field: string;
  trigger: JsTrigger;
  js: string;
  /** True when `af-calc` runs this body and the sandbox must not see it. */
  declarative: boolean;
  /** Refused capabilities this body names (empty for almost every body). */
  refused: string[];
}

export interface ScriptInventory {
  /** Every `/JS` body the document's fields carry, by field and trigger. */
  entries: ScriptEntry[];
  /** The custom (non-declarative) subset — the sandbox's whole input. */
  custom: ScriptEntry[];
}

function actionsOf(field: FormField): FormFieldActions | undefined {
  return field.actions;
}

/** Partition every field script in a document. The one place the
 * declarative/custom split is made. */
export function scriptInventory(fields: readonly FormField[]): ScriptInventory {
  const entries: ScriptEntry[] = [];
  for (const field of fields) {
    const actions = actionsOf(field);
    if (!actions) continue;
    for (const trigger of JS_TRIGGERS) {
      const js = actions[trigger];
      if (typeof js !== 'string' || js.trim() === '') continue;
      entries.push({
        field: field.name,
        trigger,
        js,
        declarative: isDeclarative(js),
        refused: refusedCapabilities(js),
      });
    }
  }
  return { entries, custom: entries.filter((e) => !e.declarative) };
}

/** Whether a document has anything for the sandbox to do. A form whose scripts
 * are all declarative never builds a worker and never loads the interpreter. */
export function needsSandbox(inventory: ScriptInventory, docScriptCount: number): boolean {
  return inventory.custom.length > 0 || docScriptCount > 0;
}

/** The resolved answer to "do field scripts run here", for the panel, the
 * canvas and the settings control alike.
 *
 * The enterprise policy outranks the preference: when the machine key is set
 * the scripts do not run however the preference reads, and the control says so
 * rather than claiming to decide something it does not.
 *
 * `null` is the machine key NOT YET READ. Execution treats it as disabled —
 * nothing may run before the policy is known — while the surfaces that
 * WORD the reason say nothing at all, because an administrator lockout that
 * has not been established is not a thing to tell anyone about. */
export function fieldScriptsEnabled(
  preference: boolean,
  policyDisabled: boolean | null,
): boolean {
  return preference && policyDisabled === false;
}

/** Why a document's custom scripts are not running, or null when they are.
 * `unknown` is the pre-policy-read window: not a reason, an absence of one. */
export type ScriptSuppression = 'policy' | 'preference' | 'unknown' | null;

export function scriptSuppression(
  preference: boolean,
  policyDisabled: boolean | null,
): ScriptSuppression {
  if (policyDisabled === null) return 'unknown';
  if (policyDisabled) return 'policy';
  if (!preference) return 'preference';
  return null;
}

/** Why one script did not produce a value, when it did not. */
export type ScriptFailureKind = 'refused' | 'error' | 'timeout';

export interface ScriptRunReport {
  field: string;
  trigger: JsTrigger;
  kind: ScriptFailureKind;
  /** Refused capability names, or the error text — never a localized string:
   * the panel decides the wording, this carries the fact. */
  detail: string;
}
