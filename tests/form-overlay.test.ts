// Pure on-canvas form-overlay helpers (2n.4b): widget projection into
// display-normalized space and name-keyed pending-value pruning.
import { describe, expect, it } from 'vitest';
import {
  projectFieldWidgets,
  pruneFormValues,
  valueShapeMatches,
} from '../src/renderer/lib/form-overlay';
import type { FormField, FormFieldValue } from '../src/renderer/lib/forms';

const BOX = { x: 0, y: 0, width: 600, height: 800 };

function textField(over: Partial<FormField> = {}): FormField {
  return {
    name: 'f',
    type: 'text',
    value: '',
    readOnly: false,
    required: false,
    editable: true,
    widgets: [],
    ...over,
  };
}

describe('projectFieldWidgets', () => {
  it('projects each widget rect into display-normalized space per page', () => {
    const field = textField({
      widgets: [
        { pageIndex: 0, rect: [50, 700, 250, 720], hidden: false },
        { pageIndex: 2, rect: [0, 0, 300, 400], hidden: false },
      ],
    });
    const byPage = projectFieldWidgets('a.pdf', field, () => ({ box: BOX, bakedRotate: 0 }));
    const p0 = byPage.get(0)![0];
    expect(p0.rect.x).toBeCloseTo(50 / 600);
    expect(p0.rect.y).toBeCloseTo((800 - 720) / 800); // PDF y-up -> display y-down
    expect(p0.rect.w).toBeCloseTo(200 / 600);
    expect(p0.rect.h).toBeCloseTo(20 / 800);
    const p2 = byPage.get(2)![0];
    expect(p2.rect).toMatchObject({ x: 0, w: 0.5, h: 0.5 });
    expect(p2.rect.y).toBeCloseTo(0.5);
    expect(p0.path).toBe('a.pdf');
    expect(p0.fieldName).toBe('f');
  });

  it('projects at the baked rotation (90° swaps the axes)', () => {
    const field = textField({ widgets: [{ pageIndex: 0, rect: [0, 0, 600, 100], hidden: false }] });
    const byPage = projectFieldWidgets('a.pdf', field, () => ({ box: BOX, bakedRotate: 90 }));
    const r = byPage.get(0)![0].rect;
    // A full-width strip at the bottom of an upright page becomes a
    // full-height strip on one side when shown rotated 90°.
    expect(r.w).toBeCloseTo(100 / 800);
    expect(r.h).toBeCloseTo(600 / 600);
  });

  it('skips hidden and degenerate widgets, missing geometry, and buttons', () => {
    const field = textField({
      widgets: [
        { pageIndex: 0, rect: [10, 10, 60, 30], hidden: true },
        { pageIndex: 0, rect: [10, 10, 10, 30], hidden: false }, // zero width
        { pageIndex: 5, rect: [10, 10, 60, 30], hidden: false }, // no geometry
      ],
    });
    const byPage = projectFieldWidgets('a.pdf', field, (i) =>
      i === 5 ? null : { box: BOX, bakedRotate: 0 },
    );
    expect(byPage.size).toBe(0);

    const button = textField({
      type: 'button',
      widgets: [{ pageIndex: 0, rect: [10, 10, 60, 30], hidden: false }],
    });
    expect(projectFieldWidgets('a.pdf', button, () => ({ box: BOX, bakedRotate: 0 })).size).toBe(0);
  });

  it('carries radio option mapping and signature filled state', () => {
    const radio = textField({
      name: 'color',
      type: 'radio',
      options: ['red', 'blue'],
      widgets: [
        { pageIndex: 0, rect: [10, 10, 25, 25], hidden: false, radioOption: 'red' },
        { pageIndex: 0, rect: [40, 10, 55, 25], hidden: false, radioOption: 'blue' },
      ],
    });
    const widgets = projectFieldWidgets('a.pdf', radio, () => ({ box: BOX, bakedRotate: 0 })).get(0)!;
    expect(widgets.map((w) => w.radioOption)).toEqual(['red', 'blue']);

    const sig = textField({
      name: 's',
      type: 'signature',
      editable: false,
      filled: true,
      widgets: [{ pageIndex: 0, rect: [10, 10, 200, 60], hidden: false }],
    });
    expect(
      projectFieldWidgets('a.pdf', sig, () => ({ box: BOX, bakedRotate: 0 })).get(0)![0].sigFilled,
    ).toBe(true);
  });
});

describe('valueShapeMatches', () => {
  it('accepts only the shape each field type fills with', () => {
    expect(valueShapeMatches('text', 'x')).toBe(true);
    expect(valueShapeMatches('text', true)).toBe(false);
    expect(valueShapeMatches('checkbox', true)).toBe(true);
    expect(valueShapeMatches('checkbox', 'true')).toBe(false);
    expect(valueShapeMatches('radio', 'red')).toBe(true);
    expect(valueShapeMatches('dropdown', 'CA')).toBe(true);
    expect(valueShapeMatches('optionlist', ['a'])).toBe(true);
    expect(valueShapeMatches('optionlist', 'a')).toBe(false);
    expect(valueShapeMatches('button', 'x')).toBe(false);
    expect(valueShapeMatches('signature', 'x')).toBe(false);
  });
});

describe('pruneFormValues', () => {
  const fields = (over: Partial<FormField>[] = []): FormField[] =>
    over.map((o) => textField(o));

  function pend(entries: [string, [string, FormFieldValue][]][]) {
    return new Map(entries.map(([p, vs]) => [p, new Map(vs)]));
  }

  it('keeps valid entries and returns the same instance when nothing changed', () => {
    const pending = pend([['a.pdf', [['f', 'hello']]]]);
    const forms = new Map([['a.pdf', fields([{ name: 'f' }])]]);
    expect(pruneFormValues(pending, forms)).toBe(pending);
  });

  it('drops entries for a path with no read (closed file / import source)', () => {
    const pending = pend([
      ['a.pdf', [['f', 'x']]],
      ['gone.pdf', [['f', 'y']]],
    ]);
    const forms = new Map([['a.pdf', fields([{ name: 'f' }])]]);
    const out = pruneFormValues(pending, forms);
    expect(out.has('gone.pdf')).toBe(false);
    expect(out.get('a.pdf')!.get('f')).toBe('x');
  });

  it('drops a name that vanished, turned non-editable, or changed shape', () => {
    const pending = pend([
      ['a.pdf', [
        ['gone', 'x'],
        ['locked', 'y'],
        ['retyped', 'z'],
        ['ok', 'keep'],
      ]],
    ]);
    const forms = new Map([
      ['a.pdf', fields([
        { name: 'locked', editable: false },
        { name: 'retyped', type: 'checkbox' }, // was text when typed
        { name: 'ok' },
      ])],
    ]);
    const out = pruneFormValues(pending, forms);
    expect([...out.get('a.pdf')!.keys()]).toEqual(['ok']);
  });

  it('drops an emptied path bucket entirely', () => {
    const pending = pend([['a.pdf', [['gone', 'x']]]]);
    const forms = new Map([['a.pdf', fields([])]]);
    const out = pruneFormValues(pending, forms);
    expect(out.size).toBe(0);
  });
});
