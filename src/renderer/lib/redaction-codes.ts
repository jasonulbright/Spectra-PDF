// Redaction code sets (F15 slice E — brief 42 § 6).
//
// A redaction code is a short label a reader sees IN the black box saying why
// the content was removed: `(b)(6)` on a FOIA release, `(k)(2)` under the
// Privacy Act. The code's label IS the overlay text — the format has no
// separate key for it — so a code set is a catalogue of (id, label,
// description), i.e. DATA, not code.
//
// Two built-in sets ship (the U.S. FOIA exemptions and the Privacy Act
// exemptions) plus USER-DEFINED sets, which persist and import/export as JSON.
// A firm's own code set is the common case in the work this tool is for, and
// refusing it would be a boundary invented out of "the king ships two lists".
//
// Storage mirrors `symbol-library.ts` / `stamp-library.ts`: its own
// localStorage key, pure functions around it, a subscription so every open
// surface re-reads together.

export interface RedactionCode {
  /** Stable id, unique within its set. Letters, digits, dot, dash, underscore. */
  id: string;
  /** What is DRAWN in the box. This is the overlay text, verbatim. */
  label: string;
  /** What the code means — shown beside it in the picker, never drawn. */
  description: string;
}

export interface RedactionCodeSet {
  id: string;
  name: string;
  codes: RedactionCode[];
}

export const CODE_SET_MAX_CODES = 400;
const KEY = 'spectra-redaction-code-sets';

/**
 * The U.S. Freedom of Information Act exemptions, 5 U.S.C. § 552(b).
 *
 * Labels are the citation as it is written on a release — that string is what
 * gets drawn in the box, so it is the label and not a prettified version of
 * one.
 */
export const FOIA_SET: RedactionCodeSet = {
  id: 'foia',
  name: 'FOIA exemptions',
  codes: [
    { id: 'b1', label: '(b)(1)', description: 'Classified in the interest of national defense or foreign policy' },
    { id: 'b2', label: '(b)(2)', description: 'Related solely to internal personnel rules and practices' },
    { id: 'b3', label: '(b)(3)', description: 'Specifically exempted from disclosure by another statute' },
    { id: 'b4', label: '(b)(4)', description: 'Trade secrets and privileged or confidential commercial information' },
    { id: 'b5', label: '(b)(5)', description: 'Privileged inter-agency or intra-agency communications' },
    { id: 'b6', label: '(b)(6)', description: 'Personnel, medical and similar files — a clearly unwarranted invasion of personal privacy' },
    { id: 'b7a', label: '(b)(7)(A)', description: 'Law-enforcement records that could interfere with proceedings' },
    { id: 'b7b', label: '(b)(7)(B)', description: 'Law-enforcement records that would deprive a person of a fair trial' },
    { id: 'b7c', label: '(b)(7)(C)', description: 'Law-enforcement records — an unwarranted invasion of personal privacy' },
    { id: 'b7d', label: '(b)(7)(D)', description: 'Law-enforcement records that could disclose a confidential source' },
    { id: 'b7e', label: '(b)(7)(E)', description: 'Law-enforcement techniques, procedures or guidelines' },
    { id: 'b7f', label: '(b)(7)(F)', description: 'Law-enforcement records that could endanger life or physical safety' },
    { id: 'b8', label: '(b)(8)', description: 'Records of financial institution examinations' },
    { id: 'b9', label: '(b)(9)', description: 'Geological and geophysical information concerning wells' },
  ],
};

/** The Privacy Act general and specific exemptions, 5 U.S.C. § 552a(j) and (k). */
export const PRIVACY_ACT_SET: RedactionCodeSet = {
  id: 'privacy-act',
  name: 'Privacy Act exemptions',
  codes: [
    { id: 'j1', label: '(j)(1)', description: 'General exemption — Central Intelligence Agency records' },
    { id: 'j2', label: '(j)(2)', description: 'General exemption — criminal law-enforcement records' },
    { id: 'k1', label: '(k)(1)', description: 'Classified material' },
    { id: 'k2', label: '(k)(2)', description: 'Investigatory material compiled for law-enforcement purposes' },
    { id: 'k3', label: '(k)(3)', description: 'Records maintained for Secret Service protective duties' },
    { id: 'k4', label: '(k)(4)', description: 'Statistical records required by statute' },
    { id: 'k5', label: '(k)(5)', description: 'Investigatory material for federal employment or contracts' },
    { id: 'k6', label: '(k)(6)', description: 'Testing or examination material for federal service' },
    { id: 'k7', label: '(k)(7)', description: 'Evaluation material for armed-forces promotion' },
  ],
};

