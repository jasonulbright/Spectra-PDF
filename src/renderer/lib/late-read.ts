// The "late read clobbers the user's edit" class, and the one rule that closes it.
//
// A panel that seeds editable state from an async engine read has a window in
// which the user can start editing BEFORE the read lands. A bare
// `setState(fromFile)` inside the read's `.then` silently discards whatever
// they did in that window. This is not hypothetical: `PageLabelsPanel` shipped
// with it, and because an EMPTY range list is how the engine is told to REMOVE
// the label tree, the discarded edit turned into DELETED page labels on Apply —
// reported as success, and dismissed twice as an e2e flake before the `null`
// (no tree at all, rather than a wrong style) gave it away.
//
// The rule encoded here: **a late read reseeds everything the user has not
// touched, and nothing they have.**
//
// Why merge rather than simply skip the seed when an edit is in progress —
// which is the obvious fix, and is wrong for any panel whose apply writes a
// FULL REPLACEMENT: skipping leaves the panel's baseline stale (typically
// empty, from before the read), so Apply then sends a payload that deletes
// everything the read had just found. Keeping the file's values as the
// baseline for untouched keys is what makes a diffing Apply still diff against
// the truth. Skipping trades a lost edit for a destroyed document.
//
// Invariant, deliberate: the result's key set is exactly the seed's. A touched
// key the file no longer has is DROPPED, not carried — an edit that cannot
// land is not kept (the same call as dropping un-vendored OCR languages).

// Generic over the RECORD, not its values, so a fixed-shape draft object comes
// back as itself rather than widening to Record<string, string>.
// `current` is deliberately looser than `seed`: it is the state seeded by the
// PREVIOUS read, and for a panel whose key set is the document's (form fields)
// the two genuinely differ — a field can appear or vanish between reads. The
// intersection keeps the shared keys' value types checked while tolerating that.
export function mergeUntouched<R extends Record<string, unknown>>(
  seed: R,
  current: Readonly<Partial<R> & Record<string, unknown>>,
  touched: ReadonlySet<string>,
): R {
  if (touched.size === 0) return { ...seed };
  const merged: Record<string, unknown> = { ...seed };
  for (const key of touched) {
    if (key in seed && key in current) merged[key] = current[key];
  }
  return merged as R;
}
