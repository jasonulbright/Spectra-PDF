// Edit-mode text runs: the display-space run shape (populated by
// `edit-paragraphs.ts` from the paragraph listing, which carries the runs
// too), plus the LOCAL keystroke validation the inline edit box runs against
// each run's finite encodable inventory — live refusal ("this document's font
// does not contain 'X'"), never a save-time surprise.

/** Sentinel returned by the App edit handlers when the user DECLINED the
 * signed-document warning — distinct from success (void) and from failure
 * (throw), so the canvas can restore its listing and say so; a silent
 * return was visually indistinguishable from a successful edit
 * (regression, both edit kinds). */
export const EDIT_DECLINED = 'edit-declined' as const;

export interface EditTextRun {
  /** Engine id — DFS show-op order on the page. */
  index: number;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  nested: boolean;
  editable: boolean;
  /** Why an uneditable run refuses (shown on hover/selection). */
  reason: string | null;
  /** The finite character inventory the run's font can encode. */
  encodable: string;
  /** Ligature sequences the font round-trips (unambiguous
   * multi-char inverses) — validation matches them longest-first. */
  sequences: string[];
  /** The run's advances/rect were computed in vertical-writing
   * mode (Identity-V / Uni*-UCS2-V). the surfaces consume this. */
  vertical: boolean;
  /** The run's font size (points) — an e2e observes a per-span
   * size bump as a run listing back at the larger size. */
  fontSize: number;
}

/** Characters of `value` the font cannot encode, deduplicated in order —
 * empty means the value is fully expressible. */
/** The longest-match walk shared by run and paragraph validation.
 * MIRRORS the engine's encode order exactly — sequences (longest first)
 * BEFORE the single map — because a char can be unreachable singly yet
 * encodable inside a ligature sequence; a singles-first walk would
 * false-refuse text the engine accepts. Greedy like the engine (no
 * backtracking): where greedy fails, the engine fails identically, so
 * validation and belt agree. */
export function walkMissing(
  chars: readonly string[],
  singles: ReadonlySet<string>,
  sequences: readonly string[],
  skipSpaces: boolean,
): string[] {
  const seqs = [...sequences].filter((q) => q.length > 1).sort((a, b) => b.length - a.length);
  const missing: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (skipSpaces && ch === ' ') {
      i += 1;
      continue;
    }
    let matched = 0;
    for (const seq of seqs) {
      const sa = Array.from(seq);
      if (i + sa.length <= chars.length && sa.every((c, k) => chars[i + k] === c)) {
        matched = sa.length;
        break;
      }
    }
    if (matched > 0) {
      i += matched;
      continue;
    }
    if (!singles.has(ch) && !missing.includes(ch)) missing.push(ch);
    i += 1;
  }
  return missing;
}

export function unencodableChars(
  value: string,
  encodable: string,
  sequences: readonly string[] = [],
): string[] {
  return walkMissing(Array.from(value), new Set(encodable), sequences, false);
}
