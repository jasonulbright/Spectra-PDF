// Guided actions sequence model. This leaf module uses localStorage and pure
// helpers so the
// catalog integrity, validation, and param mapping are unit-testable (no DOM
// test environment; the breakable part must be the testable part).
//
// An action is a named, ordered list of steps; every step is an EXISTING
// gated engine op with a compact param form. The runner (the panel) drives
// each step through the standard snapshot → call → reload shape, so a run is
// undoable step-by-step and stops on the first failure. Deliberately NO new
// engine surface: the catalog is a curation over ops that already ship.

import { OCR_LANGUAGES } from '../ocr/languages';
// The unattended-run refusal is USER-FACING copy, so it resolves
// through the catalog. That is the one non-pure import here — i18n is
// itself a data module (catalogs + i18next), so the helpers below stay
// unit-testable with no DOM.
import { tChrome, tStepParam, tStepTitle } from '../i18n';

// Slice 2 grew the catalog: OCR (the batch pipeline's single-file arm),
// header/footer (one positioned text per step — several positions compose as
// several steps), and ENCRYPT as a TERMINAL step that writes a NEW picked
// file (an in-place encrypt would make the open working copy unreadable,
// which is why it is excluded; EncryptPanel has the same shape).
// One step PRODUCES a document rather than transforming one: `create_pdf`. It is why `StepDef` grew `sourceStep` —
// see that field, and `openDocumentBlocker` / `inPlaceBlocker` below.
export type GuidedStepOp =
  | 'create_pdf'
  | 'compress'
  | 'grayscale'
  | 'convert_pdfa'
  | 'strip_metadata'
  | 'sanitize'
  | 'watermark'
  | 'ocr_file'
  | 'add_header_footer'
  | 'encrypt';

export interface GuidedStep {
  op: GuidedStepOp;
  params: Record<string, string | number>;
  /** Param keys collected at RUN time instead of stored (ask-at-run).
   * `secret` params are implicitly always here and never persisted. */
  ask?: string[];
}

export interface GuidedAction {
  id: string;
  name: string;
  steps: GuidedStep[];
}

