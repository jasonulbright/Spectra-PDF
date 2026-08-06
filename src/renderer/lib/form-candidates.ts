// Detected field candidates — the review model, pure over data.
//
// A candidate is a SUGGESTION with the redaction-mark lifetime: transient view
// state bound to a page id, invalidated when its file's bytes change, and
// carrying nothing into the document until the user accepts it. That is what
// makes a heuristic safe to run over someone's form.
//
// Geometry is stored display-normalized with the rotation it was detected at,
// exactly as a mark is: the canvas already owns one conversion between page
// space and the cell, and a second one here would be a second answer to where
// a rectangle is.
import type { NewFieldSpec, NewFieldType } from './form-authoring';
import type { FieldLock } from './signatures';

export type CandidateKind = 'text' | 'checkbox' | 'radio' | 'signature';

const KINDS: readonly CandidateKind[] = ['text', 'checkbox', 'radio', 'signature'];

/** One row of the detection door's payload. */
export interface DetectedCandidate {
  page: number;
  index: number;
  kind: string;
  rect: [number, number, number, number];
  label: string | null;
  label_source: string | null;
  label_gap: number;
  name: string;
  evidence: string;
  nested: boolean;
  group: string | null;
  export: string | null;
  multiline: boolean;
  comb: number | null;
  max_len: number | null;
  format: string | null;
  warnings: string[];
}

export interface DetectionResult {
  candidates: DetectedCandidate[];
  pages_analyzed: number[];
  pages_by_source: Record<string, string>;
  unoffered: { page: number; reason: string; count: number }[];
  existing_fields: number;
  truncated: boolean;
}

export interface FieldCandidate {
  id: string;
  /** File path at detection time — used only to invalidate when its bytes change. */
  path: string;
  pageId: string;
  /** Display-normalized (0..1 of the page cell) in the orientation the page was
   * shown at detection time. */
  rect: { x: number; y: number; w: number; h: number };
  /** The PageRef's in-memory rotation DELTA at detection time; the file's baked
   * /Rotate is composed at accept time, never stored here. */
  rotationAtDraw: 0 | 90 | 180 | 270;
  /** 1-based position in the file at detection time, for the panel's grouping. */
  page: number;
  kind: CandidateKind;
  name: string;
  label: string | null;
  group: string | null;
  exportValue: string | null;
  multiline: boolean;
  comb: number | null;
  format: string | null;
  evidence: string;
  warnings: readonly string[];
  checked: boolean;
  /** The `/Lock` seed to author onto this field, signature candidates only.
   * Detection never proposes one — a drawn rule cannot imply what a signature
   * should bind — so it is null until the reviewer chooses it. */
  lock: FieldLock | null;
}

/** The kinds the review surface offers, with anything else falling back to a
 * text field — an unknown kind must still be reviewable, not dropped. */
export function candidateKind(raw: string): CandidateKind {
  return (KINDS as readonly string[]).includes(raw) ? (raw as CandidateKind) : 'text';
}

export function isChoiceKind(kind: CandidateKind): boolean {
  return kind === 'radio';
}

/** Nothing is checked here: a tool that writes to the document does not
 * pre-consent on the user's behalf. */
export function toggleCandidate(
  candidates: readonly FieldCandidate[],
  id: string,
): FieldCandidate[] {
  return candidates.map((c) => (c.id === id ? { ...c, checked: !c.checked } : c));
}

export function setCheckedAll(
  candidates: readonly FieldCandidate[],
  checked: boolean,
): FieldCandidate[] {
  return candidates.map((c) => (c.checked === checked ? c : { ...c, checked }));
}

export function setCheckedOnPage(
  candidates: readonly FieldCandidate[],
  page: number,
  checked: boolean,
): FieldCandidate[] {
  return candidates.map((c) => (c.page === page && c.checked !== checked ? { ...c, checked } : c));
}

export type TriState = 'none' | 'some' | 'all';

export function selectionState(candidates: readonly FieldCandidate[]): TriState {
  if (candidates.length === 0) return 'none';
  const checked = candidates.filter((c) => c.checked).length;
  if (checked === 0) return 'none';
  return checked === candidates.length ? 'all' : 'some';
}

export function pageSelectionState(
  candidates: readonly FieldCandidate[],
  page: number,
): TriState {
  return selectionState(candidates.filter((c) => c.page === page));
}

