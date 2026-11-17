import { describe, it, expect } from 'vitest';
import {
  guideOutline,
  headingSlug,
  inlineText,
  parseGuide,
  parseInline,
} from '../src/renderer/lib/guide-markdown';

describe('guide markdown reader', () => {
  it('makes GitHub-style heading slugs', () => {
    expect(headingSlug('Print: two-sided jobs')).toBe('print-two-sided-jobs');
    expect(headingSlug('The `Open` command')).toBe('the-open-command');
  });

  it('reads headings, paragraphs and repeated headings', () => {
    const blocks = parseGuide('# Title\n\nFirst line\nsecond line\n\n## Same\n\n## Same\n');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, id: 'title' });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
    expect(inlineText((blocks[1] as { inline: never }).inline)).toBe('First line second line');
    expect(blocks[2]).toMatchObject({ id: 'same' });
    expect(blocks[3]).toMatchObject({ id: 'same-1' });
  });

  it('reads numbered and bulleted lists, with wrapped items', () => {
    const blocks = parseGuide('1. Open the file.\n2. Press **Save**\n   to keep it.\n\n- one\n- two\n');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(inlineText((blocks[0] as { items: never[][] }).items[1])).toBe('Press Save to keep it.');
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('reads tables with escaped bars', () => {
    const blocks = parseGuide('| Key | Action |\n| --- | --- |\n| Ctrl+O | Open \\| load |\n');
    expect(blocks[0].kind).toBe('table');
    const table = blocks[0] as { head: never[][]; rows: never[][][] };
    expect(inlineText(table.head[1])).toBe('Action');
    expect(inlineText(table.rows[0][1])).toBe('Open | load');
  });

  it('reads code fences without reading inside them', () => {
    const blocks = parseGuide('```\n# not a heading\n**not bold**\n```\n');
    expect(blocks).toEqual([{ kind: 'code', text: '# not a heading\n**not bold**' }]);
  });

  it('keeps in-guide links and drops every other address', () => {
    const inline = parseInline('See [Print](#print) or [a site](https://example.com/x).');
    expect(inline.some((n) => n.kind === 'jump' && n.target === 'print')).toBe(true);
    expect(JSON.stringify(inline)).not.toContain('example.com');
    expect(inlineText(inline)).toBe('See Print or a site.');
  });

  it('never produces markup: angle brackets stay text', () => {
    const inline = parseInline('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(inline.every((n) => n.kind === 'text')).toBe(true);
    expect(inlineText(inline)).toBe('<img src=x onerror=alert(1)> and <b>bold</b>');
  });

  it('handles an unmatched marker as text', () => {
    expect(inlineText(parseInline('2 * 3 and `open'))).toBe('2 * 3 and `open');
  });

  it('lists level 2 and 3 headings for the contents', () => {
    const outline = guideOutline(parseGuide('# A\n## B\n### C\n#### D\n'));
    expect(outline).toEqual([
      { id: 'b', level: 2, text: 'B' },
      { id: 'c', level: 3, text: 'C' },
    ]);
  });
});
