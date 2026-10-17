/**
 * How many leading items of a strip fit inline: the largest count whose
 * widths plus the gaps between them stay within `available`. Items are kept in
 * priority order, so the remainder (the tail) goes to the overflow menu.
 */
export function inlineItemCount(
  widths: readonly number[],
  available: number,
  gap: number,
): number {
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (i > 0 ? gap : 0) + widths[i];
    if (next > available) return i;
    used = next;
  }
  return widths.length;
}

export type EditStripStatusKind = 'busy' | 'notice' | 'reason' | 'hint';

export interface EditStripStatusInput {
  busy: boolean;
  notice: { text: string; error: boolean } | null;
  hasSelection: boolean;
  selectionKind: 'image' | 'text' | 'para' | 'vector' | null;
  textEditable: boolean;
  textReason: string | null;
}

/**
 * The one line the Edit strip's status shows, for every selection kind: the
 * in-flight state first, then the last action's notice, then why a selected
 * run cannot be edited, then the hint when nothing is selected. Text values
 * are resolved by the caller; `text` is null for the busy and hint kinds.
 */
export function editStripStatus(
  input: EditStripStatusInput,
): { kind: EditStripStatusKind; text: string | null; error: boolean } | null {
  if (input.busy) return { kind: 'busy', text: null, error: false };
  if (input.notice) return { kind: 'notice', text: input.notice.text, error: input.notice.error };
  if (input.selectionKind === 'text' && !input.textEditable && input.textReason) {
    return { kind: 'reason', text: input.textReason, error: true };
  }
  if (!input.hasSelection) return { kind: 'hint', text: null, error: false };
  return null;
}
