// The new-field card's writing mode, as data rather than as JSX — the
// watermark card's `writing-mode` shape with one addition a FIELD needs.
//
// A field states its writing mode in the CMap of the font its `/DA` names
// (ISO 32000-2 9.7.5.1), and a predefined vertical CMap is bound to exactly
// one character collection. So a vertical field carries a SCRIPT as well as a
// mode: the two are one request, and neither is meaningful alone.
//
// Three facts the card must not decide inline:
//
//   * A HORIZONTAL field contributes NO key. A field authored before this
//     control existed and one authored with the control left alone are the
//     same spec, key for key — which is what keeps the pdf-lib create path
//     byte-identical for every form that never asks for a column.
//   * A field whose value is drawn as a MARK rather than a text run has no
//     writing mode. A mode left behind by a kind switch resolves back to
//     horizontal here, where the control is not on screen to be turned off —
//     a mode left armed by a hidden control going live is the failure this
//     exists to prevent.
//   * pdf-lib cannot write a CID-keyed font, so a vertical field is created
//     by pdf-lib and then BOUND by the engine. Which engine calls that costs
//     is a property of the batch, computed once here rather than re-derived
//     at the call site.
import type { NewFieldSpec, NewFieldType } from './form-authoring';

export type FieldWriting = 'horizontal' | 'vertical';

/** The character collections the bundled vertical faces cover. The wire
 * spelling IS the engine's script name — the UI names the script, never the
 * registry-ordering behind it. */
export type FieldScript = 'japanese' | 'simplified-chinese' | 'traditional-chinese' | 'korean';

export const FIELD_SCRIPTS = [
  'japanese',
  'simplified-chinese',
  'traditional-chinese',
  'korean',
] as const satisfies readonly FieldScript[];

/** The kinds whose value is drawn as a text run. A button draws a mark from
 * ZapfDingbats and a signature field draws no value at all, so vertical
 * writing is undefined for them — the engine's own rule, mirrored so the
 * control is absent rather than present-and-refused. */
const TEXT_RUN_KINDS: ReadonlySet<NewFieldType> = new Set(['text', 'dropdown', 'optionlist']);

/** Whether a field of this kind draws its value as a text run, and so can be
 * asked to write vertically at all. */
export function writesTextRun(type: NewFieldType): boolean {
  return TEXT_RUN_KINDS.has(type);
}

/** The mode a field of `type` actually carries. */
export function effectiveFieldWriting(type: NewFieldType, writing: FieldWriting): FieldWriting {
  return writesTextRun(type) ? writing : 'horizontal';
}

/** The spec keys the mode contributes — EMPTY for a horizontal field. */
export function fieldWritingParams(
  type: NewFieldType,
  writing: FieldWriting,
  script: FieldScript,
): { writingMode?: 'vertical'; script?: FieldScript } {
  return effectiveFieldWriting(type, writing) === 'vertical'
    ? { writingMode: 'vertical', script }
    : {};
}

/** One `author_vertical_field_font` call: the fields of one batch bound to
 * one character collection. */
export interface VerticalFontCall {
  script: FieldScript;
  fields: string[];
}

/**
 * The engine calls a created batch still needs, one per script, in the order
 * the scripts first appear.
 *
 * EMPTY for an all-horizontal batch, so the ordinary create stays the single
 * pdf-lib write it has always been. Grouped rather than one call per field
 * because the door takes a list and every call re-saves the whole document:
 * forty Japanese fields are one rewrite, not forty.
 */
export function verticalFontCalls(specs: readonly NewFieldSpec[]): VerticalFontCall[] {
  const calls: VerticalFontCall[] = [];
  const byScript = new Map<FieldScript, VerticalFontCall>();
  for (const spec of specs) {
    const script = spec.script;
    if (script === undefined) continue;
    if (effectiveFieldWriting(spec.type, spec.writingMode ?? 'horizontal') !== 'vertical') continue;
    const name = spec.name.trim();
    if (!name) continue;
    let call = byScript.get(script);
    if (!call) {
      call = { script, fields: [] };
      byScript.set(script, call);
      calls.push(call);
    }
    call.fields.push(name);
  }
  return calls;
}
