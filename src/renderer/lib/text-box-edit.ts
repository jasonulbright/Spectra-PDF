// Which edits of a text an annotation draws the commit can draw, decided
// when the edit is made. The reducer asks here before it changes the model;
// the commit build asks the same rules again (`lib/free-text-redraw.ts`) and
// finds nothing to refuse in a model the reducer made.
import type { PageAnnotation } from '../state/types';
import { tChrome } from '../i18n';
import type { UiKey } from '../i18n';
import { importedEdit, keepsScaledAppearance } from './imported-edit';
import { needsShaping, standardTextHolds, textForGlyphCoverage } from './free-text-redraw';
import { charactersWithoutFace, coverageHolds, DEFAULT_FACE_STYLE } from './text-box-faces';
import type { FaceStyle } from './text-box-faces';

/** An edit of a text the commit cannot draw. */
export interface TextBoxRefusal {
  reason: 'font' | 'styled' | 'script' | 'faces' | 'long';
  kind: PageAnnotation['kind'];
  /** 1-based, in the document as composed. */
  page: number;
  /** The first words of the text. */
  words: string;
  /** `script`: the characters no bundled face holds. */
  characters?: string[];
}

const KIND_KEYS: Partial<Record<PageAnnotation['kind'], UiKey>> = {
  freetext: 'canvas.pbar.kind.freetext',
  callout: 'canvas.pbar.kind.callout',
  stamp: 'canvas.pbar.kind.stamp',
  countlegend: 'canvas.pbar.kind.countlegend',
};

/** The first words of a text, at most 40 characters. */
export function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const characters = [...flat];
  if (characters.length <= 40) return flat;
  const cut = characters.slice(0, 40).join('');
  const at = cut.lastIndexOf(' ');
  return `${at > 12 ? cut.slice(0, at) : cut}…`;
}

/** The values a refusal notice names its annotation by. */
export function textBoxNoticeValues(
  a: Pick<PageAnnotation, 'kind' | 'note'>, page: number,
): { kind: string; page: number; words: string } {
  return { kind: tChrome(KIND_KEYS[a.kind] ?? 'canvas.pbar.kind.freetext'), page, words: firstWords(a.note ?? '') };
}

const REASON_KEYS = {
  font: 'refusal.edit.textBoxFont',
  styled: 'refusal.edit.textBoxStyled',
  script: 'refusal.edit.textBoxScript',
  faces: 'refusal.edit.textBoxFaces',
  long: 'refusal.edit.textBoxLong',
} as const;

/** The most UTF-16 units one text an annotation draws holds. The engine
 *  lays out at most 1,000,000 characters in a call (`text_box._MAX_CHARS`). */
export const TEXT_BOX_TEXT_LIMIT = 200_000;

/** The notice of a refusal. */
export function textBoxRefusalText(refusal: TextBoxRefusal): string {
  return tChrome(REASON_KEYS[refusal.reason], {
    kind: tChrome(KIND_KEYS[refusal.kind] ?? 'canvas.pbar.kind.freetext'),
    page: refusal.page,
    words: refusal.words,
    characters: (refusal.characters ?? []).slice(0, 12).join(' '),
  });
}

/** Why the engine cannot draw `text` in the bundled faces of `style`:
 *  `script` with the characters no face of the tables holds, `faces` when
 *  the fonts folder lacks a face file the text needs; or null. */
type EngineRefusal = { reason: 'script'; characters: string[] } | { reason: 'faces' } | null;

function engineRefusal(text: string, style: FaceStyle, faces?: ReadonlySet<string> | null): EngineRefusal {
  const glyphs = textForGlyphCoverage(text);
  if (charactersWithoutFace(glyphs, style, faces).length === 0) return null;
  const never = charactersWithoutFace(glyphs, style, null);
  return never.length > 0 ? { reason: 'script', characters: never } : { reason: 'faces' };
}

const BOLD_FACE_STYLE: FaceStyle = { family: 'sans', bold: true };

/** The texts an annotation draws from its model, each with the style the
 *  build asks the engine for (`planTexts`). */
export function drawnPartsOf(a: PageAnnotation): { text: string; style: FaceStyle }[] {
  if (a.kind === 'freetext' || a.kind === 'callout') return [{ text: a.note ?? '', style: DEFAULT_FACE_STYLE }];
  if (a.kind === 'countlegend') {
    return [
      { text: a.legendTitle ?? '', style: BOLD_FACE_STYLE }, { text: a.legendTotalWord ?? '', style: BOLD_FACE_STYLE },
      ...(a.legendRows ?? []).map((row) => ({ text: row.group, style: DEFAULT_FACE_STYLE })),
    ];
  }
  if (a.kind === 'stamp' && !a.symbolParts && !a.symbolId && !a.signatureFont && !a.carriedAppearance && !a.imageData) {
    return [{ text: (a.note ?? '').toUpperCase(), style: BOLD_FACE_STYLE }];
  }
  return [];
}

/** The texts an annotation draws from its model. */
export function drawnTextsOf(a: PageAnnotation): string[] {
  return drawnPartsOf(a).map((part) => part.text);
}

