// The `/AA` and `/A` action kinds that are DATA rather than code — the
// renderer's half of `src/engine/fieldactions.py`.
//
// `lib/af-script.ts` reads the JavaScript half of a field's actions; this
// module carries the other half: an action that names a destination, an
// address, a field subset, a visibility change or a file to import. None of
// them is a script, so all of them are both reported and RUN without a
// JavaScript engine.
//
// Two rules the module exists to hold:
//
//   • The wire vocabulary is NARROWED, never trusted. A kind or a trigger this
//     build does not know is dropped rather than carried as an action nothing
//     can perform — the same treatment `lockOfEngineField` gives a lock action
//     it does not recognize.
//   • What runs and what is reported is ONE table (`RUNNABLE`), so the canvas,
//     the panel and the app handler cannot disagree about whether a click will
//     do something.

/** Where an action hangs. `A` is the widget's activation action — what a
 * pushbutton does when it is clicked, and the key every producer writes for
 * one. The rest are `/AA` keys. */
export const ACTION_TRIGGERS = ['A', 'D', 'U', 'E', 'X', 'Fo', 'Bl'] as const;
export type ActionTrigger = (typeof ACTION_TRIGGERS)[number];

/** The trigger an action is authored on when nothing else is said. */
export const DEFAULT_TRIGGER: ActionTrigger = 'A';

export const SUBMIT_FORMATS = ['fdf', 'xfdf', 'html', 'pdf'] as const;
export type SubmitFormat = (typeof SUBMIT_FORMATS)[number];

export type WidgetAction =
  /** Go to a page of this document. `page` is 0-based, and null when the
   * destination names a page the document no longer has. */
  | { kind: 'goto'; page: number | null }
  | { kind: 'uri'; uri: string }
  | { kind: 'reset'; fields: string[] | null; exclude: boolean }
  | {
      kind: 'submit';
      url: string;
      format: SubmitFormat;
      method: 'post' | 'get';
      fields: string[] | null;
      exclude: boolean;
      includeEmpty: boolean;
    }
  | { kind: 'hide'; targets: string[]; hide: boolean }
  | { kind: 'import'; file: string }
  | { kind: 'named'; name: string }
  | { kind: 'javascript' }
  | { kind: 'remote'; file: string }
  | { kind: 'other'; action: string };

export type WidgetActionKind = WidgetAction['kind'];

/** The kinds this app AUTHORS. Reading covers more, because a document may
 * carry anything; writing is restricted to what this app can also perform or
 * honestly explain. */
export const AUTHORED_KINDS = ['goto', 'uri', 'reset', 'submit', 'hide', 'import'] as const;
export type AuthoredKind = (typeof AUTHORED_KINDS)[number];

/** Whether a click on this action DOES something, as against reporting what
 * the document carries. `submit` runs as far as building the submission; the
 * request itself is the user's, through their own browser or mail client —
 * this app performs no outbound request and opens no external address. */
const RUNNABLE = new Set<WidgetActionKind>([
  'goto',
  'uri',
  'reset',
  'submit',
  'hide',
  'import',
]);

export function isRunnable(action: WidgetAction): boolean {
  if (action.kind === 'goto') return action.page !== null;
  return RUNNABLE.has(action.kind);
}

/** An action authored on a trigger — what the properties editor edits and what
 * the engine door takes.
 *
 * A go-to's page is a NUMBER here, where the read side allows null: null means
 * "the document names a page it no longer has", which is a thing to report,
 * never a thing to write. */
export type AuthoredAction = { trigger: ActionTrigger } & (
  | { kind: 'goto'; page: number }
  | Extract<WidgetAction, { kind: Exclude<AuthoredKind, 'goto'> }>
);

/** The catalog key naming a kind, for a picker and for a summary line. One
 * table so the two never drift apart. */
export const ACTION_KIND_LABEL = {
  goto: 'panel.fieldActions.actionGoto',
  uri: 'panel.fieldActions.actionUri',
  reset: 'panel.fieldActions.actionReset',
  submit: 'panel.fieldActions.actionSubmit',
  hide: 'panel.fieldActions.actionHide',
  import: 'panel.fieldActions.actionImport',
  named: 'panel.fieldActions.actionNamed',
  javascript: 'panel.fieldActions.actionJavascript',
  remote: 'panel.fieldActions.actionRemote',
  other: 'panel.fieldActions.actionOther',
} as const satisfies Record<WidgetActionKind, string>;

export const ACTION_TRIGGER_LABEL = {
  A: 'panel.fieldActions.triggerActivate',
  D: 'panel.fieldActions.triggerDown',
  U: 'panel.fieldActions.triggerUp',
  E: 'panel.fieldActions.triggerEnter',
  X: 'panel.fieldActions.triggerExit',
  Fo: 'panel.fieldActions.triggerFocus',
  Bl: 'panel.fieldActions.triggerBlur',
} as const satisfies Record<ActionTrigger, string>;

// ── narrowing the engine's wire shape ─────────────────────────────────────

function names(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((n) => String(n)) : [];
}

function scopedNames(raw: unknown): string[] | null {
  const list = names(raw);
  return list.length > 0 ? list : null;
}

/** One engine-reported action, narrowed. Null when the kind is not one this
 * build knows — an unknown kind reports as nothing rather than as the nearest
 * thing, because guessing either invents a behaviour or hides one. */
