// The signed-document funnel, enforced mechanically.
//
// `lib/op-edit-class` makes the roster total over the OPS. This makes it total
// over the CALL SITES: every place in the renderer that opens an in-place
// rewrite of a document must have taken the signed-document decision first.
//
// It exists because the claim "every in-place op goes through
// performOperation" was verified by reading, and reading missed four surfaces
// that snapshot and rewrite a signed document with no question asked. A
// hand-checked claim about a whole tree is a claim that decays on the next
// commit; this one fails, by file and line, on the next straggler.
//
// THE DOORS. Two calls replace a document's bytes:
//   `file.snapshot(...)`    — opens an in-place rewrite (its return is the
//                             undo entry; nothing lands undoably without it),
//                             and it runs the COMMIT GATE, which flushes the
//                             user's pending page edits to disk.
//   `file.writeBuffer(...)` — writes bytes at a path directly.
// `UPDATE_FILE` is deliberately NOT a door: it publishes a `snapshotPath` that
// only `file.snapshot` can have produced, so guarding the snapshot guards it,
// and treating it as a door would flag the publish-only helpers a gated caller
// hands the path to.
//
// THE RULE. For each door, some enclosing function must call a gate
// (`performOperation` — which takes the decision from the op's own class —
// `confirmSignedEdit`, `confirmEditOfSignedDoc`, or `confirmPageEdit`) at a
// position BEFORE the door. Before, not merely present: `file.snapshot` runs
// the commit gate, so a decision taken afterwards has already flushed the
// user's pending page edits on the way to refusing the edit that caused it.
//
// Anything else must be on EXEMPT below with a reason.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

/** The doors, under both the namespace form (`file.snapshot(`) and the
 * destructured form a module-scope importer uses (`snapshot(`). */
const DOORS: readonly string[] = ['file.snapshot', 'file.writeBuffer', 'snapshot', 'writeBuffer'];

/** The calls that take the signed-document decision. */
const GATES: ReadonlySet<string> = new Set([
  'performOperation',
  'confirmSignedEdit',
  'confirmEditOfSignedDoc',
  'confirmPageEdit',
]);

/** A door that writes something other than an open document's bytes.
 *
 * Keyed by file + enclosing function + door, never by line: a line number is
 * invalidated by any edit above it, and a roster that goes stale on unrelated
 * work is a roster people delete. */
interface Exemption {
  file: string;
  fn: string;
  door: string;
  reason: string;
}

