import { describe, it, expect } from 'vitest';
import { rankToolMatches } from '../src/renderer/search/omnisearch-rank';
import { TOOL_DEFS } from '../src/renderer/commands/tools';

// The tool half of the omnisearch. There is no DOM test environment (the
// component itself drags in pdf.js and dies on DOMMatrix), so the ranking —
// the part that decides what a user sees first — lives in a pure leaf module
// and is pinned here.

describe('rankToolMatches', () => {
  it('is empty for an empty query (the box must not list all tools unprompted)', () => {
    expect(rankToolMatches('', TOOL_DEFS)).toEqual([]);
    expect(rankToolMatches('   ', TOOL_DEFS)).toEqual([]);
  });

  it('ranks a name PREFIX above a name substring above a description-only match', () => {
    const defs = [
      { id: 'a' as const, title: 'Alpha', description: 'nothing' },
      { id: 'b' as const, title: 'Beta Redact', description: 'nothing' },
      { id: 'c' as const, title: 'Gamma', description: 'redact things' },
      { id: 'd' as const, title: 'Redact', description: 'nothing' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const out = rankToolMatches('redact', defs).map((t) => t.title);
    expect(out).toEqual(['Redact', 'Beta Redact', 'Gamma']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const lower = rankToolMatches('redact', TOOL_DEFS).map((t) => t.id);
    expect(rankToolMatches('  REDACT  ', TOOL_DEFS).map((t) => t.id)).toEqual(lower);
    expect(lower).toContain('redact');
  });

  it('finds a real tool by the START of its name', () => {
    // "org" is how a user reaches Organize Pages without typing the whole name.
    expect(rankToolMatches('org', TOOL_DEFS)[0]?.id).toBe('organize');
  });

  it('breaks ties alphabetically, so ordering is stable rather than catalog-order', () => {
    const defs = [
      { id: 'z' as const, title: 'Zebra', description: 'x' },
      { id: 'a' as const, title: 'Apple', description: 'x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    expect(rankToolMatches('x', defs).map((t) => t.title)).toEqual(['Apple', 'Zebra']);
  });

  it('breaks ties by the COLLATION of the language it is handed', () => {
    // Swedish sorts ö after z; English sorts it among the o-vowels. A bare
    // localeCompare would follow the host locale instead of the UI language,
    // so the same list comes out in a different order on two machines.
    const defs = [
      { id: 'o' as const, title: 'Öppna', description: 'x' },
      { id: 'z' as const, title: 'Zoom', description: 'x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    expect(rankToolMatches('x', defs, 'sv').map((t) => t.id)).toEqual(['z', 'o']);
    expect(rankToolMatches('x', defs, 'en').map((t) => t.id)).toEqual(['o', 'z']);
  });

  it('excludes tools that match nowhere', () => {
    expect(rankToolMatches('zzzzznotatool', TOOL_DEFS)).toEqual([]);
  });
});