export function checkedCandidates(candidates: readonly FieldCandidate[]): FieldCandidate[] {
  return candidates.filter((c) => c.checked);
}

/**
 * Rename a candidate.
 *
 * A radio option's name is the GROUP's, so renaming one member renames every
 * member — two options of one group under different names are two fields, and
 * the user's gesture said "call this group something else".
 */
export function renameCandidate(
  candidates: readonly FieldCandidate[],
  id: string,
  name: string,
): FieldCandidate[] {
  const target = candidates.find((c) => c.id === id);
  if (!target) return candidates as FieldCandidate[];
  if (target.group) {
    return candidates.map((c) =>
      c.group === target.group ? { ...c, name, group: name } : c,
    );
  }
  return candidates.map((c) => (c.id === id ? { ...c, name } : c));
}

/** Retype a candidate. Leaving a radio group breaks the option out of it, so
 * the option keeps its own label as its name rather than the group's. */
export function retypeCandidate(
  candidates: readonly FieldCandidate[],
  id: string,
  kind: CandidateKind,
): FieldCandidate[] {
  return candidates.map((c) => {
    if (c.id !== id) return c;
    // Only a signature field can carry a lock, so leaving that kind drops it
    // rather than keeping a seed the write would refuse.
    const lock = kind === 'signature' ? c.lock : null;
    if (c.group && kind !== 'radio') {
      return {
        ...c,
        kind,
        lock,
        group: null,
        exportValue: null,
        name: sanitizeFieldName(c.exportValue ?? c.label ?? c.name),
        multiline: false,
      };
    }
    return { ...c, kind, lock, multiline: kind === 'text' ? c.multiline : false };
  });
}

/** Set (or clear) the `/Lock` a signature candidate will be authored with. */
export function setCandidateLock(
  candidates: readonly FieldCandidate[],
  id: string,
  lock: FieldLock | null,
): FieldCandidate[] {
  return candidates.map((c) => (c.id === id ? { ...c, lock } : c));
}

export function setCandidateMultiline(
  candidates: readonly FieldCandidate[],
  id: string,
  multiline: boolean,
): FieldCandidate[] {
  return candidates.map((c) => (c.id === id ? { ...c, multiline } : c));
}

export function removeCandidate(
  candidates: readonly FieldCandidate[],
  id: string,
): FieldCandidate[] {
  return candidates.filter((c) => c.id !== id);
}

export function moveCandidate(
  candidates: readonly FieldCandidate[],
  id: string,
  rect: { x: number; y: number; w: number; h: number },
): FieldCandidate[] {
  return candidates.map((c) => (c.id === id ? { ...c, rect } : c));
}

/** The name rules the detection door applies, repeated here because the user
 * can type one: `.` separates parent from child and `/` delimits a name, so
 * neither survives into a field name. */
export function sanitizeFieldName(label: string | null): string {
  const kept = [...(label ?? '').trim()].filter(
    (ch) => /[0-9A-Za-z]/.test(ch) || ch === ' ' || ch === '_' || ch === '-' || ch.charCodeAt(0) > 127,
  );
  return kept
    .join('')
    .split(/\s+/)
    .filter(Boolean)
    .join('_')
    .replace(/^_+|_+$/g, '');
}

function record(renamed: Map<string, string>, from: string, to: string): string {
  if (from && !renamed.has(from)) renamed.set(from, to);
  return to;
}

