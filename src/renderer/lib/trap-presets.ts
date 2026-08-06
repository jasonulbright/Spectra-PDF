// The trap-presets panel's model: the page ranges it can send, and how a
// preset's rows are built from what the engine says the vocabulary is.
//
// What a trapping field means, what it may hold and how it reaches a RIP are
// ENGINE rules and live there alone — a second copy of the sixteen fields here
// would be a second vocabulary that drifts. What lives here is what the PANEL
// decides by itself: whether a typed page range is a range at all, whether two
// assignments claim the same page, and what a fresh preset starts as. There is
// no DOM test environment, so those rules live in the model, not the component.

export type TrapFieldType =
  | 'number'
  | 'integer'
  | 'boolean'
  | 'choice'
  | 'name'
  | 'text'
  | 'colorants';

export interface TrapFieldSpec {
  name: string;
  type: TrapFieldType;
  default: unknown;
  min?: number;
  max?: number;
  choices?: string[];
}

export interface TrapVocabulary {
  fields: TrapFieldSpec[];
  trapped_values: string[];
  default_trapped: string;
  colorant_fields: string[];
}

export type TrapFields = Record<string, unknown>;

export interface TrapAssignment {
  first: number;
  last: number;
  name: string;
  preset: TrapFields;
}

/** The three values PDF/X allows. `True` asserts a trap network exists;
 *  nothing in this product makes one, so it is only ever the user's own
 *  statement about work done elsewhere. */
export const TRAPPED_VALUES = ['Unknown', 'False', 'True'] as const;
export type TrappedValue = (typeof TRAPPED_VALUES)[number];

export const DEFAULT_TRAPPED: TrappedValue = 'Unknown';

/** A preset with every field at the vocabulary's own initial value. */
export function freshPreset(vocabulary: TrapVocabulary | null): TrapFields {
  const out: TrapFields = {};
  for (const field of vocabulary?.fields ?? []) out[field.name] = field.default;
  return out;
}

export type RangeProblem = 'empty' | 'notANumber' | 'inverted' | 'outside' | 'overlap';

/**
 * Why this page range cannot be assigned, or null when it can.
 *
 * The engine refuses a range outside the document too; the panel says so first
 * so a user is not told after the write what they could have been told before
 * it.
 */
export function rangeProblem(
  first: number,
  last: number,
  pageCount: number,
  existing: readonly TrapAssignment[] = [],
  editingIndex = -1,
): RangeProblem | null {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 'notANumber';
  if (!Number.isInteger(first) || !Number.isInteger(last)) return 'notANumber';
  if (first < 1 || last < 1) return 'outside';
  if (last < first) return 'inverted';
  if (pageCount > 0 && last > pageCount) return 'outside';
  for (let i = 0; i < existing.length; i += 1) {
    if (i === editingIndex) continue;
    const other = existing[i];
    if (first <= other.last && other.first <= last) return 'overlap';
  }
  return null;
}

/** The assignments in page order — the order a reader expects and the order
 *  the emission walks the document in. */
export function orderedAssignments(
  assignments: readonly TrapAssignment[],
): TrapAssignment[] {
  return [...assignments].sort((a, b) => a.first - b.first || a.last - b.last);
}

/** The pages no assignment covers. A page with no preset is trapped by
 *  whatever the RIP already had, and the panel says which pages those are
 *  rather than implying the whole document is covered. */
export function uncoveredPages(
  assignments: readonly TrapAssignment[],
  pageCount: number,
): number[] {
  const covered = new Set<number>();
  for (const entry of assignments) {
    for (let page = Math.max(1, entry.first); page <= Math.min(pageCount, entry.last); page += 1) {
      covered.add(page);
    }
  }
  const out: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) if (!covered.has(page)) out.push(page);
  return out;
}

/** A field's value coerced to what its type accepts, for sending. Anything
 *  the engine would refuse is left as typed so the refusal names it. */
export function coerceField(spec: TrapFieldSpec, raw: string | boolean): unknown {
  if (spec.type === 'boolean') return Boolean(raw);
  if (spec.type === 'integer' || spec.type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  if (spec.type === 'name' || spec.type === 'text') {
    const text = String(raw);
    return text.length > 0 ? text : null;
  }
  return raw;
}

/** Is the claim one of the three PDF/X allows? */
export function isTrappedValue(value: string): value is TrappedValue {
  return (TRAPPED_VALUES as readonly string[]).includes(value);
}
