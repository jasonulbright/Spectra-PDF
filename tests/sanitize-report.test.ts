import { describe, it, expect } from 'vitest';
import {
  CATEGORY_IDS,
  COSTLY_CATEGORIES,
  allRemovable,
  blockedReason,
  buildRequest,
  categoryOf,
  compare,
  countOf,
  emptySelection,
  isSelectable,
  isStale,
  removableTextCount,
  residues,
  selectedCategories,
  textKindCount,
  toggle,
  type AuditCategory,
  type AuditReport,
} from '../src/renderer/lib/sanitize-report';

function category(id: string, over: Partial<AuditCategory> = {}): AuditCategory {
  return { id, count: 0, removable: id !== 'signatures', detail: [], ...over };
}

function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    file: 'C:/work/doc.pdf',
    categories: CATEGORY_IDS.map((id) => category(id)),
    signatures: { count: 0, document_timestamps: 0, certification: null },
    pages_analyzed: 1,
    pages: 1,
    unreadable: [],
    ...over,
  };
}

function withCounts(counts: Record<string, number>, over: Partial<AuditReport> = {}): AuditReport {
  return report({
    categories: CATEGORY_IDS.map((id) => category(id, { count: counts[id] ?? 0 })),
    ...over,
  });
}

describe('the report model', () => {
  it('lists the same fourteen categories the engine reports', () => {
    expect(CATEGORY_IDS).toHaveLength(14);
    expect(CATEGORY_IDS[0]).toBe('metadata');
    expect(CATEGORY_IDS[CATEGORY_IDS.length - 1]).toBe('signatures');
  });

  it('reads a category and its count', () => {
    const r = withCounts({ comments: 3 });
    expect(countOf(r, 'comments')).toBe(3);
    expect(countOf(r, 'nothing_here')).toBe(0);
    expect(categoryOf(r, 'comments')?.count).toBe(3);
  });
});

describe('selection', () => {
  it('starts empty — nothing is checked by default', () => {
    expect(emptySelection().size).toBe(0);
  });

  it('toggles one id without touching the rest', () => {
    let selection = emptySelection();
    selection = toggle(selection, 'comments');
    selection = toggle(selection, 'metadata');
    expect([...selection].sort()).toEqual(['comments', 'metadata']);
    selection = toggle(selection, 'comments');
    expect([...selection]).toEqual(['metadata']);
  });

  it('offers no checkbox for a category with no remover', () => {
    expect(isSelectable(category('signatures', { removable: false }))).toBe(false);
    expect(isSelectable(category('metadata'))).toBe(true);
  });

  it('offers no checkbox for a category the audit could not read', () => {
    expect(isSelectable(category('hidden_text', { unreadable: true }))).toBe(false);
  });

  it('drops an unselectable id from what the engine is asked to remove', () => {
    const r = report({
      categories: [
        category('metadata', { count: 2 }),
        category('hidden_text', { count: 4, unreadable: true }),
        category('signatures', { count: 1, removable: false }),
      ],
    });
    const selection = new Set(['metadata', 'hidden_text', 'signatures']);
    expect(selectedCategories(r, selection)).toEqual(['metadata']);
  });

  it('returns the selection in report order, not click order', () => {
    const r = withCounts({ metadata: 1, comments: 1, thumbnails: 1 });
    const selection = new Set(['thumbnails', 'metadata', 'comments']);
    expect(selectedCategories(r, selection)).toEqual(['metadata', 'comments', 'thumbnails']);
  });
});

describe('the costly categories', () => {
  it('names exactly the two that take something a reader may want', () => {
    expect([...COSTLY_CATEGORIES]).toEqual(['form_fields', 'attached_structure']);
  });

  it('leaves them out of the everything-that-costs-nothing shortcut', () => {
    const r = withCounts({
      metadata: 5,
      comments: 3,
      form_fields: 1,
      attached_structure: 2,
      signatures: 1,
    });
    const chosen = allRemovable(r);
    expect(chosen.has('metadata')).toBe(true);
    expect(chosen.has('comments')).toBe(true);
    expect(chosen.has('form_fields')).toBe(false);
    expect(chosen.has('attached_structure')).toBe(false);
    expect(chosen.has('signatures')).toBe(false);
  });

  it('leaves out a category that has nothing in it', () => {
    const r = withCounts({ metadata: 5, bookmarks: 0 });
    expect(allRemovable(r).has('bookmarks')).toBe(false);
  });
});

