import { describe, expect, it } from 'vitest';
import { editStripStatus, inlineItemCount } from '../src/renderer/lib/edit-strip';

describe('inlineItemCount', () => {
  it('keeps every item inline when the row has room', () => {
    expect(inlineItemCount([80, 60, 70], 500, 3)).toBe(3);
  });

  it('counts the gaps between items, not before the first', () => {
    expect(inlineItemCount([50, 50], 103, 3)).toBe(2);
    expect(inlineItemCount([50, 50], 102, 3)).toBe(1);
  });

  it('moves the tail out once an item does not fit, even if a later one would', () => {
    expect(inlineItemCount([50, 200, 10], 100, 3)).toBe(1);
  });

  it('keeps nothing inline when the row has no room', () => {
    expect(inlineItemCount([40], 0, 3)).toBe(0);
    expect(inlineItemCount([40], -20, 3)).toBe(0);
    expect(inlineItemCount([], 100, 3)).toBe(0);
  });
});

describe('editStripStatus', () => {
  const base = {
    busy: false,
    notice: null,
    hasSelection: false,
    selectionKind: null,
    textEditable: false,
    textReason: null,
  } as const;

  it('shows the hint with nothing selected', () => {
    expect(editStripStatus(base)?.kind).toBe('hint');
  });

  it('puts the in-flight state ahead of everything', () => {
    expect(
      editStripStatus({ ...base, busy: true, notice: { text: 'x', error: true } })?.kind,
    ).toBe('busy');
  });

  it('shows a notice for every selection kind, vectors included', () => {
    for (const selectionKind of ['image', 'text', 'para', 'vector'] as const) {
      expect(
        editStripStatus({
          ...base,
          hasSelection: true,
          selectionKind,
          notice: { text: 'Refused', error: true },
        }),
      ).toEqual({ kind: 'notice', text: 'Refused', error: true });
    }
  });

  it('shows why a selected run cannot be edited', () => {
    expect(
      editStripStatus({ ...base, hasSelection: true, selectionKind: 'text', textReason: 'Locked font' }),
    ).toEqual({ kind: 'reason', text: 'Locked font', error: true });
  });

  it('is empty for a selection with nothing to report', () => {
    expect(editStripStatus({ ...base, hasSelection: true, selectionKind: 'vector' })).toBeNull();
    expect(
      editStripStatus({ ...base, hasSelection: true, selectionKind: 'text', textEditable: true }),
    ).toBeNull();
  });
});
