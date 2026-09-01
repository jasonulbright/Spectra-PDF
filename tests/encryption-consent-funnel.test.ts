// The consent seam, enforced mechanically over the CALL SITES.
//
// `refuse_encrypted_source` guards every op that rewrites a document through a
// renderer subprocess: the output cannot carry the source's protection, so the
// engine refuses rather than handing back an unprotected copy. Where the
// document's passwords are empty the operation CAN run, and `drop_encryption`
// carries the user's answer. A panel that omits the parameter can never send
// that answer — the refusal is all its user ever sees, and the operation is
// unreachable for a whole class of documents.
//
// That is exactly how `convert_cmyk` and `convert_pdfx` shipped while three
// sibling panels had the wrapper. So the rule is total over the sites rather
// than remembered per panel.
//
// THE RULE. Every `call(...)` / `callRaw(...)` of an op in `OPS` supplies
// `drop_encryption`, in the argument object or on the params object its
// enclosing function builds. Anything else is on EXEMPT with a reason — and an
// exemption is what a batch, scheduled or watched run needs, because nobody is
// at the screen to answer a dialog there.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

/** The ops whose engine door takes `drop_encryption`. Grown when another op
 * adopts `refuse_encrypted_source`, never trimmed to make a red go away. */
const OPS: readonly string[] = [
  'compress',
  'grayscale',
  'rebuild',
  'convert_cmyk',
  'convert_pdfx',
];

const BRIDGES: ReadonlySet<string> = new Set(['call', 'callRaw']);

const PARAM = 'drop_encryption';

/** The wrapper that turns the refusal into a question. A site that supplies
 * the parameter without it would be answering on the user's behalf. */
const WRAPPER = 'runWithConsent';

interface Exemption {
  file: string;
  fn: string;
  op: string;
  reason: string;
}

const EXEMPT: readonly Exemption[] = [
  {
    file: 'components/BatchOcrDialog.tsx',
    fn: 'compressMrc',
    op: 'compress',
    reason:
      'Batch runs over a folder tree with nobody at the screen: a consent dialog would ' +
      'block the run on a question no one is there to answer, and answering it once ' +
      'would silently apply to every remaining document. The refusal is reported per ' +
      'file and the protected document is left alone.',
  },
];

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
    if (ts.isFunctionLike(node)) return functionName(node);
    node = node.parent;
  }
  return '<anonymous>';
}

/** `name` as a property NAME anywhere under `node` — an object-literal entry,
 * a `params.x =` assignment, or a `params['x'] =` one. */
function suppliesParam(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === name
    ) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === name) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteral(n.argumentExpression) &&
      n.argumentExpression.text === name
    ) {
      found = true;
      return;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

/** Is this call lexically inside a `runWithConsent(...)` argument? */
function insideWrapper(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && calleeName(p) === WRAPPER) return true;
  }
  return false;
}

interface OpSite {
  file: string;
  line: number;
  fn: string;
  op: string;
  supplied: boolean;
  wrapped: boolean;
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
        let supplied = args !== undefined && suppliesParam(args, PARAM);
        if (!supplied) {
          for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
            if (!ts.isFunctionLike(owner)) continue;
            if (suppliesParam(owner, PARAM)) {
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
          wrapped: insideWrapper(node),
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

describe('every encryption-refusing op can carry the user’s answer', () => {
  it('finds the call sites at all', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SITES.map((s) => s.op))).toEqual(new Set(OPS));
  });

  it('supplies drop_encryption at every site, or exempts it with a reason', () => {
    const offenders = SITES.filter((s) => !s.supplied && !isExempt(s)).map(
      (s) =>
        `${s.file}:${s.line} — \`${s.op}\` inside \`${s.fn}\` is called without ` +
        '`drop_encryption`. Wrap the call in `runWithConsent` from ' +
        'hooks/useEncryptionConsent, or add it to EXEMPT in ' +
        'tests/encryption-consent-funnel.test.ts with the reason nobody is at the ' +
        'screen to answer.',
    );
    expect(offenders).toEqual([]);
  });

  it('takes the answer from the consent wrapper, never from the caller', () => {
    // A hardcoded `drop_encryption: true` would hand back an unprotected copy
    // without ever asking, which is the one outcome the seam exists to prevent.
    const offenders = SITES.filter((s) => s.supplied && !s.wrapped).map(
      (s) => `${s.file}:${s.line} — \`${s.op}\` inside \`${s.fn}\``,
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the unattended runs out of the wrapper', () => {
    // The exemptions are the batch/scheduled/watched tiers. If one of them ever
    // grows a dialog, it blocks a folder run on a question with no reader.
    const offenders = SITES.filter((s) => isExempt(s) && (s.wrapped || s.supplied)).map(
      (s) => `${s.file}:${s.line} — \`${s.op}\` inside \`${s.fn}\``,
    );
    expect(offenders).toEqual([]);
  });

  it('holds every exemption to a site that still exists', () => {
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
