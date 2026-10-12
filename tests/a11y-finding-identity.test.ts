import { describe, expect, it } from 'vitest';
import { findingKey, liveFindingFor, prunedFindings } from '../src/renderer/lib/a11y-findings';
import type { A11yFinding } from '../src/renderer/lib/a11y-findings';

function placed(key: string, pageId: string, page: number, path = 'a.pdf'): A11yFinding {
  return {
    id: `id-${path}-${pageId}-${key}`,
    key,
    path,
    pageId,
    page,
    checkId: 'hairlines_absent',
    detailKey: 'hairline',
    rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
    rotationAtDraw: 0,
    preview: '',
  };
}

describe('a report row resolves to its live finding by identity', () => {
  // Rows: 0 on page 1, 1 has no place (never published), 2 on page 2.
  const published = [
    placed(findingKey('hairlines_absent', 0), 'p1', 1),
    placed(findingKey('hairlines_absent', 2), 'p2', 2),
  ];

  it('names each placed row by its own key', () => {
    expect(liveFindingFor(published, 'a.pdf', findingKey('hairlines_absent', 0))?.pageId).toBe('p1');
    expect(liveFindingFor(published, 'a.pdf', findingKey('hairlines_absent', 2))?.pageId).toBe('p2');
  });

  it('a row with no place resolves to nothing, not to the next placed finding', () => {
    expect(liveFindingFor(published, 'a.pdf', findingKey('hairlines_absent', 1))).toBeUndefined();
  });

  it('a row whose page was deleted resolves to nothing once the set is pruned', () => {
    const live = prunedFindings(published, new Set(['p2']));
    expect(liveFindingFor(live, 'a.pdf', findingKey('hairlines_absent', 0))).toBeUndefined();
    expect(liveFindingFor(live, 'a.pdf', findingKey('hairlines_absent', 2))?.pageId).toBe('p2');
  });

  it('the same key on two documents resolves to each document its own finding', () => {
    const key = findingKey('hairlines_absent', 0);
    const live = [placed(key, 'a#p1', 1, 'a.pdf'), placed(key, 'b#p1', 1, 'b.pdf')];
    expect(liveFindingFor(live, 'a.pdf', key)?.pageId).toBe('a#p1');
    expect(liveFindingFor(live, 'b.pdf', key)?.pageId).toBe('b#p1');
    expect(liveFindingFor(prunedFindings(live, new Set(['b#p1'])), 'a.pdf', key)).toBeUndefined();
  });

  it('two findings with the same rule and rectangle on one page resolve to their own rows', () => {
    const twins = [
      placed(findingKey('hairlines_absent', 3), 'p1', 1),
      placed(findingKey('hairlines_absent', 4), 'p1', 1),
    ];
    expect(liveFindingFor(twins, 'a.pdf', findingKey('hairlines_absent', 3))?.id).toBe(twins[0].id);
    expect(liveFindingFor(twins, 'a.pdf', findingKey('hairlines_absent', 4))?.id).toBe(twins[1].id);
  });

  it('another document and another check never match', () => {
    expect(liveFindingFor(published, 'b.pdf', findingKey('hairlines_absent', 0))).toBeUndefined();
    expect(liveFindingFor(published, 'a.pdf', findingKey('fonts_embedded', 0))).toBeUndefined();
  });
});
