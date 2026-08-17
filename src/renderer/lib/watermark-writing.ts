// The watermark card's writing mode, as data rather than as JSX.
//
// Three facts the card must not decide inline:
//
//   * A HORIZONTAL stamp sends NO `writing_mode` at all. The engine pins
//     `writing_mode="horizontal"` as byte-identical to omitting the
//     parameter, and omitting it is what keeps that pin honest from this
//     side: a stamp authored before this control existed and one authored
//     with the control left alone are the same engine call, argument for
//     argument.
//   * A picture and a lifted PDF page carry their own orientation, so a
//     writing mode means nothing to them and the engine refuses one. A mode
//     chosen for text and then left behind by a source switch therefore
//     resolves back to horizontal here, where the control is not on screen
//     to be turned off — a mode left armed by a hidden control going live is
//     the failure this exists to prevent.
//   * The COLUMN DIRECTION is the engine's answer, derived from the text by
//     the same evidence a re-listing uses. It is read back off the result,
//     never guessed from the request.

export type WatermarkSource = 'text' | 'image' | 'pdf';
export type WatermarkWriting = 'horizontal' | 'vertical';

/** The mode a stamp from `source` actually carries. */
export function effectiveWriting(
  source: WatermarkSource,
  writing: WatermarkWriting,
): WatermarkWriting {
  return source === 'text' ? writing : 'horizontal';
}

/** The engine arguments the mode contributes — EMPTY for a horizontal stamp. */
export function writingParams(
  source: WatermarkSource,
  writing: WatermarkWriting,
): { writing_mode?: 'vertical' } {
  return effectiveWriting(source, writing) === 'vertical' ? { writing_mode: 'vertical' } : {};
}

/** The column direction the engine RESOLVED, or null when the stamp was not
 *  vertical (a horizontal result, an older engine, a refusal). */
export function resolvedColumns(writingMode: unknown): 'rtl' | 'ltr' | null {
  if (writingMode === 'vertical-lr') return 'ltr';
  if (writingMode === 'vertical-rl') return 'rtl';
  return null;
}