export interface StepParamDef {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'select' | 'number';
  options?: readonly { value: string; label: string }[];
  defaultValue: string | number;
  /** Refused empty at validate (e.g. a watermark with no text). An asked
   * param's emptiness is checked at the PRE-RUN form instead. */
  required?: boolean;
  /** Never persisted, always collected at run time (passwords). */
  secret?: boolean;
  /** Editor hint under the input (token syntax etc.). */
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface StepDef {
  op: GuidedStepOp;
  title: string;
  /** The step's engine call takes gs_path (the panel resolves it once per run). */
  needsGs?: boolean;
  /** The step's engine call takes font_dir (Unicode text faces). */
  needsFontDir?: boolean;
  /** The step's engine call takes tesseract_path (OCR). */
  needsTesseract?: boolean;
  /** The step writes a NEW file picked at run time instead of the working
   * copy (encrypt); must be the LAST step and never mutates the open doc. */
  terminalOutput?: boolean;
  /**
   * The step PRODUCES the document the rest of the action works on
   * (`create_pdf`) rather than transforming one.
   *
   * Three consequences, all enforced rather than documented — and all
   * mirrored by `engine/guided_actions.py`, which is the half a CLI or a
   * scheduled run reaches without passing through this editor at all:
   * it must be the FIRST step, the action cannot run against the open
   * document (there is nothing for it to create FROM), and it cannot run
   * in place (the converted document is a new file, not a replacement).
   */
  sourceStep?: boolean;
  /** Reshape the flat form params into the engine call's shape (e.g. the
   * header/footer position+text pair into its `placements` list). */
  mapParams?: (params: Record<string, string | number>) => Record<string, unknown>;
  params: readonly StepParamDef[];
}

export const STEP_CATALOG: readonly StepDef[] = [
  {
    op: 'compress',
    title: 'Compress',
    needsGs: true,
    params: [
      {
        key: 'quality',
        label: 'Quality',
        kind: 'select',
        options: [
          { value: 'screen', label: 'Screen (72 dpi)' },
          { value: 'ebook', label: 'Ebook (150 dpi)' },
          { value: 'printer', label: 'Printer (300 dpi)' },
          { value: 'prepress', label: 'Prepress (300 dpi)' },
        ],
        defaultValue: 'ebook',
      },
    ],
  },
  { op: 'grayscale', title: 'Convert to Grayscale', needsGs: true, params: [] },
  {
    op: 'convert_pdfa',
    title: 'Convert to PDF/A',
    needsGs: true,
    params: [
      {
        key: 'level',
        label: 'Level',
        kind: 'select',
        options: [
          { value: '1b', label: 'PDF/A-1b' },
          { value: '2b', label: 'PDF/A-2b' },
          { value: '3b', label: 'PDF/A-3b' },
        ],
        defaultValue: '2b',
      },
    ],
  },
  { op: 'strip_metadata', title: 'Strip Metadata', params: [] },
  {
    // The categories are named as a comma-separated list rather than picked
    // from checkboxes: an action runs unattended over a folder, so what it
    // removes has to be written down in the action itself.
    op: 'sanitize',
    title: 'Remove Hidden Information',
    params: [
      {
        key: 'categories',
        label: 'Categories',
        kind: 'text',
        defaultValue: 'metadata,embedded_files,comments,javascript,prior_revisions',
        required: true,
        hint: 'metadata, embedded_files, bookmarks, comments, form_fields, javascript, hidden_layers, hidden_text, prior_revisions, unreferenced_objects, links_and_actions, thumbnails, attached_structure',
      },
      {
        key: 'form_fields_mode',
        label: 'Form fields',
        kind: 'select',
        options: [
          { value: 'remove', label: 'Remove the fields' },
          { value: 'flatten', label: 'Flatten (keep the look)' },
        ],
        defaultValue: 'remove',
      },
    ],
    mapParams: (params) => ({
      categories: String(params.categories ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      form_fields_mode: String(params.form_fields_mode ?? 'remove'),
    }),
  },
  {
    op: 'watermark',
    title: 'Watermark',
    needsFontDir: true,
    params: [
      { key: 'text', label: 'Text', kind: 'text', defaultValue: '', required: true },
      {
        key: 'opacity',
        label: 'Opacity',
        kind: 'number',
        defaultValue: 0.15,
        min: 0.05,
        max: 1,
        step: 0.05,
      },
      { key: 'angle', label: 'Angle', kind: 'number', defaultValue: 45, min: -180, max: 180, step: 5 },
    ],
  },
  {
    op: 'ocr_file',
    title: 'Make Searchable (OCR)',
    needsGs: true,
    needsTesseract: true,
    params: [
      {
        key: 'language',
        label: 'Language',
        kind: 'select',
        options: OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
        defaultValue: 'eng',
      },
    ],
  },
  {
    op: 'add_header_footer',
    title: 'Header & Footer',
    needsFontDir: true,
    mapParams: (p) => ({
      placements: [{ position: String(p.position), text: String(p.text) }],
      font_size: p.font_size,
    }),
    params: [
      {
        key: 'position',
        label: 'Position',
        kind: 'select',
        options: [
          { value: 'tl', label: 'Top left' },
          { value: 'tc', label: 'Top center' },
          { value: 'tr', label: 'Top right' },
          { value: 'bl', label: 'Bottom left' },
          { value: 'bc', label: 'Bottom center' },
          { value: 'br', label: 'Bottom right' },
        ],
        defaultValue: 'bc',
      },
      {
        key: 'text',
        label: 'Text',
        kind: 'text',
        defaultValue: '',
        required: true,
        hint: 'Tokens: {page}, {pages}, {bates}. One position per step — stack steps for more.',
      },
      { key: 'font_size', label: 'Size', kind: 'number', defaultValue: 10, min: 4, max: 72, step: 1 },
    ],
  },
  {
    op: 'encrypt',
    title: 'Encrypt to a new file',
    terminalOutput: true,
    params: [
      { key: 'user_password', label: 'Open password', kind: 'password', defaultValue: '', secret: true },
      { key: 'owner_password', label: 'Owner password', kind: 'password', defaultValue: '', secret: true },
    ],
  },
  {
    // LAST in the catalog even though it is always FIRST in an
    // action: `AddStepPicker` defaults to `STEP_CATALOG[0]`, and making the
    // rarest step the default "Add step" would be a regression for every
    // ordinary action. Position here is a picker default, not an order.
    op: 'create_pdf',
    title: 'Create PDF from any file',
    sourceStep: true,
    needsGs: true,
    params: [
      {
        key: 'page_size',
        label: 'Page size',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Keep each source’s own size' },
          { value: 'first', label: 'Match the first source' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
          { value: 'tabloid', label: 'Tabloid' },
          { value: 'a3', label: 'A3' },
          { value: 'a4', label: 'A4' },
          { value: 'a5', label: 'A5' },
        ],
        defaultValue: 'auto',
      },
      {
        key: 'orientation',
        label: 'Orientation',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Follow the content' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
        defaultValue: 'auto',
      },
      { key: 'margin_pt', label: 'Margin (pt)', kind: 'number', defaultValue: 0, min: 0, max: 288, step: 1 },
      {
        key: 'image_dpi_default',
        label: 'Image resolution (dpi)',
        kind: 'number',
        defaultValue: 200,
        min: 1,
        max: 2400,
        step: 1,
      },
      {
        key: 'distill_preset',
        label: 'PostScript quality',
        kind: 'select',
        options: [
          { value: 'screen', label: 'Smallest Size (72 dpi)' },
          { value: 'ebook', label: 'eBook (150 dpi)' },
          { value: 'printer', label: 'Print Quality (300 dpi)' },
          { value: 'prepress', label: 'Press Quality' },
          { value: 'default', label: 'Standard (Ghostscript defaults)' },
        ],
        defaultValue: 'printer',
      },
    ],
  },
];

export function stepDefFor(op: GuidedStepOp): StepDef {
  const def = STEP_CATALOG.find((d) => d.op === op);
  if (!def) throw new Error(`unknown guided step: ${op}`);
  return def;
}

/** A fresh step with the catalog's defaults. */
export function newStep(op: GuidedStepOp): GuidedStep {
  const def = stepDefFor(op);
  const params: Record<string, string | number> = {};
  for (const p of def.params) params[p.key] = p.defaultValue;
  return { op, params };
}

/** The param keys a run must collect up front: everything the user marked
 * ask-at-run, plus every secret (which is never stored). */
export function askedParamKeys(step: GuidedStep): string[] {
  const def = stepDefFor(step.op);
  const asked = new Set(step.ask ?? []);
  for (const p of def.params) if (p.secret) asked.add(p.key);
  return def.params.filter((p) => asked.has(p.key)).map((p) => p.key);
}

/**
 * The engine-call params for a step — the FILE-INDEPENDENT half; the runner
 * adds file/output and the resolved tool paths, and merges any ask-at-run
 * values (pass them as `overrides`) BEFORE coercion so clamps apply to them
 * too. `mapParams` reshapes last (e.g. header/footer's position+text pair
 * into its `placements` list).
 */
export function buildStepParams(
  step: GuidedStep,
  overrides?: Record<string, string | number>,
): Record<string, unknown> {
  const def = stepDefFor(step.op);
  const merged = { ...step.params, ...overrides };
  const out: Record<string, string | number> = {};
  for (const p of def.params) {
    const raw = merged[p.key] ?? p.defaultValue;
    if (p.kind === 'number') {
      let v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(v)) v = Number(p.defaultValue);
      if (p.min !== undefined) v = Math.max(p.min, v);
      if (p.max !== undefined) v = Math.min(p.max, v);
      out[p.key] = v;
    } else {
      out[p.key] = String(raw);
    }
  }
  return def.mapParams ? def.mapParams(out) : out;
}

/** null when valid; else the first human-readable problem.
 *
 * Every refusal is ONE interpolated catalog key, and the STEP
 * and PARAM names inside it resolve through the same `gaction.*` keys the
 * editor renders — a message naming "Watermark" in a Spanish UI while the
 * step list above it says "Marca de agua" would be worse than English. */
export function validateAction(action: GuidedAction): string | null {
  if (!action.name.trim()) return tChrome('refusal.action.needsName');
  if (action.steps.length === 0) return tChrome('refusal.action.needsStep');
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = STEP_CATALOG.find((d) => d.op === step.op);
    if (!def) return tChrome('refusal.action.unknownOp', { index: i + 1 });
    const asked = new Set(askedParamKeys(step));
    for (const p of def.params) {
      // An asked/secret param's emptiness is the PRE-RUN form's problem.
      if (p.required && !asked.has(p.key) && !String(step.params[p.key] ?? '').trim()) {
        return tChrome('refusal.action.paramRequired', {
          index: i + 1,
          step: tStepTitle(def.op, def.title),
          param: tStepParam(def.op, p.key, p.label),
        });
      }
    }
    // A terminal step never mutates the open doc, so nothing may follow it.
    if (def.terminalOutput && i < action.steps.length - 1) {
      return tChrome('refusal.action.terminalNotLast', {
        step: tStepTitle(def.op, def.title),
      });
    }
    // A source step PRODUCES the document the rest of the action works on,
    // so anywhere but first it would convert a file the earlier steps had
    // already rewritten. `engine/guided_actions.py`'s `validate_steps`
    // refuses the same thing — this is the editor's half, by name, so the
    // action cannot be SAVED into a shape the runner will reject.
    if (def.sourceStep && i > 0) {
      return tChrome('refusal.action.sourceNotFirst', {
        step: tStepTitle(def.op, def.title),
      });
    }
  }
  return null;
}

