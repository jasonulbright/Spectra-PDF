import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GuideBlock,
  type GuideInline,
  type GuideList,
  guideOutline,
  headingSlug,
  inlineText,
  parseGuide,
  parseInline,
} from '../src/renderer/lib/guide-markdown';

function pick<K extends GuideBlock['kind']>(block: GuideBlock, kind: K): Extract<GuideBlock, { kind: K }> {
  expect(block.kind).toBe(kind);
  return block as Extract<GuideBlock, { kind: K }>;
}

function text(inline: GuideInline[]): string {
  return inlineText(inline);
}

describe('guide markdown reader', () => {
  it('makes GitHub-style heading slugs', () => {
    expect(headingSlug('Print: two-sided jobs')).toBe('print-two-sided-jobs');
    expect(headingSlug('The `Open` command')).toBe('the-open-command');
  });

  it('reads headings, paragraphs and repeated headings', () => {
    const blocks = parseGuide('# Title\n\nFirst line\nsecond line\n\n## Same\n\n## Same\n');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, id: 'title' });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
    expect(text(pick(blocks[1], 'paragraph').inline)).toBe('First line second line');
    expect(blocks[2]).toMatchObject({ id: 'same' });
    expect(blocks[3]).toMatchObject({ id: 'same-1' });
  });

  it('reads numbered and bulleted lists, with wrapped items', () => {
    const blocks = parseGuide('1. Open the file.\n2. Press **Save**\n   to keep it.\n\n- one\n- two\n');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
    expect(pick(blocks[0], 'list').items).toHaveLength(2);
    expect(text(pick(blocks[0], 'list').items[1].inline)).toBe('Press Save to keep it.');
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('keeps a nested list under its item, so step numbers stay right', () => {
    const blocks = parseGuide(['1. For Password:', '   1. Type the user password.', '   2. Type the owner password.', '2. Click Encrypt.', '3. Choose the file name.', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(list.items).toHaveLength(3);
    expect(list.items[0].subs[0]?.ordered).toBe(true);
    expect(list.items[0].subs[0]?.items).toHaveLength(2);
    expect(text(list.items[1].inline)).toBe('Click Encrypt.');
  });

  it('nests a bullet list under a numbered step', () => {
    const blocks = parseGuide(['5. Select the options:', '   - Straighten', '   - Compress', '6. Start.', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].subs[0]?.ordered).toBe(false);
    expect(list.items[0].subs[0]?.items.map((i) => text(i.inline))).toEqual(['Straighten', 'Compress']);
  });

  it('keeps text that follows a sub-list after it', () => {
    const blocks = parseGuide(['1. a', '   1. b', '   2. c', '   After sub.', '2. d', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(list.items).toHaveLength(2);
    expect(text(list.items[0].inline)).toBe('a');
    expect(list.items[0].subs).toHaveLength(1);
    expect(text(list.items[0].subs[0].items[1].inline)).toBe('c After sub.');
  });

  it('starts a new sub-list when the marker kind changes under one item', () => {
    const blocks = parseGuide(['1. a', '   1. b', '   - x', '2. c', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].subs.map((s) => s.ordered)).toEqual([true, false]);
    expect(list.items[0].subs[0].items).toHaveLength(1);
    expect(text(list.items[0].subs[1].items[0].inline)).toBe('x');
  });

  it('ends a top-level list at an unindented paragraph', () => {
    const blocks = parseGuide(['1. a', 'Next paragraph.', ''].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(blocks[1].kind).toBe('paragraph');
  });

  it('wraps the sub-list item for text indented between the two lists', () => {
    const blocks = parseGuide(['1. a', '      - b', '   text', '2. c', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(text(list.items[0].inline)).toBe('a');
    expect(text(list.items[0].subs[0].items[0].inline)).toBe('b text');
  });

  it('ends an indented top-level list at a paragraph at the same indent', () => {
    const blocks = parseGuide(['  - a', '  Para line.', ''].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('list');
    expect(blocks[1].kind).toBe('paragraph');
  });

  it('keeps two sub-lists of one item as two lists', () => {
    const blocks = parseGuide(['1. a', '   1. b', '   - x', '2. c', ''].join('\n'));
    const list = pick(blocks[0], 'list');
    expect(list.items[0].subs).toHaveLength(2);
  });

  it('reads tables with escaped bars', () => {
    const blocks = parseGuide('| Key | Action |\n| --- | --- |\n| Ctrl+O | Open \\| load |\n');
    const table = pick(blocks[0], 'table');
    expect(text(table.head[1])).toBe('Action');
    expect(text(table.rows[0][1])).toBe('Open | load');
  });

  it('closes a fence only with at least as many backticks', () => {
    const blocks = parseGuide(['````', '```', '# inside', '```', '````', '', '## After', ''].join('\n'));
    expect(blocks[0]).toEqual({ kind: 'code', text: ['```', '# inside', '```'].join('\n') });
    expect(blocks[1]).toMatchObject({ kind: 'heading', id: 'after' });
  });

  it('gives every heading its own id', () => {
    const ids = parseGuide(['## Same', '', '## Same', '', '## Same 1', ''].join('\n'))
      .filter((b) => b.kind === 'heading')
      .map((b) => (b as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.slice(0, 2)).toEqual(['same', 'same-1']);
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

describe('the bundled user guide', () => {
  const source = readFileSync(resolve(__dirname, '../docs/USER-GUIDE.md'), 'utf8');
  const blocks = parseGuide(source);

  it('has a heading for every in-guide link', () => {
    const ids = new Set(blocks.filter((b) => b.kind === 'heading').map((b) => (b as { id: string }).id));
    const targets: string[] = [];
    const visit = (nodes: GuideInline[]): void => {
      for (const n of nodes) {
        if (n.kind === 'jump') targets.push(n.target);
        if (n.kind === 'bold' || n.kind === 'italic' || n.kind === 'jump') visit(n.children);
      }
    };
    const list = (l: GuideList): void => {
      for (const item of l.items) {
        visit(item.inline);
        item.subs.forEach(list);
      }
    };
    for (const b of blocks) {
      if (b.kind === 'paragraph' || b.kind === 'quote') visit(b.inline);
      else if (b.kind === 'list') list(b);
      else if (b.kind === 'table') [b.head, ...b.rows].forEach((row) => row.forEach(visit));
    }
    expect(targets.length).toBeGreaterThan(10);
    expect(targets.filter((id) => !ids.has(id))).toEqual([]);
  });
});
