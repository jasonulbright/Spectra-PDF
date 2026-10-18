import { describe, expect, it } from 'vitest';
import { EDITING_ATTRIBUTE, installEditingMarker } from '../src/renderer/lib/editing-marker';

type Listener = (event: Event) => void;

class Target {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  fire(type: string, target: unknown = this): void {
    for (const l of this.listeners.get(type) ?? []) l({ target } as unknown as Event);
  }
}

class Field {
  readonly attributes = new Map<string, string>();
  constructor(readonly tagName: string, readonly type = '', readonly isContentEditable = false) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  get editing(): boolean {
    return this.attributes.has(EDITING_ATTRIBUTE);
  }
}

/** A document whose focus moves the way Blink moves it: `focusout` on the old
 * element, then `focusin` on the new one, with the active element already the
 * body during `focusout` of an in-page change. */
function setup() {
  const doc = new Target() as Target & { activeElement: unknown };
  const body = new Field('BODY');
  doc.activeElement = body;
  const win = new Target();
  const tasks: (() => void)[] = [];
  const uninstall = installEditingMarker(doc, win, (task) => tasks.push(task));
  const settle = (): void => {
    while (tasks.length) tasks.shift()!();
  };
  const focus = (el: Field): void => {
    const old = doc.activeElement;
    if (old !== body) {
      doc.activeElement = body;
      doc.fire('focusout', old);
    }
    doc.activeElement = el;
    doc.fire('focusin', el);
    settle();
  };
  const blurToBody = (): void => {
    const old = doc.activeElement;
    doc.activeElement = body;
    doc.fire('focusout', old);
    settle();
  };
  /** The window loses system focus: the field keeps the document's focus. */
  const windowBlur = (): void => {
    doc.fire('focusout', doc.activeElement);
    win.fire('blur');
    settle();
  };
  const windowFocus = (): void => {
    win.fire('focus');
    doc.fire('focusin', doc.activeElement);
    settle();
  };
  return { doc, body, focus, blurToBody, windowBlur, windowFocus, uninstall };
}

describe('the editing marker', () => {
  it('marks a text field while it holds the focus, and only that field', () => {
    const s = setup();
    const find = new Field('INPUT', 'text');
    const quality = new Field('INPUT', 'number');
    s.focus(find);
    expect(find.editing).toBe(true);
    s.focus(quality);
    expect([find.editing, quality.editing]).toEqual([false, true]);
    s.blurToBody();
    expect(quality.editing).toBe(false);
  });

  it('keeps the mark while the window is inactive, as the field keeps the focus', () => {
    const s = setup();
    const find = new Field('INPUT', 'text');
    s.focus(find);
    s.windowBlur();
    expect(find.editing).toBe(true);
    s.windowFocus();
    expect(find.editing).toBe(true);
  });

  it('drops a mark the page could not move while the window was inactive', () => {
    const s = setup();
    const find = new Field('INPUT', 'text');
    const other = new Field('BUTTON');
    s.focus(find);
    s.windowBlur();
    // An inactive page fires no focus events for a focus change.
    s.doc.activeElement = other;
    expect(find.editing).toBe(true);
    s.windowFocus();
    expect(find.editing).toBe(false);
  });

  it('marks textareas and editing hosts, never a control with no text', () => {
    const s = setup();
    const area = new Field('TEXTAREA');
    const host = new Field('DIV', '', true);
    const box = new Field('INPUT', 'checkbox');
    const select = new Field('SELECT');
    s.focus(area);
    expect(area.editing).toBe(true);
    s.focus(host);
    expect([area.editing, host.editing]).toEqual([false, true]);
    s.focus(box);
    expect([host.editing, box.editing]).toEqual([false, false]);
    s.focus(select);
    expect(select.editing).toBe(false);
  });

  it('a focusout of another element leaves the mark alone', () => {
    const s = setup();
    const find = new Field('INPUT', 'text');
    s.focus(find);
    s.doc.fire('focusout', new Field('BUTTON'));
    expect(find.editing).toBe(true);
  });

  it('uninstalling clears the mark and stops listening', () => {
    const s = setup();
    const find = new Field('INPUT', 'text');
    s.focus(find);
    s.uninstall();
    expect(find.editing).toBe(false);
    s.focus(new Field('INPUT', 'text'));
    expect(find.editing).toBe(false);
    for (const list of s.doc.listeners.values()) expect(list).toEqual([]);
  });
});