/** Does this action START by creating its own document? */
export function createsItsOwnSource(action: GuidedAction): boolean {
  const first = action.steps[0];
  return first !== undefined && Boolean(stepDefFor(first.op).sourceStep);
}

/**
 * Why this action cannot run against the OPEN document, or null.
 *
 * An action that begins by creating a document has nothing to create FROM
 * when it is pointed at a document that already exists — it is a folder run
 * by construction, and saying so is better than running it and producing a
 * confusing result.
 */
export function openDocumentBlocker(action: GuidedAction): string | null {
  if (!createsItsOwnSource(action)) return null;
  const def = stepDefFor(action.steps[0].op);
  return tChrome('refusal.action.sourceNeedsFolder', {
    step: tStepTitle(def.op, def.title),
  });
}

/** Why this action cannot REPLACE the originals, or null. Mirrors the
 * engine's own in-place refusal: the converted document is a new file, so
 * "replace `report.docx` with a PDF still called `report.docx`" is a
 * destroyed source with a misleading name, not an in-place edit. */
export function inPlaceBlocker(action: GuidedAction): string | null {
  if (!createsItsOwnSource(action)) return null;
  const def = stepDefFor(action.steps[0].op);
  return tChrome('refusal.action.sourceNotInPlace', {
    step: tStepTitle(def.op, def.title),
  });
}

