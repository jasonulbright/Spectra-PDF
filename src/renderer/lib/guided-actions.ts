// Guided actions (parity map § 2 — the king's Action Wizard), slice 1: the
// sequence MODEL. A LEAF module — localStorage + pure helpers only — so the
// catalog integrity, validation, and param mapping are unit-testable (no DOM
// test environment; the breakable part must be the testable part).
//
// An action is a named, ordered list of steps; every step is an EXISTING
// gated engine op with a compact param form. The runner (the panel) drives
// each step through the standard snapshot → call → reload shape, so a run is
// undoable step-by-step and stops on the first failure. Deliberately NO new
// engine surface: the catalog is a curation over ops that already ship.

import { OCR_LANGUAGES } from '../ocr/languages';

// Slice 2 grew the catalog: OCR (the batch pipeline's single-file arm),
// header/footer (one positioned text per step — several positions compose as
// several steps), and ENCRYPT as a TERMINAL step that writes a NEW picked
// file (an in-place encrypt would make the open working copy unreadable,
// which is why slice 1 excluded it; EncryptPanel has the same shape).
export type GuidedStepOp =
  | 'compress'
  | 'grayscale'
  | 'convert_pdfa'
  | 'strip_metadata'
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

/** null when valid; else the first human-readable problem. */
export function validateAction(action: GuidedAction): string | null {
  if (!action.name.trim()) return 'The action needs a name.';
  if (action.steps.length === 0) return 'Add at least one step.';
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = STEP_CATALOG.find((d) => d.op === step.op);
    if (!def) return `Step ${i + 1} names an unknown operation.`;
    const asked = new Set(askedParamKeys(step));
    for (const p of def.params) {
      // An asked/secret param's emptiness is the PRE-RUN form's problem.
      if (p.required && !asked.has(p.key) && !String(step.params[p.key] ?? '').trim()) {
        return `Step ${i + 1} (${def.title}): ${p.label} is required.`;
      }
    }
    // A terminal step never mutates the open doc, so nothing may follow it.
    if (def.terminalOutput && i < action.steps.length - 1) {
      return `${def.title} writes a new file and must be the last step.`;
    }
  }
  return null;
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
      return `${def.title}: ${p.label} is required.`;
    }
  }
  if (step.op === 'encrypt') {
    const u = String(values.user_password ?? '').trim();
    const o = String(values.owner_password ?? '').trim();
    if (!u && !o) return 'Encrypt: set an open or an owner password.';
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

export function saveGuidedActions(actions: GuidedAction[]): void {
  // SECURITY: secret params (passwords) are NEVER persisted — their values
  // are stripped here (the one write path) and their keys are implicitly
  // ask-at-run, so a saved action can carry an Encrypt step but never its
  // passwords.
  const sanitized = actions.map((a) => ({
    ...a,
    steps: a.steps.map((s) => {
      const def = STEP_CATALOG.find((d) => d.op === s.op);
      if (!def?.params.some((p) => p.secret)) return s;
      const params = { ...s.params };
      for (const p of def.params) if (p.secret) delete params[p.key];
      return { ...s, params };
    }),
  }));
  localStorage.setItem(STORE_KEY, JSON.stringify(sanitized));
}