export const BUILTIN_CODE_SETS: readonly RedactionCodeSet[] = [FOIA_SET, PRIVACY_ACT_SET];

const ID_RE = /^[A-Za-z0-9._-]+$/;

function isCode(value: unknown): value is RedactionCode {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    ID_RE.test(c.id) &&
    typeof c.label === 'string' &&
    c.label.length > 0 &&
    (c.description === undefined || typeof c.description === 'string')
  );
}

/** Parse a stored/imported set, or null. Rejects rather than repairing: a
 * half-understood code set would draw a label nobody chose into a black box
 * that cannot be undone once applied. */
export function parseCodeSet(value: unknown): RedactionCodeSet | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null;
  if (typeof s.name !== 'string' || s.name.trim() === '') return null;
  if (!Array.isArray(s.codes) || s.codes.length === 0) return null;
  if (s.codes.length > CODE_SET_MAX_CODES) return null;
  const codes: RedactionCode[] = [];
  const seen = new Set<string>();
  for (const raw of s.codes) {
    if (!isCode(raw)) return null;
    if (seen.has(raw.id)) return null;
    seen.add(raw.id);
    codes.push({ id: raw.id, label: raw.label, description: raw.description ?? '' });
  }
  return { id: s.id, name: s.name.trim(), codes };
}

export function loadUserCodeSets(): RedactionCodeSet[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: RedactionCodeSet[] = [];
    for (const entry of raw) {
      const parsed = parseCodeSet(entry);
      // A built-in id may not be shadowed: the picker resolves by id, and a
      // user set called `foia` would silently replace the citation list a
      // release is checked against.
      if (parsed && !BUILTIN_CODE_SETS.some((s) => s.id === parsed.id)) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserCodeSets(sets: readonly RedactionCodeSet[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sets));
  } catch {
    /* storage full or unavailable — the built-ins still work */
  }
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function subscribeCodeSets(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Every set the picker offers: the built-ins first, then the user's. */
export function getCodeSets(): RedactionCodeSet[] {
  return [...BUILTIN_CODE_SETS, ...loadUserCodeSets()];
}

export function addCodeSet(set: RedactionCodeSet): 'added' | 'updated' {
  const sets = loadUserCodeSets();
  const index = sets.findIndex((s) => s.id === set.id);
  if (index === -1) sets.push(set);
  else sets[index] = set;
  saveUserCodeSets(sets);
  return index === -1 ? 'added' : 'updated';
}

export function removeCodeSet(id: string): void {
  saveUserCodeSets(loadUserCodeSets().filter((s) => s.id !== id));
}

/** The code with this id, in any set. `setId/codeId` — codes are unique
 * within a set, not across sets. */
export function findCode(reference: string | undefined): RedactionCode | null {
  if (!reference) return null;
  const slash = reference.indexOf('/');
  if (slash === -1) return null;
  const set = getCodeSets().find((s) => s.id === reference.slice(0, slash));
  return set?.codes.find((c) => c.id === reference.slice(slash + 1)) ?? null;
}

export const CODE_SET_FILE_KIND = 'spectra-redaction-code-set';

export function codeSetToJson(set: RedactionCodeSet): string {
  return JSON.stringify({ kind: CODE_SET_FILE_KIND, version: 1, ...set }, null, 2);
}

export interface CodeSetParse {
  set: RedactionCodeSet | null;
  /** A refusal KEY, so the message localizes; null when the parse succeeded. */
  refusal: 'notJson' | 'notASet' | 'builtinId' | null;
}

export function parseCodeSetFile(text: string): CodeSetParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { set: null, refusal: 'notJson' };
  }
  const parsed = parseCodeSet(raw);
  if (!parsed) return { set: null, refusal: 'notASet' };
  if (BUILTIN_CODE_SETS.some((s) => s.id === parsed.id)) {
    return { set: null, refusal: 'builtinId' };
  }
  return { set: parsed, refusal: null };
}
