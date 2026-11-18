// A small Markdown reader for the bundled user guide (docs/USER-GUIDE.md).
//
// It returns plain data, never HTML: the Help dialog turns the data into
// React elements, so no string from the guide is ever set as markup. The
// guide uses a fixed subset; anything outside it reads as a paragraph, so a
// stray character cannot open a hole. Links that start with `#` jump inside
// the guide. Every other link keeps its text and drops its address: the app
// never opens an address that a document names.

export type GuideInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: GuideInline[] }
  | { kind: 'italic'; children: GuideInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'jump'; target: string; children: GuideInline[] };

/** One list item: its text, and the lists nested under it, in order. A numbered
 *  sub-list followed by a bullet sub-list are two lists. */
export interface GuideListItem {
  inline: GuideInline[];
  subs: GuideList[];
}

export interface GuideList {
  kind: 'list';
  ordered: boolean;
  items: GuideListItem[];
}

export type GuideBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; id: string; inline: GuideInline[] }
  | { kind: 'paragraph'; inline: GuideInline[] }
  | GuideList
  | { kind: 'quote'; inline: GuideInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: GuideInline[][]; rows: GuideInline[][][] }
  | { kind: 'rule' };

/** The GitHub-style anchor for a heading: lower case, spaces to hyphens. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** The plain text of an inline run, with the markup removed. */
export function inlineText(inline: GuideInline[]): string {
  return inline
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.text;
      return inlineText(node.children);
    })
    .join('');
}

const MAX_NESTING = 4;

export function parseInline(source: string, depth = 0): GuideInline[] {
  const out: GuideInline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_NESTING && (source.startsWith('**', i) || ch === '*')) {
      const bold = source.startsWith('**', i);
      const mark = bold ? '**' : '*';
      const end = source.indexOf(mark, i + mark.length);
      if (end > i + mark.length) {
        flush();
        const children = parseInline(source.slice(i + mark.length, end), depth + 1);
        out.push({ kind: bold ? 'bold' : 'italic', children });
        i = end + mark.length;
        continue;
      }
    }
    if (depth < MAX_NESTING && ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close > i && source[close + 1] === '(') {
        const end = source.indexOf(')', close + 2);
        if (end > close) {
          const label = source.slice(i + 1, close);
          const target = source.slice(close + 2, end).trim();
          flush();
          const children = parseInline(label, depth + 1);
          if (target.startsWith('#') && target.length > 1) {
            out.push({ kind: 'jump', target: target.slice(1), children });
          } else {
            out.push(...children);
          }
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (body[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += body[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

const RULE_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/;

const indentOf = (s: string): number => s.length - s.trimStart().length;

/**
 * A list that starts at `start`. An item holds the list indented under it, so
 * a numbered step keeps its own number and its sub-steps. A line with no marker
 * and at least this list's indent wraps the text of this list's last item, so
 * text after a sub-list stays after it. A list of the other kind under the same
 * item starts a new sub-list.
 */
function parseList(lines: string[], start: number): { block: GuideList; next: number } {
  const base = indentOf(lines[start]);
  const ordered = NUMBERED.test(lines[start]) && !BULLET.test(lines[start]);
  const items: GuideListItem[] = [];
  let i = start;
  while (i < lines.length && lines[i].trim()) {
    const line = lines[i];
    const indent = indentOf(line);
    const own = (ordered ? NUMBERED : BULLET).exec(line);
    const marked = BULLET.test(line) || NUMBERED.test(line);
    if (indent === base && own) {
      items.push({ inline: parseInline(own[1]), subs: [] });
      i += 1;
    } else if (indent > base && marked && items.length > 0) {
      const item = items[items.length - 1];
      const nested = parseList(lines, i);
      const last = item.subs[item.subs.length - 1];
      if (last && last.ordered === nested.block.ordered) last.items.push(...nested.block.items);
      else item.subs.push(nested.block);
      i = nested.next;
    } else if (!marked && indent > 0 && indent >= base && items.length > 0) {
      items[items.length - 1].inline.push(...parseInline(` ${line.trim()}`));
      i += 1;
    } else {
      break;
    }
  }
  return { block: { kind: 'list', ordered, items }, next: i };
}

export function parseGuide(source: string): GuideBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: GuideBlock[] = [];
  const used = new Set<string>();
  const seen = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const opener = /^\s*(`{3,})/.exec(line);
    if (opener) {
      const body: string[] = [];
      i += 1;
      // A closing fence is at least as long as the opener and has nothing else.
      const closes = (text: string): boolean => {
        const m = /^\s*(`{3,})\s*$/.exec(text);
        return m !== null && m[1].length >= opener[1].length;
      };
      while (i < lines.length && !closes(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const inline = parseInline(heading[2]);
      const base = headingSlug(inlineText(inline));
      // The next unused suffix, so `Same`, `Same`, `Same 1` get three ids.
      let count = seen.get(base) ?? 0;
      let id = count === 0 ? base : `${base}-${count}`;
      while (used.has(id)) {
        count += 1;
        id = `${base}-${count}`;
      }
      seen.set(base, count + 1);
      used.add(id);
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        id,
        inline,
      });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && RULE_ROW.test(lines[i + 1])) {
      const head = splitRow(line).map((c) => parseInline(c));
      const rows: GuideInline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        parts.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', inline: parseInline(parts.join(' ')) });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    const parts: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```') &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !lines[i].trimStart().startsWith('>')
    ) {
      parts.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(parts.join(' ')) });
  }
  return blocks;
}

/** The headings of level 2 and 3, for the contents list of the Help dialog. */
export function guideOutline(blocks: GuideBlock[]): { id: string; level: 2 | 3; text: string }[] {
  const out: { id: string; level: 2 | 3; text: string }[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading' && (block.level === 2 || block.level === 3)) {
      out.push({ id: block.id, level: block.level, text: inlineText(block.inline) });
    }
  }
  return out;
}
