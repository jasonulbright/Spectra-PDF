// The review model for detected field candidates: selection, editing, the
// accept payload, and the stale-page prune. Pure over data — the geometry
// conversion belongs to the canvas and is deliberately not exercised here.
import { describe, expect, it } from 'vitest';
import {
  buildFieldSpecs,
  candidateKind,
  candidatesFromDetection,
  checkedCandidates,
  moveCandidate,
  pageSelectionState,
  prunedCandidates,
  removeCandidate,
  renameCandidate,
  retypeCandidate,
  sanitizeFieldName,
  selectionState,
  setCheckedAll,
  setCheckedOnPage,
  setCandidateLock,
  setCandidateMultiline,
  toggleCandidate,
  type DetectedCandidate,
  type DetectionResult,
  type FieldCandidate,
} from '../src/renderer/lib/form-candidates';

function detected(over: Partial<DetectedCandidate> = {}): DetectedCandidate {
  return {
    page: 1,
    index: 0,
    kind: 'text',
    rect: [10, 10, 110, 30],
    label: 'First name:',
    label_source: 'left',
    label_gap: 12,
    name: 'First_name',
    evidence: 'rule',
    nested: false,
    group: null,
    export: null,
    multiline: false,
    comb: null,
    max_len: null,
    format: null,
    warnings: [],
    ...over,
  };
}

function result(rows: DetectedCandidate[]): DetectionResult {
  return {
    candidates: rows,
    pages_analyzed: [...new Set(rows.map((r) => r.page))],
    pages_by_source: { '1': 'vector' },
    unoffered: [],
    existing_fields: 0,
    truncated: false,
  };
}

const BOX = { x: 0.1, y: 0.1, w: 0.4, h: 0.05 };

function bind(rows: DetectedCandidate[], pageIds: Record<number, string> = { 1: 'p1' }) {
  let n = 0;
  return candidatesFromDetection(
    result(rows),
    'C:/doc.pdf',
    (row) =>
      pageIds[row.page]
        ? { pageId: pageIds[row.page], rect: BOX, rotationAtDraw: 0 as const }
        : null,
    () => `c${++n}`,
  );
}