function uniqueName(base: string, taken: Set<string>): string {
  const stem = base || 'Field';
  if (!taken.has(stem)) {
    taken.add(stem);
    return stem;
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${stem}_${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  taken.add(stem);
  return stem;
}

/** A checked candidate resolved to the page and rectangle it will be written
 * at. The canvas produces these; the geometry conversion is not this module's. */
export interface ResolvedCandidate {
  candidate: FieldCandidate;
  /** 0-based, in the file's committed page order. */
  pageIndex: number;
  rect: [number, number, number, number];
}

function unionRect(
  rects: readonly [number, number, number, number][],
): [number, number, number, number] {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

const SPEC_TYPE: Record<CandidateKind, NewFieldType> = {
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radio',
  signature: 'signature',
};

/**
 * The accepted batch, as specs the authoring path already takes.
 *
 * A radio group collapses into ONE spec whose options carry their own
 * rectangles — the four circles a form draws are four separately placed
 * buttons, and equal cells of one enclosing rectangle cannot express that.
 * Names are made unique against the document AND within the batch, because a
 * duplicate name aborts the whole write.
 *
 * A lock may name a field this same batch creates, and uniquing can rename that
 * field — so lock targets are rewritten through the batch's own renames after
 * every name is settled. A name the batch does not create passes through: it is
 * the document's, and the write validates it there.
 */
export function buildFieldSpecs(
  resolved: readonly ResolvedCandidate[],
  existingNames: ReadonlySet<string>,
): NewFieldSpec[] {
  const taken = new Set(existingNames);
  // Original candidate name → the name actually written. First occurrence wins:
  // two candidates offered under one name are already one name to the reviewer.
  const renamed = new Map<string, string>();
  const specs: NewFieldSpec[] = [];
  const groupOrder: string[] = [];
  const groups = new Map<string, ResolvedCandidate[]>();
  for (const entry of resolved) {
    const key = entry.candidate.kind === 'radio' ? entry.candidate.group : null;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(entry);
  }
  const emittedGroups = new Set<string>();
  for (const entry of resolved) {
    const candidate = entry.candidate;
    const key = candidate.kind === 'radio' ? candidate.group : null;
    if (key) {
      if (emittedGroups.has(key)) continue;
      emittedGroups.add(key);
      const members = groups.get(key)!;
      // Every option of one group lands on the page the group's FIRST option
      // is on: a radio group is one field, and a field's widgets that straddle
      // pages would be one field with two homes.
      const pageIndex = members[0].pageIndex;
      const onPage = members.filter((m) => m.pageIndex === pageIndex);
      specs.push({
        name: record(renamed, candidate.name, uniqueName(sanitizeFieldName(candidate.name), taken)),
        type: 'radio',
        pageIndex,
        rect: unionRect(onPage.map((m) => m.rect)),
        options: onPage.map((m, index) => ({
          label: m.candidate.exportValue || m.candidate.label || `Option ${index + 1}`,
          rect: m.rect,
        })),
      });
      continue;
    }
    const spec: NewFieldSpec = {
      name: record(renamed, candidate.name, uniqueName(sanitizeFieldName(candidate.name), taken)),
      type: SPEC_TYPE[candidate.kind],
      pageIndex: entry.pageIndex,
      rect: entry.rect,
    };
    if (candidate.kind === 'text') {
      if (candidate.multiline) spec.multiline = true;
      if (candidate.comb && candidate.comb > 0 && !candidate.multiline) {
        spec.comb = true;
        spec.maxLength = candidate.comb;
      }
    }
    if (candidate.kind === 'signature' && candidate.lock) spec.lock = candidate.lock;
    specs.push(spec);
  }
  for (const spec of specs) {
    if (!spec.lock) continue;
    spec.lock = {
      action: spec.lock.action,
      fields: spec.lock.fields.map((name) => renamed.get(name) ?? name),
    };
  }
  return specs;
}

/** The detection payload as review state, bound to the pages it was found on.
 * A candidate whose page the caller cannot resolve is dropped rather than
 * bound to a guess — the caller counts those and reports them. */
export function candidatesFromDetection(
  result: DetectionResult,
  path: string,
  resolve: (row: DetectedCandidate) => {
    pageId: string;
    rect: { x: number; y: number; w: number; h: number };
    rotationAtDraw: 0 | 90 | 180 | 270;
  } | null,
  newId: () => string,
): { candidates: FieldCandidate[]; skipped: number } {
  const candidates: FieldCandidate[] = [];
  let skipped = 0;
  for (const row of result.candidates) {
    const placed = resolve(row);
    if (!placed) {
      skipped += 1;
      continue;
    }
    candidates.push({
      id: newId(),
      path,
      pageId: placed.pageId,
      rect: placed.rect,
      rotationAtDraw: placed.rotationAtDraw,
      page: row.page,
      kind: candidateKind(row.kind),
      name: row.name,
      label: row.label,
      group: row.group,
      exportValue: row.export,
      multiline: row.multiline,
      comb: row.comb,
      format: row.format,
      evidence: row.evidence,
      warnings: row.warnings,
      checked: false,
      lock: null,
    });
  }
  return { candidates, skipped };
}

/** Candidates whose page still exists, pruned before anything reads them —
 * a stale generation-tagged id must never reach a gesture. */
export function prunedCandidates(
  candidates: readonly FieldCandidate[],
  livePageIds: ReadonlySet<string>,
): FieldCandidate[] {
  return candidates.filter((c) => livePageIds.has(c.pageId));
}