/** Pre-run check of the collected ask-at-run values for one step. */
export function validateRunValues(
  step: GuidedStep,
  values: Record<string, string | number>,
): string | null {
  const def = stepDefFor(step.op);
  for (const key of askedParamKeys(step)) {
    const p = def.params.find((x) => x.key === key)!;
    if (p.required && !String(values[key] ?? '').trim()) {
      return tChrome('refusal.action.runParamRequired', {
        step: tStepTitle(def.op, def.title),
        param: tStepParam(def.op, p.key, p.label),
      });
    }
  }
  if (step.op === 'encrypt') {
    const u = String(values.user_password ?? '').trim();
    const o = String(values.owner_password ?? '').trim();
    if (!u && !o) return tChrome('refusal.action.encryptNeedsPassword');
  }
  return null;
}

/**
 * Why an action cannot run UNATTENDED, or null if it can (scheduling).
 * A scheduled run has nobody at the keyboard: ask-at-run values
 * (and secrets, which are implicitly asked and by rule never persisted) make
 * a task that would fail every time it fires. Refuse at scheduling time,
 * naming the step — never register a task that will not run.
 */
export function unattendedBlocker(action: GuidedAction): string | null {
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = stepDefFor(step.op);
    const asked = askedParamKeys(step);
    if (asked.length === 0) continue;
    // One whole interpolated message per refusal (the two halves
    // used to be concatenated template fragments). The asked-for PARAM
    // KEYS stay verbatim — they are the action file's own vocabulary.
    const vars = { index: i + 1, step: tStepTitle(step.op, def.title) };
    if (def.params.some((p) => p.secret && asked.includes(p.key))) {
      return tChrome('dialog.unattended.secret', vars);
    }
    return tChrome('dialog.unattended.asks', { ...vars, params: asked.join(', ') });
  }
  return null;
}

