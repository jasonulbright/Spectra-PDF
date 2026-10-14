// The lines of a text box as the canvas shows them before the commit: the
// lines the commit will write. A text in the standard Helvetica is wrapped
// here by that font's advances (`wrapText`, the build's own wrap). A text
// the engine draws is wrapped by the engine (`text_box_appearance` with
// `draw` off), and the canvas shows the lines it answers.
import type { PageAnnotation } from '../state/types';
import { OWN_TEXT_SIZE, LEADING_FACTOR, needsShaping, standardAdvance, standardTextHolds, shownLine, textForGlyphCoverage, wrapLines } from './free-text-redraw';
import { coverageHolds, DEFAULT_FACE_STYLE } from './text-box-faces';
import type { FaceStyle } from './text-box-faces';
import { EngineError } from './engine-messages';
import { learnBundledFaces } from './text-box-engine';
import type { TextBoxEngine } from './text-box-engine';

/** The space between the edge of a text box and its text, in points; the
 *  build's `TEXT_BOX_PAD`. */
export const TEXT_BOX_PAD = 3;

export interface BodyLayout {
  /** The lines in logical order. */
  lines: string[];
  /** The base direction of the text is right to left. */
  rtl: boolean;
  /** 0 left, 1 centred, 2 right. */
  align: 0 | 1 | 2;
  /** The indexes of the lines that end with a drawn soft hyphen. */
  hyphens?: number[];
}

/** How the commit lays out the text of `a`: in the standard Helvetica, by
 *  the engine, or in a font of the file whose advances the canvas does not
 *  hold (`natural`: the canvas wraps the text itself). */
export interface BodyPlan {
  via: 'standard' | 'engine' | 'natural';
  size: number;
  style: FaceStyle;
  /** The alignment the original states, which the commit writes. With none
   *  the standard face aligns left and the engine aligns by the direction
   *  of the text. */
  align?: 0 | 1 | 2;
}

export function bodyPlanOf(a: Pick<PageAnnotation, 'note' | 'importedOriginal' | 'textRedraw'>): BodyPlan {
  const text = a.note ?? '';
  const record = a.importedOriginal ? a.textRedraw : undefined;
  const size = record?.size ?? OWN_TEXT_SIZE;
  const style = record?.style ?? DEFAULT_FACE_STYLE;
  const stated = record?.align !== undefined ? { align: record.align } : {};
  const plain = !needsShaping(text);
  if (a.importedOriginal) {
    if (!record) return { via: 'natural', size, style };
    if (plain && record.holds !== undefined && coverageHolds(record.holds, textForGlyphCoverage(text))) {
      return { via: record.standard ? 'standard' : 'natural', size, style, ...stated };
    }
    if (plain && record.faceless && standardTextHolds(textForGlyphCoverage(text))) return { via: 'standard', size, style, ...stated };
    return { via: 'engine', size, style, ...stated };
  }
  return plain && standardTextHolds(text) ? { via: 'standard', size, style } : { via: 'engine', size, style };
}

/** The lines of a text in the standard Helvetica, aligned as the commit
 *  aligns them. */
export function standardLayout(text: string, size: number, width: number, align: 0 | 1 | 2 = 0): BodyLayout {
  const { lines, hyphens } = wrapLines(text, width, (line) => standardAdvance(line, size));
  return { lines, rtl: false, align, ...(hyphens.length > 0 ? { hyphens } : {}) };
}

/** A line as the canvas shows it: what the commit draws of it, with the
 *  hyphen of a break as a hyphen-minus (a browser draws a soft hyphen only
 *  where it breaks a line itself). An empty line keeps its height by a
 *  no-break space. */
export function displayLine(line: string, hyphen: boolean): string {
  const inside = shownLine(line, false);
  if (hyphen) return `${inside}-`;
  return inside === '' ? String.fromCharCode(0xa0) : inside;
}

let engine: TextBoxEngine | undefined;

/** Gives the canvas its engine. */
export function provideTextBoxEngine(next: TextBoxEngine | undefined): void {
  engine = next;
}

const CACHE_LIMIT = 256;
const answers = new Map<string, BodyLayout | null>();
const pending = new Map<string, Promise<BodyLayout | null>>();
const unavailable = new Set<string>();

/** The most UTF-16 units of text the engine lays out in one call. The
 *  engine counts characters (`text_box._MAX_CHARS`), never more than the
 *  units. */
export const ENGINE_LAYOUT_TEXT_LIMIT = 1_000_000;

/** The engine's error for a request it does not take
 *  (`text_box._block_request`), as the engine words it. */