/** Why the engine cannot draw one of `parts`, each in its style; or null.
 *  The build draws every part of an annotation by the engine when the
 *  standard font cannot draw one of them. */
export function partsRefusal(
  parts: readonly { text: string; style: FaceStyle }[], faces?: ReadonlySet<string> | null,
): EngineRefusal {
  if (parts.every((part) => !needsShaping(part.text) && standardTextHolds(part.text))) return null;
  let lacking = false;
  const characters: string[] = [];
  for (const part of parts) {
    const refused = engineRefusal(part.text, part.style, faces);
    if (refused?.reason === 'script') characters.push(...refused.characters.filter((character) => !characters.includes(character)));
    else if (refused) lacking = true;
  }
  return characters.length > 0 ? { reason: 'script', characters } : lacking ? { reason: 'faces' } : null;
}

/**
 * Why the commit cannot draw `next`, the annotation as an edit leaves it; or
 * null. `page` is the 1-based page number the notice names.
 *
 * A text longer than `TEXT_BOX_TEXT_LIMIT` is refused.
 * A text the standard Helvetica holds is always drawn. A text of an
 * imported text box stays in the font of its original while that font holds
 * it (`textRedraw.holds`). Any other text needs a bundled face for every
 * character, and the fonts folder must hold the face files (`faces`). An
 * imported text box whose text is as imported, and whose
 * record names a refusal, refuses every change that draws it again; a move
 * keeps its appearance, and so does a change of size of a text box that is
 * no callout.
 *
 * `faces` is the set of face files held: with none stated, the files of the
 * fonts folder as they were read (every face of the tables until they are
 * read; the store admits no such edit before the read, `needsBundledFace`);
 * null stands for every face of the tables.
 */
export function textBoxEditRefusal(
  next: PageAnnotation, page: number, faces?: ReadonlySet<string> | null,
): TextBoxRefusal | null {
  const parts = drawnPartsOf(next);
  const texts = parts.map((part) => part.text);
  if (texts.length === 0 || next.baked) return null;
  const refusal = (reason: TextBoxRefusal['reason'], characters?: string[]): TextBoxRefusal => ({
    reason, kind: next.kind, page, words: firstWords(texts.find((text) => text.trim() !== '') ?? ''),
    ...(characters ? { characters } : {}),
  });
  const named = (refused: EngineRefusal): TextBoxRefusal | null =>
    (refused ? refusal(refused.reason, refused.reason === 'script' ? refused.characters : undefined) : null);
  const edit = next.importedOriginal ? importedEdit(next) : null;
  if (edit && !edit.text && !edit.color && !edit.style) {
    // The commit leaves the original as written, or writes it with its
    // appearance: the text is not drawn again.
    if (edit.geometry === 'same' || (edit.geometry === 'moved' && next.kind !== 'stamp') || keepsScaledAppearance(next)) return null;
  }
  if (edit && (next.kind === 'freetext' || next.kind === 'callout')) {
    // With no record the import read nothing of the original: its text
    // cannot be drawn again as it was.
    const record = next.textRedraw;
    const unchanged = record ? record.refusal : 'font';
    const style = record?.style ?? DEFAULT_FACE_STYLE;
    // The record states `script` by the face files of the time of the
    // import: the answer is read again.
    if (!edit.text && unchanged) return unchanged === 'script' ? named(engineRefusal(texts[0], style, faces)) : refusal(unchanged);
    if (texts[0].length > TEXT_BOX_TEXT_LIMIT) return refusal('long');
    if (!needsShaping(texts[0]) && record?.holds !== undefined && coverageHolds(record.holds, textForGlyphCoverage(texts[0]))) return null;
    if (!needsShaping(texts[0]) && record?.faceless && standardTextHolds(textForGlyphCoverage(texts[0]))) return null;
    return named(engineRefusal(texts[0], style, faces));
  }
  if (texts.some((text) => text.length > TEXT_BOX_TEXT_LIMIT)) return refusal('long');
  return named(partsRefusal(parts, faces));
}

const NO_FACE_FILES: ReadonlySet<string> = new Set();

/**
 * Whether the commit draws `next` in a bundled face, so that the gate's
 * answer for it rests on which face files the fonts folder holds: the face
 * tables admit it and a folder with no face file refuses it. A text the
 * standard font draws, a text that stays in the font of its original and an
 * annotation that keeps its appearance need no face file.
 */
export function needsBundledFace(next: PageAnnotation): boolean {
  return textBoxEditRefusal(next, 1, null) === null && textBoxEditRefusal(next, 1, NO_FACE_FILES) !== null;
}

/** The refusal of an edit that needs a bundled face while the face files of
 *  the fonts folder cannot be read. */
export function unreadFacesRefusal(next: PageAnnotation, page: number): TextBoxRefusal {
  const text = drawnTextsOf(next).find((part) => part.trim() !== '') ?? '';
  return { reason: 'faces', kind: next.kind, page, words: firstWords(text) };
}

/**
 * What the text editor of an annotation does with the text typed in it when
 * the user leaves it: `remove` an annotation left with no text, `keep` a text
 * that is as it was, `update` the text, or `refused` when the store does not
 * take the update at once: it refuses it, or it holds it until the face
 * files are read (`facesKnown` false and the text needs a bundled face).
 */
