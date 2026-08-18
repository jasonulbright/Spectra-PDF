// The fallback-face funnel, enforced mechanically.
//
// Three whole-file ops regenerate the appearance of a widget that carries
// none before their Ghostscript producer ever sees the document
// (`engine/widget_faces.py` `regenerate_appearances_file`). They can only do
// it for a value the form's own WinAnsi face cannot spell when the caller
// hands them `font_dir` — the bundled fallback faces. Without it the producer
// synthesizes its own appearance from `/V`'s UTF-16BE bytes (ISO 32000-2
// 7.9.2.2), flattens that mojibake into the page content, and the field
// reattach restores the bare widget over it. The flatten is permanent.
//
// The parameter was threaded through the engine and through
// `engine/preflight_fixups.py` while every renderer call site still omitted
// it, so the whole fix was unreachable from the product. This makes the rule
// total over the CALL SITES rather than over the ops: a new panel, dialog or
// helper that reaches one of these ops fails here, by file and line, instead
// of shipping a document with mojibake baked into it.
//
// THE RULE. Every `call(...)` / `callRaw(...)` of an op in `OPS` supplies
// `font_dir`, either in the argument object itself or on the params object its
// enclosing function builds. Anything else must be on EXEMPT with a reason.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

/** The ops whose engine door takes `font_dir` for this purpose. Grown when
 * another op starts regenerating appearances, never trimmed to make a red
 * go away. */
const OPS: readonly string[] = ['compress', 'grayscale', 'convert_cmyk'];

/** The engine bridges. `call` runs the commit gate; `callRaw` does not, and
 * both reach the same engine op. */
const BRIDGES: ReadonlySet<string> = new Set(['call', 'callRaw']);

const PARAM = 'font_dir';

/** A call site that reaches one of these ops without the parameter.
 *
 * Keyed by file + enclosing function + op, never by line: a line number is
 * invalidated by any edit above it, and a roster that goes stale on unrelated
 * work is a roster people delete. */
interface Exemption {
  file: string;
  fn: string;
  op: string;
  reason: string;
}

const EXEMPT: readonly Exemption[] = [];

// ── the scan ──────────────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The dotted text of a call's callee, for `a.b(` and `b(` alike. */
function calleeName(node: ts.CallExpression): string {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return '';
}

/** The name a reader would call the enclosing function — the nearest binding
 * a function-like node is assigned to, or its own name. */
function functionName(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  let node: ts.Node | undefined = fn.parent;
  while (node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    // Stop at the next function boundary: past it the binding belongs to an
    // outer function, not to this one.
    if (ts.isFunctionLike(node)) return functionName(node);
    node = node.parent;
  }
  return '<anonymous>';
}

/** `font_dir` as a property NAME anywhere under `node` — an object literal
 * entry, a `params.font_dir =` assignment, or a `params['font_dir'] =` one.
 * Nested functions are included deliberately: a params object built inside a
 * helper closure and handed to the call is the same supply. */
function suppliesParam(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === PARAM
    ) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === PARAM) {
      found = true;
      return;
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)
        && n.argumentExpression.text === PARAM) {
      found = true;
      return;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

interface OpSite {
  file: string;
  line: number;
  fn: string;
  op: string;
  /** Whether `font_dir` is supplied at the call or by its enclosing function. */
  supplied: boolean;
}

function scan(absolute: string): OpSite[] {
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const file = relative(RENDERER, absolute).split(sep).join('/');
  const sites: OpSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && BRIDGES.has(calleeName(node))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && OPS.includes(first.text)) {
        const args = node.arguments[1];
        // The argument itself, else the whole enclosing function: several
        // sites build a `params` record over branches and hand it over by
        // name, so the supply is a statement above the call.
        let supplied = args !== undefined && suppliesParam(args);
        if (!supplied) {
          for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
            if (!ts.isFunctionLike(owner)) continue;
            if (suppliesParam(owner)) {
              supplied = true;
              break;
            }
          }
        }
        sites.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          fn: functionName(
            (function nearest(n: ts.Node): ts.Node {
              for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
                if (ts.isFunctionLike(p)) return p;
              }
              return n;
            })(node),
          ),
          op: first.text,
          supplied,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return sites;
}

const SITES = sourceFiles(RENDERER).flatMap(scan);

function isExempt(site: OpSite): boolean {
  return EXEMPT.some((e) => e.file === site.file && e.fn === site.fn && e.op === site.op);
}

describe('every appearance-regenerating op is handed the fallback faces', () => {
  it('finds the call sites at all', () => {
    // A matcher that matches nothing would pass every assertion below while
    // proving nothing about the tree.
    expect(SITES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(SITES.map((s) => s.op))).toEqual(new Set(OPS));
  });

  it('supplies font_dir at every site, or exempts it with a reason', () => {
    const offenders = SITES.filter((s) => !s.supplied && !isExempt(s)).map(
      (s) =>
        `${s.file}:${s.line} — \`${s.op}\` inside \`${s.fn}\` is called without ` +
        '`font_dir`. Pass `font_dir: await app.getEditFontPath()`, or add it to EXEMPT in ' +
        'tests/font-dir-funnel.test.ts with the reason this call cannot reach a widget ' +
        'that carries no appearance.',
    );
    expect(offenders).toEqual([]);
  });

  it('holds every exemption to a site that still exists', () => {
    // A roster entry with nothing behind it is a licence nobody asked for: it
    // would silently cover a NEW unsupplied call that happened to land in a
    // function with the same name.
    const stale = EXEMPT.filter(
      (e) => !SITES.some((s) => s.file === e.file && s.fn === e.fn && s.op === e.op),
    ).map((e) => `${e.file} \`${e.fn}\` ${e.op}`);
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason', () => {
    for (const e of EXEMPT) {
      expect(e.reason.length, `${e.file} ${e.fn}`).toBeGreaterThan(40);
    }
  });
});
