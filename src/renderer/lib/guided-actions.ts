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

// Encrypt is deliberately ABSENT: the runner works in-place on the open
// working copy, and an encrypted working copy is unreadable to the open app
// (EncryptPanel itself always writes a NEW file for this reason). It joins
// the catalog with the folder/save-as run mode (ledger).
export type GuidedStepOp =
  | 'compress'
  | 'grayscale'
  | 'convert_pdfa'
  | 'strip_metadata'
  | 'watermark';

export interface GuidedStep {
  op: GuidedStepOp;
  params: Record<string, string | number>;
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
  /** Refused empty at validate (e.g. a watermark with no text). */
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface StepDef {
  op: GuidedStepOp;
  title: string;
  /** The step's engine call takes gs_path (the panel resolves it once per run). */
  needsGs?: boolean;
  /** The step's engine call takes font_dir (watermark's Unicode face). */
  needsFontDir?: boolean;
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

/**
 * The engine-call params for a step — the FILE-INDEPENDENT half; the runner
 * adds file/output (the working path) and the resolved gs_path/font_dir.
 * Numbers arrive as strings from inputs and coerce here, clamped to the
 * param's declared range.
 */
export function buildStepParams(step: GuidedStep): Record<string, string | number> {
  const def = stepDefFor(step.op);
  const out: Record<string, string | number> = {};
  for (const p of def.params) {
    const raw = step.params[p.key] ?? p.defaultValue;
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
  return out;
}

/** null when valid; else the first human-readable problem. */
export function validateAction(action: GuidedAction): string | null {
  if (!action.name.trim()) return 'The action needs a name.';
  if (action.steps.length === 0) return 'Add at least one step.';
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = STEP_CATALOG.find((d) => d.op === step.op);
    if (!def) return `Step ${i + 1} names an unknown operation.`;
    for (const p of def.params) {
      if (p.required && !String(step.params[p.key] ?? '').trim()) {
        return `Step ${i + 1} (${def.title}): ${p.label} is required.`;
      }
    }
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
  localStorage.setItem(STORE_KEY, JSON.stringify(actions));
}