export function textEditorOutcome(
  annotation: PageAnnotation, value: string, page: number, facesKnown = true,
): 'remove' | 'keep' | 'update' | 'refused' {
  const note = value.trim();
  if (!note) return 'remove';
  if (note === annotation.note) return 'keep';
  const next = { ...annotation, note };
  if (textBoxEditRefusal(next, page)) return 'refused';
  return !facesKnown && needsBundledFace(next) ? 'refused' : 'update';
}

/** How the user leaves the text editor. */
export interface EditorLeave {
  /** `confirm`: Ctrl+Enter or the confirm control. `blur`: focus left the editor. */
  by: 'confirm' | 'blur';
  /** The window holds the focus. */
  windowFocused: boolean;
  /** The editor is on screen: its canvas view is not being left. */
  editorShown: boolean;
  /** The face files of the fonts folder are read. */
  facesKnown: boolean;
  /** The focus went to another control of the application that takes text
   *  or a value (`takesInput`). */
  toControl: boolean;
  /** The typed text, trimmed, for which this editor took the focus back
   *  last; null when it did not, or the text changed since. */
  refocusedFor: string | null;
}

/** The parts of an element that tell a control which takes text or a value. */
export interface FocusTarget {
  tagName: string;
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  type?: string;
}

const VALUE_INPUT_TYPES: ReadonlySet<string> = new Set(['button', 'submit', 'reset', 'image', 'hidden']);

/**
 * Whether the element that takes the focus is a control the user types in
 * or picks a value in: an input that is not a button, a text area, a select,
 * or editable content. A disabled or read-only control is none.
 */
export function takesInput(target: FocusTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.disabled || target.readOnly) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  return tag === 'input' && !VALUE_INPUT_TYPES.has((target.type ?? 'text').toLowerCase());
}

/** What the text editor does when the user leaves it. */
export interface EditorStep {
  /** What the store is sent. A refused update is sent: the store shows the notice. */
  send: 'remove' | 'update' | null;
  /**
   * `close`: the editor closes. `open`: it stays open and focused with the
   * typed text. `refocus`: it stays open with the typed text and takes the
   * focus back. An editor is never open without the focus.
   */
  editor: 'close' | 'open' | 'refocus';
  /** With `close` after a refusal: the annotation never had a text and leaves. */
  drop: boolean;
}

/**
 * The step of the text editor of `annotation` when the user leaves it with
 * `value` typed.
 *
 * An update the store does not take at once keeps the editor open: after a
 * confirm it is open and focused, after a blur it takes the focus back, so
 * the user reads the notice and changes the text or presses Escape.
 *
 * The editor takes the focus back once for a typed text. It closes, and the
 * typed text is given up, when the focus leaves it again with the text as
 * it was, when the focus went to a control that takes input, when the focus
 * left the window, and when the editor is not on screen. The update is sent
 * with each of these steps, so one notice names the text and why it was not
 * taken; an update the store already holds for the read of the face files is
 * not sent again.
 */
export function textEditorStep(annotation: PageAnnotation, value: string, page: number, leave: EditorLeave): EditorStep {
  const outcome = textEditorOutcome(annotation, value, page, leave.facesKnown);
  if (outcome === 'remove') return { send: 'remove', editor: 'close', drop: false };
  if (outcome === 'keep') return { send: null, editor: 'close', drop: false };
  if (outcome === 'update') return { send: 'update', editor: 'close', drop: false };
  if (leave.by === 'confirm') return { send: 'update', editor: 'open', drop: false };
  const again = leave.refocusedFor !== null && leave.refocusedFor === value.trim();
  if (leave.windowFocused && leave.editorShown && !leave.toControl && !again) {
    return { send: 'update', editor: 'refocus', drop: false };
  }
  // Not refused: the store holds the update, and applies it to the
  // annotation when the face files are read.
  const refused = textBoxEditRefusal({ ...annotation, note: value.trim() }, page) !== null;
  return { send: again && !refused ? null : 'update', editor: 'close', drop: refused && !annotation.note };
}

/** The annotation a text editor is open on: its id and its text when the
 *  editor opened. `seen` is false until the annotation is in the model. */
export interface EditorTarget {
  id: string;
  note: string;
  seen: boolean;
}

/**
 * The editor target for the annotations a page holds now, or null when the
 * editor is closed. The target is the same object while nothing changes.
 *
 * An editor closes when its annotation leaves the page or its text changes
 * under it: an undo, a redo or a held update that the store applies. A
 * closed editor never opens again by itself: after an undo and a redo the
 * annotation is back and no target names it.
 */
export function editorTargetAfter(
  target: EditorTarget | null, annotations: readonly Pick<PageAnnotation, 'id' | 'note'>[],
): EditorTarget | null {
  if (!target) return null;
  const found = annotations.find((annotation) => annotation.id === target.id);
  if (!found) return target.seen ? null : target;
  if ((found.note ?? '') !== target.note) return null;
  return target.seen ? target : { ...target, seen: true };
}
