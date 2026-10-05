/** Names at or below this many graphemes are never split: the tab's minimum
 * width shows them whole or nearly so, and a plain end ellipsis reads better. */
export const TAB_SPLIT_MIN = 12;

/** Graphemes kept whole at the end of a long name: the extension and the
 * distinguishing suffix ("-1.pdf", "-signed.pdf") that ends most series. */
export const TAB_TAIL = 6;

/**
 * Scripts whose letters join or reorder across neighbours. A name cut into two
 * elements is shaped as two runs, so a word split between them renders in its
 * isolated forms and a reordering vowel or conjunct loses its partner.
 */
const SHAPED_SCRIPT = new RegExp(
  '[' +
    [
      'Arabic', 'Syriac', 'Nko', 'Mandaic', 'Mongolian', 'Phags_Pa', 'Adlam',
      'Hanifi_Rohingya', 'Sogdian', 'Manichaean', 'Psalter_Pahlavi',
      'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu',
      'Kannada', 'Malayalam', 'Sinhala', 'Tibetan', 'Thai', 'Lao', 'Khmer',
      'Myanmar', 'Balinese', 'Javanese', 'Tai_Tham', 'Tai_Viet', 'New_Tai_Lue',
    ]
      .map((script) => `\\p{Script=${script}}`)
      .join('') +
    ']',
  'u',
);

let segmenter: Intl.Segmenter | null | undefined;

/** User-perceived characters; code points only where the runtime has no
 * segmenter. A combining mark, a ZWJ sequence or a flag stays one unit. */
function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * A tab label cut for middle truncation: `head` takes the ellipsis, `tail`
 * always shows. Ten tabs of "summary-1.pdf" … "summary-9.pdf" truncated at the
 * end all read "sum…". An empty `tail` means the name renders whole in one
 * element.
 */
export function splitTabLabel(name: string): { head: string; tail: string } {
  if (SHAPED_SCRIPT.test(name)) return { head: name, tail: '' };
  const units = graphemes(name);
  if (units.length <= TAB_SPLIT_MIN) return { head: name, tail: '' };
  return {
    head: units.slice(0, units.length - TAB_TAIL).join(''),
    tail: units.slice(units.length - TAB_TAIL).join(''),
  };
}
