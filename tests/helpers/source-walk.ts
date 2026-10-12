import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const RENDERER_ROOT = join(__dirname, '../../src/renderer');

/** Budget per source file for one pass over a tree: the parse, or one walk of
 * every parsed file. A hook or test that makes such a pass takes this times
 * the number of files, so the budget grows with the tree and holds on a
 * machine that is also running a build. */
const WALK_MS_PER_FILE = 50;

export interface ParsedSource {
  /** Absolute path. */
  path: string;
  /** Path relative to the walked root, with `/` separators. */
  rel: string;
  text: string;
  file: ts.SourceFile;
}

/** Every TypeScript source under `root`, `*.local.*` scratch excluded. Lists
 * only: no file is read, so it is cheap enough to run at collection time. */
export function listSources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.tsx?$/.test(name) && !name.includes('.local.') ? [path] : [];
  });
}

/** The timeout for one pass over `count` files. */
export function walkBudgetMs(count: number): number {
  return count * WALK_MS_PER_FILE;
}

const parsedByRoot = new Map<string, ParsedSource[]>();

/** Reads and parses `paths` once per root per test module; a second call
 * returns the same parse. Parent links are set, so `node.parent` works. */
export function parseSources(root: string, paths: readonly string[]): ParsedSource[] {
  const cached = parsedByRoot.get(root);
  if (cached) return cached;
  const parsed = paths.map((path) => {
    const text = readFileSync(path, 'utf8');
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return {
      path,
      rel: relative(root, path).split(sep).join('/'),
      text,
      file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind),
    };
  });
  parsedByRoot.set(root, parsed);
  return parsed;
}