describe('the hidden-text sub-classes', () => {
  const r = report({
    categories: CATEGORY_IDS.map((id) =>
      id === 'hidden_text'
        ? category(id, {
            count: 9,
            by_kind: {
              invisible: 2,
              ocr_layer: 3,
              covered: 1,
              background_fill: 1,
              partially_covered: 2,
            },
          })
        : category(id),
    ),
  });

  it('counts one kind', () => {
    expect(textKindCount(r, 'ocr_layer')).toBe(3);
    expect(textKindCount(r, 'partially_covered')).toBe(2);
  });

  it('never counts partial coverage as removable', () => {
    expect(removableTextCount(r, false)).toBe(4);
  });

  it('counts the recognition layer only when it is asked for', () => {
    expect(removableTextCount(r, true)).toBe(7);
  });
});

describe('the before-and-after comparison', () => {
  it('pairs every category and marks what was chosen', () => {
    const before = withCounts({ metadata: 5, comments: 3, bookmarks: 1 });
    const after = withCounts({ metadata: 0, comments: 0, bookmarks: 1 });
    const rows = compare(before, after, ['metadata', 'comments']);
    expect(rows).toHaveLength(14);
    const meta = rows.find((r) => r.id === 'metadata')!;
    expect(meta).toMatchObject({ before: 5, after: 0, selected: true, residue: false });
    const marks = rows.find((r) => r.id === 'bookmarks')!;
    expect(marks).toMatchObject({ before: 1, after: 1, selected: false, residue: false });
  });

  it('calls a chosen category that still reports something a residue', () => {
    const before = withCounts({ embedded_files: 2 });
    const after = withCounts({ embedded_files: 1 });
    const rows = compare(before, after, ['embedded_files']);
    expect(residues(rows).map((r) => r.id)).toEqual(['embedded_files']);
    expect(residues(rows)[0].after).toBe(1);
  });

  it('does not call an unchosen category a residue', () => {
    const before = withCounts({ comments: 3 });
    const after = withCounts({ comments: 3 });
    expect(residues(compare(before, after, ['metadata']))).toEqual([]);
  });
});

describe('a report that has stopped describing the file', () => {
  it('is stale once the buffer changes', () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const held = { report: report(), buffer: a };
    expect(isStale(held, a)).toBe(false);
    expect(isStale(held, b)).toBe(true);
    expect(isStale(null, b)).toBe(false);
  });
});

describe('the refusal the surface shows first', () => {
  it('names the category and the page the audit could not read', () => {
    const r = report({
      unreadable: [{ category: 'hidden_text', page: 4, reason: 'the stream did not parse' }],
    });
    expect(blockedReason(r)).toMatchObject({ category: 'hidden_text', page: 4 });
  });

  it('is absent when the whole document was read', () => {
    expect(blockedReason(report())).toBeNull();
  });
});

describe('the request handed to the apply', () => {
  it('carries the selection, the field mode and the recognition opt-in', () => {
    const r = withCounts({ metadata: 5, form_fields: 1 });
    const request = buildRequest(r, new Set(['metadata', 'form_fields']), 'flatten', true);
    expect(request.categories).toEqual(['metadata', 'form_fields']);
    expect(request.formFieldsMode).toBe('flatten');
    expect(request.includeOcrLayer).toBe(true);
  });

  it('names how many signatures the pass destroys, from the report itself', () => {
    const r = report({
      categories: CATEGORY_IDS.map((id) =>
        id === 'prior_revisions'
          ? category(id, {
              count: 1,
              detail: [{ revisions: 2, recoverable_bytes: 5260, destroys_signatures: 2 }],
            })
          : category(id),
      ),
      signatures: { count: 2, document_timestamps: 0, certification: 'none' },
    });
    const request = buildRequest(r, new Set(['prior_revisions']), 'remove', false);
    expect(request.destroysSignatures).toBe(2);
    expect(request.signatures.certification).toBe('none');
  });

  it('falls back to the signature count when there is no earlier revision', () => {
    const r = report({
      signatures: { count: 1, document_timestamps: 0, certification: null },
    });
    expect(buildRequest(r, new Set(['metadata']), 'remove', false).destroysSignatures).toBe(1);
  });
});