const EXEMPT: readonly Exemption[] = [
  {
    file: 'App.tsx',
    fn: 'insertBlankPage',
    door: 'file.writeBuffer',
    reason:
      'Writes a NEW temp PDF beside the working copy, then imports it. No open document is read or replaced; the import is page-tier work and takes the page tier\'s own decision.',
  },
  {
    file: 'components/RedactionPropertiesFields.tsx',
    fn: 'exportSet',
    door: 'file.writeBuffer',
    reason:
      'Writes a redaction-code JSON set the user picked a path for. Not a PDF, and not a document this app has open.',
  },
  {
    file: 'lib/symbol-set-io.ts',
    fn: 'exportSymbolSetToPath',
    door: 'file.writeBuffer',
    reason: 'Writes a takeoff symbol-set JSON file the user named. Not a document.',
  },
  {
    file: 'lib/workspace-commit.ts',
    fn: 'commitPageEdits',
    door: 'writeBuffer',
    reason:
      'The page-tier commit, staging built bytes to a temp path before the rename-all. The decision for a page-tier gesture is taken at the GESTURE by `pageEditDecision` (lib/page-edit-gate), because the commit runs long after the user asked — asking here would ask about a batch nobody is looking at.',
  },
  {
    file: 'lib/workspace-commit.ts',
    fn: 'commitPageEdits',
    door: 'snapshot',
    reason:
      'The same commit taking its undo entry immediately before the rename-all. Same decision, same place: the page tier asks at the gesture, not here.',
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
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    return `${target.expression.text}.${target.name.text}`;
  }
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

interface DoorSite {
  file: string;
  line: number;
  fn: string;
  door: string;
  /** Whether some enclosing function gates BEFORE this position. */
  gated: boolean;
}

function scan(absolute: string): DoorSite[] {
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const file = relative(RENDERER, absolute).split(sep).join('/');
  const sites: DoorSite[] = [];

  /** Gate calls inside `fn` but not inside a nested function of it — a gate in
   * a sibling callback proves nothing about this path. */
  function gatePositionsIn(fn: ts.Node): number[] {
    const positions: number[] = [];
    const walk = (node: ts.Node): void => {
      if (node !== fn && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && GATES.has(calleeName(node))) positions.push(node.getStart());
      node.forEachChild(walk);
    };
    fn.forEachChild(walk);
    return positions;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (DOORS.includes(name)) {
        const at = node.getStart();
        let gated = false;
        // Any enclosing function may hold the gate: a door inside a helper
        // closure is gated by the function that defines and calls it.
        for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
          if (!ts.isFunctionLike(owner)) continue;
          if (gatePositionsIn(owner).some((p) => p < at)) {
            gated = true;
            break;
          }
        }
        sites.push({
          file,
          line: source.getLineAndCharacterOfPosition(at).line + 1,
          fn: functionName(
            (function nearest(n: ts.Node): ts.Node {
              for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
                if (ts.isFunctionLike(p)) return p;
              }
              return n;
            })(node),
          ),
          door: name,
          gated,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return sites;
}

const SITES = sourceFiles(RENDERER).flatMap(scan);

function isExempt(site: DoorSite): boolean {
  return EXEMPT.some((e) => e.file === site.file && e.fn === site.fn && e.door === site.door);
}

describe('the signed-document funnel is total over the tree', () => {
  it('finds the doors at all', () => {
    // A matcher that matches nothing would pass every assertion below while
    // proving nothing about the tree.
    expect(SITES.length).toBeGreaterThan(10);
    expect(SITES.some((s) => s.door === 'file.snapshot')).toBe(true);
    expect(SITES.some((s) => s.door === 'file.writeBuffer')).toBe(true);
  });

  it('gates every in-place rewrite, or exempts it with a reason', () => {
    const offenders = SITES.filter((s) => !s.gated && !isExempt(s)).map(
      (s) =>
        `${s.file}:${s.line} — ${s.door} inside \`${s.fn}\` takes no signed-document decision. ` +
        'Route it through `performOperation` (preferred), call `confirmSignedEdit` before the ' +
        'door, or add it to EXEMPT in tests/edit-funnel.test.ts with the reason it writes ' +
        'something other than an open document.',
    );
    expect(offenders).toEqual([]);
  });

  it('holds every exemption to a site that still exists', () => {
    // A roster entry with nothing behind it is a licence nobody asked for: it
    // would silently cover a NEW ungated door that happened to land in a
    // function with the same name.
    const stale = EXEMPT.filter(
      (e) => !SITES.some((s) => s.file === e.file && s.fn === e.fn && s.door === e.door),
    ).map((e) => `${e.file} \`${e.fn}\` ${e.door}`);
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason', () => {
    for (const e of EXEMPT) {
      expect(e.reason.length, `${e.file} ${e.fn}`).toBeGreaterThan(40);
    }
  });

  it('leaves no panel snapshotting a document outside the funnel', () => {
    // The F4 shape specifically: a panel that opens its own rewrite. Panels
    // either call `performOperation` (no snapshot of their own remains) or
    // gate first; either way an ungated snapshot under panels/ is the defect.
    const panelDoors = SITES.filter(
      (s) => s.file.startsWith('panels/') && s.door === 'file.snapshot' && !s.gated,
    ).map((s) => `${s.file}:${s.line} (${s.fn})`);
    expect(panelDoors).toEqual([]);
  });
});
