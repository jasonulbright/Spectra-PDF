// Cut-off pictures. The engine reports a HEIF source whose file ends early
// (`engine/heif_check.py`): the pages were built from what could be read. A
// result without the report does not mean the picture is undamaged.

/** One `incomplete` entry of an engine result: the source, and the output pages
 * it became ("3" or "3-4"). A watermark picture has no pages of its own. */
export interface IncompleteSource {
  path: string;
  pages?: string;
}

/** The well-formed entries of an engine result's `incomplete` value. */
export function incompleteSources(value: unknown): IncompleteSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is IncompleteSource =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as IncompleteSource).path === 'string' &&
      ['string', 'undefined'].includes(typeof (item as IncompleteSource).pages),
  );
}

/** The run-log sentence; the engine's logs use the same text. */
export const CUT_OFF_LOG_TEXT = 'the file is cut off; parts of the picture can be missing or wrong';
