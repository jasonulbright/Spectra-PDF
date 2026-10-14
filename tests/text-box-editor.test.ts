// The text editor of an annotation: what it does when the user leaves it,
// and which annotation it is open on. An editor is open only with the
// focus, and one that closed never opens again by itself.
import { afterEach, describe, expect, it } from 'vitest';
import { editorTargetAfter, takesInput, textEditorOutcome, textEditorStep } from '../src/renderer/lib/text-box-edit';
import type { EditorLeave, EditorTarget } from '../src/renderer/lib/text-box-edit';
import { provideBundledFaces } from '../src/renderer/lib/text-box-faces';
import type { PageAnnotation } from '../src/renderer/state/types';

const box = (note: string): PageAnnotation => ({ id: 'a', kind: 'freetext', x: 0.1, y: 0.1, w: 0.4, h: 0.1, color: '#000000', note });
const REFUSED = 'ภาษาไทย';
const CJK = '中文';
const leave = (over: Partial<EditorLeave> = {}): EditorLeave =>
  ({ by: 'blur', windowFocused: true, editorShown: true, facesKnown: true, toControl: false, refocusedFor: null, ...over });

afterEach(() => provideBundledFaces(undefined));

describe('the step of the text editor when the user leaves it', () => {
  it('closes on a text the store takes, on an unchanged text and on an empty one', () => {
    for (const by of ['confirm', 'blur'] as const) {
      expect(textEditorStep(box('old'), ' new ', 1, leave({ by }))).toEqual({ send: 'update', editor: 'close', drop: false });
      expect(textEditorStep(box('old'), 'old ', 1, leave({ by }))).toEqual({ send: null, editor: 'close', drop: false });
      expect(textEditorStep(box('old'), '  ', 1, leave({ by }))).toEqual({ send: 'remove', editor: 'close', drop: false });
      expect(textEditorStep(box(''), CJK, 1, leave({ by }))).toEqual({ send: 'update', editor: 'close', drop: false });
    }
  });

  it('stays open and focused when a confirmed text is refused, wherever the focus is', () => {
    for (const over of [{}, { windowFocused: false }, { editorShown: false }]) {
      expect(textEditorStep(box('old'), REFUSED, 2, leave({ by: 'confirm', ...over }))).toEqual({ send: 'update', editor: 'open', drop: false });
    }
  });

  it('takes the focus back when a blur leaves a refused text, and sends the update for the notice', () => {
    expect(textEditorStep(box('old'), REFUSED, 2, leave())).toEqual({ send: 'update', editor: 'refocus', drop: false });
    expect(textEditorStep(box(''), REFUSED, 2, leave())).toEqual({ send: 'update', editor: 'refocus', drop: false });
  });

  it('closes when the focus left the window or the editor is not on screen: the typed text is given up with the notice', () => {
    for (const over of [{ windowFocused: false }, { editorShown: false }, { windowFocused: false, editorShown: false }]) {
      expect(textEditorStep(box('old'), REFUSED, 2, leave(over))).toEqual({ send: 'update', editor: 'close', drop: false });
      // A box that never had a text leaves with its editor.
      expect(textEditorStep(box(''), REFUSED, 2, leave(over))).toEqual({ send: 'update', editor: 'close', drop: true });
    }
  });

  it('is never open without the focus', () => {
    const texts = ['old', ' new ', '', REFUSED, CJK];
    for (const before of ['old', '']) {
      for (const value of texts) {
        for (const by of ['confirm', 'blur'] as const) {
          for (const windowFocused of [true, false]) {
            for (const editorShown of [true, false]) {
              for (const facesKnown of [true, false]) {
                for (const toControl of [true, false]) {
                  for (const refocusedFor of [null, value.trim(), 'another text']) {
                    const step = textEditorStep(box(before), value, 1, { by, windowFocused, editorShown, facesKnown, toControl, refocusedFor });
                    // `open` only where the editor holds the focus (a confirm is typed in it);
                    // `refocus` only where it can take the focus, once for a typed text.
                    if (step.editor === 'open') expect(by).toBe('confirm');
                    if (step.editor === 'refocus') {
                      expect(by === 'blur' && windowFocused && editorShown && !toControl && refocusedFor !== value.trim()).toBe(true);
                    }
                    if (step.drop) expect(step.editor === 'close' && before === '').toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('keeps the editor while the store holds an update for the read of the face files', () => {
    // A text the standard font draws is never held.
    expect(textEditorOutcome(box('old'), 'plain', 1, false)).toBe('update');
    expect(textEditorOutcome(box('old'), CJK, 1, false)).toBe('refused');
    expect(textEditorOutcome(box('old'), CJK, 1, true)).toBe('update');
    expect(textEditorStep(box('old'), CJK, 1, leave({ by: 'confirm', facesKnown: false }))).toEqual({ send: 'update', editor: 'open', drop: false });
    expect(textEditorStep(box('old'), CJK, 1, leave({ facesKnown: false }))).toEqual({ send: 'update', editor: 'refocus', drop: false });
    provideBundledFaces([]);
    expect(textEditorOutcome(box('old'), CJK, 1, true)).toBe('refused');
  });
});

describe('a text editor that took the focus back for a refused text', () => {
  it('takes it back once: a second blur with the text as it was closes the editor with one more notice', () => {
    const first = textEditorStep(box('old'), ` ${REFUSED} `, 2, leave());
    expect(first).toEqual({ send: 'update', editor: 'refocus', drop: false });
    expect(textEditorStep(box('old'), ` ${REFUSED} `, 2, leave({ refocusedFor: REFUSED }))).toEqual({ send: 'update', editor: 'close', drop: false });
    // A box that never had a text leaves with its editor.
    expect(textEditorStep(box(''), REFUSED, 2, leave({ refocusedFor: REFUSED }))).toEqual({ send: 'update', editor: 'close', drop: true });
  });

  it('takes it back again for another refused text', () => {
    expect(textEditorStep(box('old'), `${REFUSED}!`, 2, leave({ refocusedFor: REFUSED }))).toEqual({ send: 'update', editor: 'refocus', drop: false });
  });

  it('closes at once when the focus went to a control that takes input', () => {
    expect(textEditorStep(box('old'), REFUSED, 2, leave({ toControl: true }))).toEqual({ send: 'update', editor: 'close', drop: false });
    expect(textEditorStep(box(''), REFUSED, 2, leave({ toControl: true }))).toEqual({ send: 'update', editor: 'close', drop: true });
    // A text the store takes closes as ever.
    expect(textEditorStep(box('old'), 'new', 2, leave({ toControl: true }))).toEqual({ send: 'update', editor: 'close', drop: false });
  });

  it('sends an update the store holds once, and keeps the box the update is for', () => {
    // The face files are not read: the store holds the update of the first blur.
    expect(textEditorStep(box(''), CJK, 1, leave({ facesKnown: false }))).toEqual({ send: 'update', editor: 'refocus', drop: false });
    expect(textEditorStep(box(''), CJK, 1, leave({ facesKnown: false, refocusedFor: CJK }))).toEqual({ send: null, editor: 'close', drop: false });
    expect(textEditorStep(box(''), CJK, 1, leave({ facesKnown: false, toControl: true }))).toEqual({ send: 'update', editor: 'close', drop: false });
    expect(textEditorStep(box(''), CJK, 1, leave({ facesKnown: false, windowFocused: false }))).toEqual({ send: 'update', editor: 'close', drop: false });
  });

  it('tells a control that takes input from one that does not', () => {
    expect(takesInput({ tagName: 'INPUT' })).toBe(true);
    expect(takesInput({ tagName: 'input', type: 'number' })).toBe(true);
    expect(takesInput({ tagName: 'TEXTAREA' })).toBe(true);
    expect(takesInput({ tagName: 'SELECT' })).toBe(true);
    expect(takesInput({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    for (const type of ['button', 'submit', 'reset', 'image', 'hidden']) expect(takesInput({ tagName: 'INPUT', type })).toBe(false);
    expect(takesInput({ tagName: 'INPUT', disabled: true })).toBe(false);
    expect(takesInput({ tagName: 'TEXTAREA', readOnly: true })).toBe(false);
    expect(takesInput({ tagName: 'BUTTON' })).toBe(false);
    expect(takesInput({ tagName: 'DIV' })).toBe(false);
    expect(takesInput(null)).toBe(false);
  });
});

describe('the annotation a text editor is open on', () => {
  const target = (over: Partial<EditorTarget> = {}): EditorTarget => ({ id: 'a', note: '', seen: false, ...over });

  it('waits for a new annotation to reach the model, then holds it', () => {
    const waiting = target();
    expect(editorTargetAfter(waiting, [])).toBe(waiting);
    const held = editorTargetAfter(waiting, [{ id: 'a', note: '' }]);
    expect(held).toEqual({ id: 'a', note: '', seen: true });
    expect(editorTargetAfter(held, [{ id: 'b', note: 'x' }, { id: 'a', note: '' }])).toBe(held);
    expect(editorTargetAfter(null, [{ id: 'a', note: '' }])).toBeNull();
  });

  it('closes when an undo takes the annotation away, and a redo does not open it again', () => {
    let editor = editorTargetAfter(target(), [{ id: 'a', note: '' }]);
    // Undo of the add.
    editor = editorTargetAfter(editor, []);
    expect(editor).toBeNull();
    // Redo: the annotation is back under its id.
    editor = editorTargetAfter(editor, [{ id: 'a', note: '' }]);
    expect(editor).toBeNull();
  });

  it('closes when the text of the annotation changes under it: an undo, a redo, or a held update the store applies', () => {
    const open = editorTargetAfter(target({ note: 'first' }), [{ id: 'a', note: 'first' }]);
    expect(open?.seen).toBe(true);
    expect(editorTargetAfter(open, [{ id: 'a', note: 'second' }])).toBeNull();
    expect(editorTargetAfter(open, [{ id: 'a' }])).toBeNull();
    // A refused update leaves the text as it was: the editor stays.
    expect(editorTargetAfter(open, [{ id: 'a', note: 'first' }])).toBe(open);
  });
});