export const MALFORMED_LAYOUT_REQUEST = 'a text block request is malformed';

/** The engine has no lines for this request, and the same request gets the
 *  same answer: the request is not made again. */
export class LayoutUnavailable extends Error {
  constructor() {
    super('the engine lays out no lines for this text');
    this.name = 'LayoutUnavailable';
  }
}

/** Whether a failed layout call is the engine's answer to the request. Any
 *  other failure says nothing of the request: the engine did not answer. */
export function isLayoutAnswer(error: unknown): boolean {
  return error instanceof LayoutUnavailable
    || (error instanceof EngineError && error.raw === MALFORMED_LAYOUT_REQUEST);
}

/** The waits before a layout call that got no answer is made again, in ms. */
export const LAYOUT_RETRY_MS = [250, 500, 1000, 2000] as const;

/** The wait before the call is made again after `failures` calls with no
 *  answer, in ms; null when no more calls are made for the text shown. */
export function layoutRetryDelay(failures: number): number | null {
  return failures >= 1 && failures <= LAYOUT_RETRY_MS.length ? LAYOUT_RETRY_MS[failures - 1] : null;
}

function keepUnavailable(key: string): void {
  if (unavailable.size >= CACHE_LIMIT) unavailable.delete(unavailable.values().next().value as string);
  unavailable.add(key);
}

const keyOf = (text: string, plan: BodyPlan, width: number): string =>
  JSON.stringify([text, plan.size, plan.style.family, plan.style.bold === true, plan.style.italic === true, plan.align ?? -1, Math.round(width * 100)]);

const ALIGN_NAMES = ['left', 'center', 'right'] as const;

/** The engine's lines for a text, when an earlier call answered them: a
 *  layout, or null for a text the engine refuses. */
export function knownEngineLayout(text: string, plan: BodyPlan, width: number): BodyLayout | null | undefined {
  return answers.get(keyOf(text, plan, width));
}

/** Whether the engine answered that it lays out no lines for a text: the
 *  canvas wraps the text itself and asks no more. */
export function engineLayoutUnavailable(text: string, plan: BodyPlan, width: number): boolean {
  return text.length > ENGINE_LAYOUT_TEXT_LIMIT || unavailable.has(keyOf(text, plan, width));
}

/**
 * Asks the engine for the lines of a text. Null when the engine refuses the
 * text.
 *
 * Rejects with `LayoutUnavailable` when the engine answers the request with
 * an error, or the text is longer than a call takes: that answer is kept,
 * and no call is made for the same request again. Rejects with any other
 * error when there is no engine or the call got no answer: nothing is kept,
 * so the next request asks again. Requests for one text made while a call
 * runs share it.
 */
export function engineLayout(text: string, plan: BodyPlan, width: number): Promise<BodyLayout | null> {
  if (text.length > ENGINE_LAYOUT_TEXT_LIMIT) return Promise.reject(new LayoutUnavailable());
  const key = keyOf(text, plan, width);
  const known = answers.get(key);
  if (known !== undefined) return Promise.resolve(known);
  if (unavailable.has(key)) return Promise.reject(new LayoutUnavailable());
  let asked = pending.get(key);
  if (!asked) {
    const ask = engine;
    if (!ask) return Promise.reject(new Error('no text engine'));
    void learnBundledFaces();
    asked = ask([{
      text, size: plan.size, leading: plan.size * LEADING_FACTOR, width, family: plan.style.family,
      ...(plan.style.bold ? { bold: true } : {}), ...(plan.style.italic ? { italic: true } : {}),
      ...(plan.align !== undefined ? { align: ALIGN_NAMES[plan.align] } : {}),
    }], false).then((answer) => {
      const block = answer.blocks[0];
      if (!block) throw new Error('the engine answered no block');
      const layout: BodyLayout | null = block.refused !== undefined ? null
        : {
          lines: block.lines, rtl: block.rtl, align: block.align === 'right' ? 2 : block.align === 'center' ? 1 : 0,
          ...(block.hyphens && block.hyphens.length > 0 ? { hyphens: block.hyphens } : {}),
        };
      if (answers.size >= CACHE_LIMIT) answers.delete(answers.keys().next().value as string);
      answers.set(key, layout);
      return layout;
    }, (error: unknown) => {
      if (!isLayoutAnswer(error)) throw error;
      keepUnavailable(key);
      throw new LayoutUnavailable();
    }).finally(() => {
      pending.delete(key);
    });
    pending.set(key, asked);
  }
  return asked;
}

/** Forgets every answer: a test starts from none. */
export function forgetEngineLayouts(): void {
  answers.clear();
  pending.clear();
  unavailable.clear();
}