export function narrowAction(raw: unknown): WidgetAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  switch (String(node.kind)) {
    case 'goto': {
      const page = node.page;
      return { kind: 'goto', page: typeof page === 'number' ? page : null };
    }
    case 'uri':
      return { kind: 'uri', uri: String(node.uri ?? '') };
    case 'reset':
      return {
        kind: 'reset',
        fields: scopedNames(node.fields),
        exclude: Boolean(node.exclude),
      };
    case 'submit': {
      const format = String(node.format ?? 'fdf');
      return {
        kind: 'submit',
        url: String(node.url ?? ''),
        format: (SUBMIT_FORMATS as readonly string[]).includes(format)
          ? (format as SubmitFormat)
          : 'fdf',
        method: node.method === 'get' ? 'get' : 'post',
        fields: scopedNames(node.fields),
        exclude: Boolean(node.exclude),
        includeEmpty: Boolean(node.include_empty),
      };
    }
    case 'hide':
      return { kind: 'hide', targets: names(node.targets), hide: node.hide !== false };
    case 'import':
      return { kind: 'import', file: String(node.file ?? '') };
    case 'named':
      return { kind: 'named', name: String(node.name ?? '') };
    case 'javascript':
      return { kind: 'javascript' };
    case 'remote':
      return { kind: 'remote', file: String(node.file ?? '') };
    case 'other':
      return { kind: 'other', action: String(node.action ?? '') };
    default:
      return null;
  }
}

/** A field's whole trigger map, narrowed. */
export function narrowActions(raw: unknown): Partial<Record<ActionTrigger, WidgetAction>> {
  const out: Partial<Record<ActionTrigger, WidgetAction>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const node = raw as Record<string, unknown>;
  for (const trigger of ACTION_TRIGGERS) {
    const action = narrowAction(node[trigger]);
    if (action) out[trigger] = action;
  }
  return out;
}

// ── authoring ─────────────────────────────────────────────────────────────

/** The trigger map back as the authored list the editor edits and the engine
 * door takes. Kinds this app does not author are DROPPED, which is what makes
 * the editor safe to open on a field carrying one: applying rewrites only the
 * triggers this app can write, and a script or a remote go-to is not among
 * them. */
export function authoredActions(
  actions: Partial<Record<ActionTrigger, WidgetAction>>,
): AuthoredAction[] {
  const out: AuthoredAction[] = [];
  for (const trigger of ACTION_TRIGGERS) {
    const action = actions[trigger];
    if (!action) continue;
    if (!(AUTHORED_KINDS as readonly string[]).includes(action.kind)) continue;
    if (action.kind === 'goto') {
      // A destination that resolves to nothing is not authorable: writing it
      // back would have to invent a page the author never named.
      if (action.page === null) continue;
      out.push({ kind: 'goto', trigger, page: action.page });
      continue;
    }
    out.push({
      ...(action as Extract<WidgetAction, { kind: Exclude<AuthoredKind, 'goto'> }>),
      trigger,
    });
  }
  return out;
}

/** Whether opening the editor on this field would DISCARD something: a
 * trigger carrying a kind this app does not author. The editor says so rather
 * than quietly dropping it on apply. */
export function unauthorableTriggers(
  actions: Partial<Record<ActionTrigger, WidgetAction>>,
): ActionTrigger[] {
  return ACTION_TRIGGERS.filter((t) => {
    const action = actions[t];
    return Boolean(action) && !(AUTHORED_KINDS as readonly string[]).includes(action!.kind);
  });
}

/** One authored action as the engine's own wire shape (snake_case where the
 * engine spells it that way), so the door takes exactly what it validated. */
export function toEngineAction(action: AuthoredAction): Record<string, unknown> {
  const base = { trigger: action.trigger, kind: action.kind };
  switch (action.kind) {
    case 'goto':
      return { ...base, page: action.page };
    case 'uri':
      return { ...base, uri: action.uri };
    case 'reset':
      return { ...base, fields: action.fields ?? [], exclude: action.exclude };
    case 'submit':
      return {
        ...base,
        url: action.url,
        format: action.format,
        method: action.method,
        fields: action.fields ?? [],
        exclude: action.exclude,
        include_empty: action.includeEmpty,
      };
    case 'hide':
      return { ...base, targets: action.targets, hide: action.hide };
    default:
      return { ...base, file: action.file };
  }
}

/** A fresh action of a kind, with the members that kind needs. The editor
 * swaps kinds in place, so switching to Submit must not leave a Go-to's page
 * behind as the only member the new kind carries. */
export function defaultAction(kind: AuthoredKind, trigger: ActionTrigger): AuthoredAction {
  switch (kind) {
    case 'goto':
      return { kind, trigger, page: 0 };
    case 'uri':
      return { kind, trigger, uri: '' };
    case 'reset':
      return { kind, trigger, fields: null, exclude: false };
    case 'submit':
      return {
        kind,
        trigger,
        url: '',
        format: 'fdf',
        method: 'post',
        fields: null,
        exclude: false,
        includeEmpty: false,
      };
    case 'hide':
      return { kind, trigger, targets: [], hide: true };
    default:
      return { kind, trigger, file: '' };
  }
}
