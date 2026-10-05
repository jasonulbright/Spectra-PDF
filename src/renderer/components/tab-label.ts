/** Names at or below this length are never split: the tab's minimum width
 * shows them whole or nearly so, and a plain end ellipsis reads better. */
export const TAB_SPLIT_MIN = 12;

/** Code points kept whole at the end of a long name: the extension and the
 * distinguishing suffix ("-1.pdf", "-signed.pdf") that ends most series. */
export const TAB_TAIL = 6;

/**
 * A tab label cut for middle truncation: `head` takes the ellipsis, `tail`
 * always shows. Ten tabs of "summary-1.pdf" … "summary-9.pdf" truncated at the
 * end all read "sum…".
 */
export function splitTabLabel(name: string): { head: string; tail: string } {
  const chars = Array.from(name);
  if (chars.length <= TAB_SPLIT_MIN) return { head: name, tail: '' };
  return {
    head: chars.slice(0, chars.length - TAB_TAIL).join(''),
    tail: chars.slice(chars.length - TAB_TAIL).join(''),
  };
}