describe('candidatesFromDetection', () => {
  it('binds each row to its page and starts every candidate unchecked', () => {
    const { candidates, skipped } = bind([detected(), detected({ name: 'Last_name', index: 1 })]);
    expect(skipped).toBe(0);
    expect(candidates.map((c) => c.name)).toEqual(['First_name', 'Last_name']);
    expect(candidates.every((c) => !c.checked)).toBe(true);
    expect(candidates.every((c) => c.pageId === 'p1')).toBe(true);
  });

  it('counts a row whose page the caller cannot resolve rather than guessing', () => {
    const { candidates, skipped } = bind([detected(), detected({ page: 4, index: 1 })]);
    expect(candidates).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('falls back to a text field for a kind it does not know', () => {
    expect(candidateKind('barcode')).toBe('text');
    expect(candidateKind('radio')).toBe('radio');
  });
});

describe('selection', () => {
  const base = bind([
    detected(),
    detected({ name: 'Last_name', index: 1 }),
    detected({ name: 'Notes', index: 2, page: 2 }),
  ], { 1: 'p1', 2: 'p2' }).candidates;

  it('reports tri-state for the whole list and per page', () => {
    expect(selectionState(base)).toBe('none');
    const one = toggleCandidate(base, base[0].id);
    expect(selectionState(one)).toBe('some');
    expect(pageSelectionState(one, 1)).toBe('some');
    expect(pageSelectionState(one, 2)).toBe('none');
    expect(selectionState(setCheckedAll(base, true))).toBe('all');
  });

  it('checks a page without touching the others', () => {
    const next = setCheckedOnPage(base, 2, true);
    expect(pageSelectionState(next, 2)).toBe('all');
    expect(pageSelectionState(next, 1)).toBe('none');
    expect(checkedCandidates(next).map((c) => c.name)).toEqual(['Notes']);
  });

  it('reports none for an empty list', () => {
    expect(selectionState([])).toBe('none');
  });
});

describe('editing', () => {
  it('renames every member of a radio group together', () => {
    const { candidates } = bind([
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Email', index: 0 }),
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Phone', index: 1 }),
      detected({ name: 'Notes', index: 2 }),
    ]);
    const next = renameCandidate(candidates, candidates[0].id, 'How_to_reach_you');
    expect(next.filter((c) => c.kind === 'radio').map((c) => c.name)).toEqual([
      'How_to_reach_you',
      'How_to_reach_you',
    ]);
    expect(next.filter((c) => c.kind === 'radio').every((c) => c.group === 'How_to_reach_you')).toBe(
      true,
    );
    expect(next[2].name).toBe('Notes');
  });

  it('breaks an option out of its group when it is retyped', () => {
    const { candidates } = bind([
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Email' }),
    ]);
    const next = retypeCandidate(candidates, candidates[0].id, 'checkbox');
    expect(next[0]).toMatchObject({ kind: 'checkbox', group: null, exportValue: null, name: 'Email' });
  });

  it('moves, toggles multiline and removes', () => {
    const { candidates } = bind([detected()]);
    const moved = moveCandidate(candidates, candidates[0].id, { x: 0.2, y: 0.3, w: 0.1, h: 0.05 });
    expect(moved[0].rect).toEqual({ x: 0.2, y: 0.3, w: 0.1, h: 0.05 });
    expect(setCandidateMultiline(moved, moved[0].id, true)[0].multiline).toBe(true);
    expect(removeCandidate(moved, moved[0].id)).toHaveLength(0);
  });
});

describe('sanitizeFieldName', () => {
  it.each([
    ['First name:', 'First_name'],
    ['E-mail address:', 'E-mail_address'],
    ['Zip/Postal', 'ZipPostal'],
    ['a.b', 'ab'],
    ['   ', ''],
  ])('maps %s to %s', (label, expected) => {
    expect(sanitizeFieldName(label)).toBe(expected);
  });
});

describe('buildFieldSpecs', () => {
  const resolve = (candidate: FieldCandidate, rect: [number, number, number, number]) => ({
    candidate,
    pageIndex: candidate.page - 1,
    rect,
  });

  it('collapses a radio group into one spec with per-option rectangles', () => {
    const { candidates } = bind([
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Email', index: 0 }),
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Phone', index: 1 }),
      detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Mail', index: 2 }),
    ]);
    const specs = buildFieldSpecs(
      [
        resolve(candidates[0], [72, 320, 81, 329]),
        resolve(candidates[1], [182, 320, 191, 329]),
        resolve(candidates[2], [292, 320, 301, 329]),
      ],
      new Set(),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: 'Contact', type: 'radio', pageIndex: 0 });
    expect(specs[0].rect).toEqual([72, 320, 301, 329]);
    expect(specs[0].options).toEqual([
      { label: 'Email', rect: [72, 320, 81, 329] },
      { label: 'Phone', rect: [182, 320, 191, 329] },
      { label: 'Mail', rect: [292, 320, 301, 329] },
    ]);
  });

  it('carries multiline and comb onto a text spec', () => {
    const { candidates } = bind([
      detected({ name: 'Comments', multiline: true, index: 0 }),
      detected({ name: 'Postcode', comb: 6, index: 1 }),
    ]);
    const specs = buildFieldSpecs(
      [resolve(candidates[0], [10, 10, 110, 90]), resolve(candidates[1], [10, 100, 110, 120])],
      new Set(),
    );
    expect(specs[0]).toMatchObject({ multiline: true });
    expect(specs[0].comb).toBeUndefined();
    expect(specs[1]).toMatchObject({ comb: true, maxLength: 6 });
  });

  it('makes names unique against the document and within the batch', () => {
    const { candidates } = bind([
      detected({ name: 'First_name', index: 0 }),
      detected({ name: 'First_name', index: 1 }),
    ]);
    const specs = buildFieldSpecs(
      [resolve(candidates[0], [10, 10, 110, 30]), resolve(candidates[1], [10, 40, 110, 60])],
      new Set(['First_name']),
    );
    expect(specs.map((s) => s.name)).toEqual(['First_name_2', 'First_name_3']);
  });

  it('keeps a radio group on one page when its options straddle a split', () => {
    const { candidates } = bind(
      [
        detected({ kind: 'radio', name: 'Contact', group: 'Contact', export: 'Email', index: 0 }),
        detected({
          kind: 'radio',
          name: 'Contact',
          group: 'Contact',
          export: 'Phone',
          index: 1,
          page: 2,
        }),
      ],
      { 1: 'p1', 2: 'p2' },
    );
    const specs = buildFieldSpecs(
      [resolve(candidates[0], [72, 320, 81, 329]), resolve(candidates[1], [72, 320, 81, 329])],
      new Set(),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].pageIndex).toBe(0);
    expect(specs[0].options).toHaveLength(1);
  });

  it('names an option with no export value rather than leaving it blank', () => {
    const { candidates } = bind([
      detected({ kind: 'radio', name: 'Pick', group: 'Pick', export: null, label: null }),
    ]);
    const specs = buildFieldSpecs([resolve(candidates[0], [10, 10, 20, 20])], new Set());
    expect(specs[0].options).toEqual([{ label: 'Option 1', rect: [10, 10, 20, 20] }]);
  });

  it('carries a signature candidate lock into its spec', () => {
    const { candidates } = bind([
      detected({ name: 'Applicant', index: 0 }),
      detected({ kind: 'signature', name: 'Signature1', index: 1 }),
    ]);
    const withLock = setCandidateLock(candidates, candidates[1].id, {
      action: 'include',
      fields: ['Applicant'],
    });
    const specs = buildFieldSpecs(
      [
        resolve(withLock[0], [10, 10, 110, 30]),
        resolve(withLock[1], [10, 50, 110, 90]),
      ],
      new Set(),
    );
    expect(specs[0].lock).toBeUndefined();
    expect(specs[1].lock).toEqual({ action: 'include', fields: ['Applicant'] });
  });

  it('rewrites a lock target the batch itself renamed', () => {
    // The document already carries "Applicant", so the candidate of that name
    // is written as Applicant_2 — a lock naming the original would otherwise
    // name the document's field rather than the one just created.
    const { candidates } = bind([
      detected({ name: 'Applicant', index: 0 }),
      detected({ kind: 'signature', name: 'Signature1', index: 1 }),
    ]);
    const withLock = setCandidateLock(candidates, candidates[1].id, {
      action: 'include',
      fields: ['Applicant'],
    });
    const specs = buildFieldSpecs(
      [
        resolve(withLock[0], [10, 10, 110, 30]),
        resolve(withLock[1], [10, 50, 110, 90]),
      ],
      new Set(['Applicant']),
    );
    expect(specs[0].name).toBe('Applicant_2');
    expect(specs[1].lock).toEqual({ action: 'include', fields: ['Applicant_2'] });
  });

  it('drops a lock when the candidate stops being a signature field', () => {
    const { candidates } = bind([detected({ kind: 'signature', name: 'Signature1' })]);
    const withLock = setCandidateLock(candidates, candidates[0].id, {
      action: 'all',
      fields: [],
    });
    expect(retypeCandidate(withLock, candidates[0].id, 'text')[0].lock).toBe(null);
    expect(retypeCandidate(withLock, candidates[0].id, 'signature')[0].lock).toEqual({
      action: 'all',
      fields: [],
    });
  });
});

describe('prunedCandidates', () => {
  it('drops a candidate whose page is gone', () => {
    const { candidates } = bind(
      [detected({ index: 0 }), detected({ index: 1, page: 2, name: 'Notes' })],
      { 1: 'p1', 2: 'p2' },
    );
    expect(prunedCandidates(candidates, new Set(['p1'])).map((c) => c.name)).toEqual([
      'First_name',
    ]);
  });
});
