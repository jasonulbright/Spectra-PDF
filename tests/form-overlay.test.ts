// Pure on-canvas form-overlay helpers (2n.4b): widget projection into
// display-normalized space and name-keyed pending-value pruning.
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  placementDocsCurrent,
  projectFieldWidgets,
  pruneFormValues,
  resolveFillTargets,
  valueShapeMatches,
} from '../src/renderer/lib/form-overlay';
import { readFormFields } from './helpers/pdflib-forms';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
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

describe('resolveFillTargets (review-caught: fills must follow renamed fields)', () => {
  const field = (name: string, rect: [number, number, number, number], over: Partial<FormField> = {}): FormField =>
    textField({ name, widgets: [{ pageIndex: 0, rect, hidden: false }], ...over });

  it('fills as-is when name and fingerprint both match (the no-import case)', () => {
    const pre = [field('name', [50, 700, 250, 720])];
    const post = [field('name', [50, 700, 250, 720])];
    const r = resolveFillTargets(pre, post, { name: 'v' });
    expect(r.resolved).toEqual({ name: 'v' });
    expect(r.skipped).toEqual([]);
  });

  it("follows the field through a commit rename — never the imported document's same name", () => {
    // Pre-commit: the target's own field 'name' at rect A. Post-commit: an
    // imported field kept 'name' (different rect B) and the target's field
    // was renamed 'name+1' (still rect A). The value must land on name+1.
    const pre = [field('name', [50, 700, 250, 720])];
    const post = [
      field('name', [10, 10, 110, 40]), // the imported document's field
      field('name+1', [50, 700, 250, 720]), // the field the user typed into
    ];
    const r = resolveFillTargets(pre, post, { name: 'typed value' });
    expect(r.resolved).toEqual({ 'name+1': 'typed value' });
    expect(r.skipped).toEqual([]);
  });

  it('refuses when two physically identical same-fingerprint fields exist', () => {
    // A form imported into a copy of itself: name and name+1 with the SAME
    // rect — no honest way to pick; refuse rather than guess.
    const pre = [field('name', [50, 700, 250, 720])];
    const post = [
      field('name', [50, 700, 250, 720]),
      field('name+1', [50, 700, 250, 720]),
    ];
    const r = resolveFillTargets(pre, post, { name: 'v' });
    expect(r.resolved).toEqual({});
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('identical fields');
  });

  it('an unrelated same-shape field never captures or blocks the fill', () => {
    // The same text box repeated at the same position under different names
    // (e.g. a per-page header field) shares the fingerprint but is NOT in
    // the rename family — it must neither receive the value nor spook the
    // resolver into refusing a clean same-name fill.
    const pre = [field('name', [50, 700, 250, 720]), field('other', [50, 700, 250, 720])];
    const post = [field('name', [50, 700, 250, 720]), field('other', [50, 700, 250, 720])];
    const r = resolveFillTargets(pre, post, { name: 'v' });
    expect(r.resolved).toEqual({ name: 'v' });
    expect(r.skipped).toEqual([]);
  });

  it('refuses when the field vanished or changed shape during apply', () => {
    const pre = [field('gone', [50, 700, 250, 720])];
    const r = resolveFillTargets(pre, [], { gone: 'v' });
    expect(r.resolved).toEqual({});
    expect(r.skipped[0].reason).toContain('changed while applying');

    // Fingerprint match but no longer editable — refused, not misfiled.
    const pre2 = [field('locked', [50, 700, 250, 720])];
    const post2 = [field('locked', [50, 700, 250, 720], { editable: false, readOnly: true })];
    const r2 = resolveFillTargets(pre2, post2, { locked: 'v' });
    expect(r2.resolved).toEqual({});
    expect(r2.skipped[0].reason).toContain('no longer fillable');
  });

  it('falls back to a plain name match when there was no pre-commit read', () => {
    const post = [field('fresh', [50, 700, 250, 720])];
    const r = resolveFillTargets([], post, { fresh: 'v', ghost: 'x' });
    expect(r.resolved).toEqual({ fresh: 'v' });
    expect(r.skipped[0]).toMatchObject({ name: 'ghost' });
  });

  it('end to end: the reviewer misfile scenario resolves onto the renamed field', async () => {
    // Two real form files with a colliding 'name' at DIFFERENT rects, merged
    // through the real rebuild (the carry renames one), resolved through the
    // real reader — the exact sequence handleFillFormValues runs.
    async function makeForm(rect: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 800]);
      const f = doc.getForm().createTextField('name');
      f.addToPage(page, rect);
      return doc.save();
    }
    const target = await makeForm({ x: 50, y: 700, width: 200, height: 20 });
    const imported = await makeForm({ x: 10, y: 10, width: 100, height: 30 });
    const pre = (await readFormFields(target)).fields;
    // Import lands BEFORE the target's page, so the imported contribution
    // keeps 'name' and the target's field renames to 'name+1'.
    const merged = await buildPdf([
      { bytes: imported, sourceKey: 'import', pageIndex: 0 },
      { bytes: target, sourceKey: 'target', pageIndex: 0 },
    ]);
    const post = (await readFormFields(merged)).fields;
    const r = resolveFillTargets(pre, post, { name: 'typed value' });
    expect(r.skipped).toEqual([]);
    const [resolvedName] = Object.keys(r.resolved);
    expect(resolvedName).not.toBe('name'); // NOT the imported document's field
    const resolvedField = post.find((f) => f.name === resolvedName)!;
    expect(resolvedField.widgets[0].rect[1]).toBeCloseTo(699.5, 0); // the target's rect
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

describe('placementDocsCurrent', () => {
  // Buffer IDENTITY is the staleness signal (the workspace indexer's own
  // rule): equal contents in a different object still means a reindex is in
  // flight and the page ids are about to rotate.
  const bufA = [1, 2, 3];
  const bufB = [1, 2, 3];

  it('is current when the indexed doc carries the files buffer', () => {
    const files = new Map([['a.pdf', { buffer: bufA }]]);
    expect(placementDocsCurrent(files, [{ path: 'a.pdf', buffer: bufA }], 'a.pdf')).toBe(true);
  });

  it('is stale when the files buffer is newer than the indexed one', () => {
    const files = new Map([['a.pdf', { buffer: bufB }]]);
    expect(placementDocsCurrent(files, [{ path: 'a.pdf', buffer: bufA }], 'a.pdf')).toBe(false);
  });

  it('refuses a path with no loaded buffer or no indexed docs yet', () => {
    const files = new Map([['a.pdf', { buffer: null }]]);
    expect(placementDocsCurrent(files, [{ path: 'a.pdf', buffer: bufA }], 'a.pdf')).toBe(false);
    expect(
      placementDocsCurrent(new Map([['a.pdf', { buffer: bufA }]]), [], 'a.pdf'),
    ).toBe(false);
    expect(placementDocsCurrent(new Map(), [{ path: 'a.pdf', buffer: bufA }], 'a.pdf')).toBe(false);
  });

  it('judges only the named path (other docs do not vouch)', () => {
    const files = new Map([
      ['a.pdf', { buffer: bufA }],
      ['b.pdf', { buffer: bufB }],
    ]);
    const docs = [
      { path: 'b.pdf', buffer: bufB },
      { path: 'a.pdf', buffer: bufA },
    ];
    expect(placementDocsCurrent(files, docs, 'a.pdf')).toBe(true);
    expect(placementDocsCurrent(files, [{ path: 'b.pdf', buffer: bufB }], 'a.pdf')).toBe(false);
  });
});