const STORE_KEY = 'guided-actions';

export function isGuidedAction(v: unknown): v is GuidedAction {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || typeof a.name !== 'string' || !Array.isArray(a.steps)) return false;
  return a.steps.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const step = s as Record<string, unknown>;
    return (
      typeof step.op === 'string' &&
      STEP_CATALOG.some((d) => d.op === step.op) &&
      typeof step.params === 'object' &&
      step.params !== null
    );
  });
}

export function loadGuidedActions(): GuidedAction[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGuidedAction);
  } catch {
    return [];
  }
}

/** Strip secret param values (passwords) from an action; the keys stay
 * implicitly ask-at-run. Every path that writes an action OUTSIDE React
 * state — the localStorage persist, the file export — goes through this,
 * which is what makes "a saved or exported action can never carry a
 * password" true by construction rather than by call-site discipline. */
export function sanitizeAction(a: GuidedAction): GuidedAction {
  return {
    ...a,
    steps: a.steps.map((s) => {
      const def = STEP_CATALOG.find((d) => d.op === s.op);
      if (!def?.params.some((p) => p.secret)) return s;
      const params = { ...s.params };
      for (const p of def.params) if (p.secret) delete params[p.key];
      return { ...s, params };
    }),
  };
}

export function saveGuidedActions(actions: GuidedAction[]): void {
  // SECURITY: secret params (passwords) are NEVER persisted — sanitizeAction
  // strips them at the one write path, so a saved action can carry an
  // Encrypt step but never its passwords.
  localStorage.setItem(STORE_KEY, JSON.stringify(actions.map(sanitizeAction)));
}

/** The export file body — the `{name, steps}` shape the CLI consumes
 * (`run-action --action file.json`). No id: imports mint their own. Secrets
 * are stripped by the SAME construction as the persist path. */
export function actionFileJson(action: GuidedAction): string {
  const clean = sanitizeAction(action);
  return `${JSON.stringify({ name: clean.name, steps: clean.steps }, null, 2)}\n`;
}

/**
 * Parse + validate an action FILE (the `{name, steps}` export shape — also
 * what the CLI consumes). Mirrors the engine `validate_steps` refusals BY
 * NAME against the renderer's own catalog: an op or param this editor cannot
 * represent is refused with the offending name, never silently dropped
 * (buildStepParams would otherwise discard it and the imported action would
 * run differently here than through the CLI). Returns a ready-to-append
 * action with a freshly minted id — imports never collide with or overwrite
 * an existing action. Throws a human-readable message on refusal.
 */
