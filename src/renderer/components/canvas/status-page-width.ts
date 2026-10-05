import { pageDigits } from '../../lib/page-field-width';

/** Below this the field is narrower than the shipped numeric box. */
export const STATUS_PAGE_FIELD_MIN_PX = 38;

/**
 * Widest the field grows, in `ch`. A page label is free text from the
 * document; past this the field scrolls its text rather than pushing the zoom
 * controls off the status bar.
 */
export const STATUS_PAGE_FIELD_MAX_CH = 16;

/** Padding (2px + 2px) and borders (1px + 1px) of `.canvas-status-pageinput`. */
const FIELD_CHROME_PX = 6;

/**
 * CSS width of the status bar's page field. The field holds a page number or
 * a page label ("iv", "A-1", free text), so it follows the text it shows and
 * the widest page number of the document, plus one `ch` of slack because a
 * label's letters are wider than the digit `ch` measures.
 */
export function statusPageFieldWidth(value: string, total: number): string {
  const chars = Math.min(
    Math.max(Array.from(value).length, pageDigits(total)) + 1,
    STATUS_PAGE_FIELD_MAX_CH,
  );
  return `max(${STATUS_PAGE_FIELD_MIN_PX}px, calc(${chars}ch + ${FIELD_CHROME_PX}px))`;
}
