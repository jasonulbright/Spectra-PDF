import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * TypeScript source with every comment blanked to spaces. Line breaks stay, so
 * line-anchored patterns and offsets still match the original layout, and text
 * that exists only in a comment can no longer satisfy a source check.
 */
export function codeText(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (node: ts.Node) => {
    if (node.kind !== ts.SyntaxKind.JsxText) {
      for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) ranges.set(range.pos, range);
      for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) ranges.set(range.pos, range);
    }
    for (const child of node.getChildren(file)) collect(child);
  };
  collect(file);
  let out = text;
  for (const { pos, end } of ranges.values()) {
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
}