export function parseActionFile(text: string): GuidedAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(tChrome('refusal.actionFile.notJson'));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(tChrome('refusal.actionFile.notAnActionFile'));
  }
  const a = parsed as Record<string, unknown>;
  if (typeof a.name !== 'string' || !Array.isArray(a.steps)) {
    throw new Error(tChrome('refusal.actionFile.notAnActionFile'));
  }
  const steps = a.steps.map((s, i) => parseImportedStep(s, i));
  const action: GuidedAction = { id: crypto.randomUUID(), name: a.name.trim(), steps };
  const problem = validateAction(action);
  if (problem) throw new Error(problem);
  return action;
}

// Every refusal below is one interpolated catalog key. The `op`
// id and the parameter NAMES stay verbatim inside them — they are the action
// FILE's own vocabulary, and a translated key would name something the file
// being fixed does not contain.
function parseImportedStep(s: unknown, i: number): GuidedStep {
  const n = i + 1;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) {
    throw new Error(tChrome('refusal.actionFile.stepNotObject', { index: n }));
  }
  const raw = s as Record<string, unknown>;
  const op = raw.op;
  if (typeof op !== 'string') {
    throw new Error(tChrome('refusal.actionFile.stepNotObject', { index: n }));
  }
  const def = STEP_CATALOG.find((d) => d.op === op);
  if (!def) throw new Error(tChrome('refusal.actionFile.unknownOp', { index: n, op }));
  const rawParams = raw.params ?? {};
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
    throw new Error(tChrome('refusal.actionFile.paramsNotObject', { index: n, op }));
  }
  const params: Record<string, unknown> = { ...(rawParams as Record<string, unknown>) };
  // The engine's placements list is this editor's position+text pair: fold a
  // single-entry list back into the form shape (CLI-authored files). More
  // placements than one per step is not representable in the editor.
  if (op === 'add_header_footer' && 'placements' in params) {
    if ('position' in params || 'text' in params) {
      throw new Error(tChrome('refusal.actionFile.placementsConflict', { index: n, op }));
    }
    const pl = params.placements;
    delete params.placements;
    if (!Array.isArray(pl) || pl.length === 0) {
      throw new Error(tChrome('refusal.actionFile.placementsEmpty', { index: n, op }));
    }
    if (pl.length > 1) {
      throw new Error(tChrome('refusal.actionFile.placementsMulti', { index: n, op }));
    }
    const first = pl[0] as Record<string, unknown> | null;
    if (typeof first !== 'object' || first === null) {
      throw new Error(tChrome('refusal.actionFile.placementsShape', { index: n, op }));
    }
    params.position = first.position;
    params.text = first.text;
  }
  const allowed = new Map(def.params.map((p) => [p.key, p]));
  const unknown = Object.keys(params)
    .filter((k) => !allowed.has(k))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      tChrome('refusal.actionFile.unknownParams', {
        index: n,
        op,
        params: unknown.join(', '),
      }),
    );
  }
  const clean: Record<string, string | number> = {};
  for (const [key, v] of Object.entries(params)) {
    const p = allowed.get(key)!;
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new Error(
        tChrome('refusal.actionFile.paramType', { index: n, op, param: key }),
      );
    }
    if (p.kind === 'select' && !p.options!.some((o) => o.value === String(v))) {
      throw new Error(
        tChrome('refusal.actionFile.invalidValue', {
          index: n,
          op,
          value: String(v),
          param: key,
        }),
      );
    }
    clean[key] = v;
  }
  // ask: param keys collected at run time. Keys the catalog doesn't know are
  // meaningless here (askedParamKeys intersects anyway) — keep the known.
  if (raw.ask === undefined) return { op: def.op, params: clean };
  if (!Array.isArray(raw.ask) || raw.ask.some((k) => typeof k !== 'string')) {
    throw new Error(tChrome('refusal.actionFile.askNotList', { index: n, op }));
  }
  return { op: def.op, params: clean, ask: (raw.ask as string[]).filter((k) => allowed.has(k)) };
}
