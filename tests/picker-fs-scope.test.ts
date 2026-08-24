// The scoped-fs picker class, enforced mechanically.
//
// plugin-fs is STATICALLY scoped to `$TEMP/spectrapdf/**`. A path the user
// picked in a native dialog is outside that scope, so a scoped read or write of
// it is refused at run time — a live defect, not a type error. Exactly two Rust
// picker commands widen the runtime scope for what they return (they call
// `allow_picked_path`); every other picker returns a path plugin-fs rejects,
// and such a path must reach the filesystem through `file.readExternalBuffer`
// (or another arbitrary-path Rust command), never through `file.readBuffer` /
// `file.writeBuffer`.
//
// The class produced three live defects at once. Reading the tree found them;
// reading the tree is also what will miss the fourth, so this fails by file and
// line instead.
//
// THE DERIVATION. Nothing here is a hand-written roster. `src-tauri/src/
// commands.rs` is parsed: a PICKER is a `#[tauri::command]` function whose body
// opens a native dialog (`blocking_pick_file`, `blocking_pick_files`,
// `blocking_save_file`, `blocking_pick_folder`), and it EXTENDS the scope when
// that body calls `allow_picked_path`. The command → bridge-export map is read
// the same way, out of the `dialog` object in `lib/tauri-bridge.ts`. Add a
// picker, move an `allow_picked_path` call, rename a bridge export: the rosters
// move with the source on the next run. The brace/comment scanner that reads
// the Rust self-tests against a synthetic source below.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. The flow analysis is intra-procedural
// and AST-provable only. It catches a picked path that is bound in a function
// (or consumed inline) and then handed to a scoped door inside that same
// function, including from a closure nested in it — the shape every defect of
// this class has had. It does NOT follow a path stored into React state, a ref,
// a module-level variable, or passed to another function and read there; those
// remain matters for review. Two holes that WOULD defeat the analysis are
// closed by assertion instead: the renderer may not `invoke` a picker command
// directly (bypassing the bridge map), and it may not destructure the `dialog`
// bridge object (bypassing callee matching).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const COMMANDS_RS = join(ROOT, 'src-tauri', 'src', 'commands.rs');
const BRIDGE = join(RENDERER, 'lib', 'tauri-bridge.ts');

/** The scoped doors, namespace form and destructured form alike. */
const DOORS: readonly string[] = [
  'file.readBuffer',
  'file.writeBuffer',
  'readBuffer',
  'writeBuffer',
];

/** Opening a native dialog: what makes a command a picker. */
const DIALOG_OPENERS: readonly string[] = [
  'blocking_pick_file',
  'blocking_pick_files',
  'blocking_save_file',
  'blocking_pick_folder',
];

const SCOPE_EXTENDER = 'allow_picked_path';

// ── deriving the rosters from the Rust source ─────────────────────────────

export interface RustPicker {
  command: string;
  extendsScope: boolean;
}

/** Strip Rust line comments and string literals so a mention of a name in prose
 * or in a message never reads as a call. Block comments do not appear in the
 * bodies scanned and are left alone deliberately: dropping them needs nesting
 * rules, and a false POSITIVE here can only over-report a picker, never hide
 * one. */
function stripRustNoise(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const out: string[] = [];
      let inString = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inString) {
          if (ch === '\\') i += 1;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '/' && line[i + 1] === '/') break;
        out.push(ch);
      }
      return out.join('');
    })
    .join('\n');
}

/** The body of the function starting at `from`, by brace matching. */
function rustBody(source: string, from: number): string {
  const open = source.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** Every picker command in a Rust source, and whether it extends the fs scope.
 *
 * Exported so the self-test below runs the SAME code the roster runs. */
export function derivePickers(source: string): RustPicker[] {
  const clean = stripRustNoise(source);
  const pickers: RustPicker[] = [];
  const fn = /pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fn.exec(clean)) !== null) {
    const body = rustBody(clean, m.index);
    if (!DIALOG_OPENERS.some((opener) => body.includes(`${opener}(`))) continue;
    pickers.push({ command: m[1], extendsScope: body.includes(`${SCOPE_EXTENDER}(`) });
  }
  return pickers;
}

/** Calls to the scope extender anywhere in a source, excluding its definition. */
export function countExtenderCalls(source: string): number {
  const clean = stripRustNoise(source);
  const withoutDefinition = clean.replace(
    new RegExp(`fn\\s+${SCOPE_EXTENDER}\\s*\\(`, 'g'),
    'fn __definition__(',
  );
  return (withoutDefinition.match(new RegExp(`${SCOPE_EXTENDER}\\s*\\(`, 'g')) ?? []).length;
}

const RUST = readFileSync(COMMANDS_RS, 'utf8');
const PICKERS = derivePickers(RUST);
const EXTENDING = PICKERS.filter((p) => p.extendsScope).map((p) => p.command).sort();
const NON_EXTENDING = PICKERS.filter((p) => !p.extendsScope).map((p) => p.command).sort();

// ── the command → bridge-export map, from tauri-bridge.ts ─────────────────

function parse(absolute: string): ts.SourceFile {
  return ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
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

/** The single command name a subtree invokes, or ''. */
function invokedCommand(node: ts.Node): string {
  let found = '';
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'invoke') {
      const first = n.arguments[0];
      if (first && ts.isStringLiteralLike(first)) found = first.text;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

/** `dialog` export property → the command it invokes. */
function bridgeMap(): Map<string, string> {
  const source = parse(BRIDGE);
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'dialog' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const command = invokedCommand(prop.initializer);
        if (command) map.set(prop.name.text, command);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return map;
}

const BRIDGE_MAP = bridgeMap();
/** Bridge exports that return a path plugin-fs will refuse. */
const UNSAFE_EXPORTS = new Set(
  [...BRIDGE_MAP].filter(([, command]) => NON_EXTENDING.includes(command)).map(([prop]) => prop),
);

// ── the renderer scan ─────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The name a reader would call the enclosing function. */
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

function nearestFunction(node: ts.Node): ts.Node {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return p;
  }
  return node.getSourceFile();
}

/** Every identifier a binding pattern introduces. */
function boundNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) {
    if (ts.isBindingElement(element)) boundNames(element.name, out);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  fn: string;
  door: string;
  picker: string;
}

interface Escape {
  file: string;
  line: number;
  what: string;
}

const violations: Violation[] = [];
const escapes: Escape[] = [];

function scan(absolute: string): void {
  const source = parse(absolute);
  const file = relative(RENDERER, absolute).split(sep).join('/');
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  // The two shapes that would make the analysis blind.
  const noticeEscapes = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'invoke' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      [...BRIDGE_MAP.values()].includes((node.arguments[0] as ts.StringLiteralLike).text) &&
      absolute !== BRIDGE
    ) {
      escapes.push({
        file,
        line: at(node),
        what: `invokes the picker command '${(node.arguments[0] as ts.StringLiteralLike).text}' directly instead of through the \`dialog\` bridge`,
      });
    }
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer &&
      node.initializer.getText() === 'dialog'
    ) {
      escapes.push({ file, line: at(node), what: 'destructures the `dialog` bridge object' });
    }
    node.forEachChild(noticeEscapes);
  };
  noticeEscapes(source);

  /** The unsafe picker a call expression is, or ''. */
  const unsafePickerOf = (node: ts.Node): string => {
    const call = ts.isAwaitExpression(node) ? node.expression : node;
    if (!ts.isCallExpression(call)) return '';
    const name = calleeName(call);
    const prop = name.startsWith('dialog.') ? name.slice('dialog.'.length) : '';
    return prop && UNSAFE_EXPORTS.has(prop) ? prop : '';
  };

  /** Picked-path variable → picker, for bindings made directly in `scope`
   * (not in a nested function, whose own pass owns them). */
  const pickedIn = (scope: ts.Node): Map<string, string> => {
    const found = new Map<string, string>();
    const walk = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const picker = unsafePickerOf(node.initializer);
        if (picker) for (const n of boundNames(node.name)) found.set(n, picker);
      }
      node.forEachChild(walk);
    };
    scope.forEachChild(walk);
    return found;
  };

  /** Whether an argument expression is provably built from `names`. */
  const mentions = (arg: ts.Node, names: Map<string, string>): string => {
    let hit = '';
    const walk = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(n) && names.has(n.text)) {
        // A property NAME that happens to match is not a read of the variable.
        const parent = n.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === n) return;
        hit = names.get(n.text) as string;
        return;
      }
      n.forEachChild(walk);
    };
    walk(arg);
    return hit;
  };

  const scopes: ts.Node[] = [source];
  const collectScopes = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) scopes.push(node);
    node.forEachChild(collectScopes);
  };
  collectScopes(source);

  for (const scope of scopes) {
    const picked = pickedIn(scope);
    const inlineOnly = picked.size === 0;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && DOORS.includes(calleeName(node))) {
        const arg = node.arguments[0];
        if (arg) {
          // Inline: `file.readBuffer(await dialog.pickX())`.
          let picker = unsafePickerOf(arg);
          if (!picker && !inlineOnly) picker = mentions(arg, picked);
          if (picker) {
            violations.push({
              file,
              line: at(node),
              fn: functionName(nearestFunction(node)),
              door: calleeName(node),
              picker,
            });
          }
        }
      }
      node.forEachChild(walk);
    };
    // Doors in nested functions still count: a closure reading the picked
    // variable is the same flow.
    scope.forEachChild(walk);
  }
}

sourceFiles(RENDERER).forEach(scan);

// Inline flows are found once per enclosing scope, so the same site can be
// recorded by several passes.
const VIOLATIONS = [...new Map(violations.map((v) => [`${v.file}:${v.line}:${v.door}`, v])).values()];

// ── the assertions ────────────────────────────────────────────────────────

describe('the picker roster is derived from the Rust source', () => {
  it('reads pickers and their scope extension out of a synthetic source', () => {
    const synthetic = `
      /// A picker that widens the scope: allow_picked_path in prose is not a call.
      #[tauri::command]
      pub async fn pick_widening(app: AppHandle) -> Result<Option<String>, String> {
          let result = app.dialog().file().blocking_pick_file();
          match result {
              Some(p) => { let s = p.to_string(); allow_picked_path(&app, &s); Ok(Some(s)) }
              None => Ok(None),
          }
      }
      #[tauri::command]
      pub async fn pick_narrow(app: AppHandle) -> Result<Vec<String>, String> {
          // allow_picked_path( deliberately mentioned in a comment
          let msg = "allow_picked_path(";
          Ok(app.dialog().file().blocking_pick_files().unwrap_or_default())
      }
      #[tauri::command]
      pub async fn not_a_picker(path: String) -> Result<(), String> { Ok(()) }
    `;
    expect(derivePickers(synthetic)).toEqual([
      { command: 'pick_widening', extendsScope: true },
      { command: 'pick_narrow', extendsScope: false },
    ]);
    expect(countExtenderCalls(synthetic)).toBe(1);
  });

  it('finds the pickers in the real source at all', () => {
    // A derivation that matched nothing would pass every assertion below.
    expect(PICKERS.length).toBeGreaterThan(10);
    expect(EXTENDING.length).toBeGreaterThan(0);
    expect(NON_EXTENDING.length).toBeGreaterThan(5);
  });

  it('has exactly the scope-extending pickers the extender is called from', () => {
    // The point of the count: `allow_picked_path` gaining or losing a caller
    // WITHOUT the derived roster moving would mean the derivation stopped
    // reading the truth — a call in a helper, or one the body scan missed.
    expect(countExtenderCalls(RUST)).toBe(EXTENDING.length);
  });

  it('maps every picker command to a bridge export', () => {
    const commands = new Set(BRIDGE_MAP.values());
    const unmapped = PICKERS.map((p) => p.command).filter((c) => !commands.has(c));
    // `open_files_dialog` is the document open funnel and has its own bridge
    // entry; anything else unmapped means a picker the renderer reaches by a
    // route this guard cannot see.
    expect(unmapped).toEqual([]);
  });
});

describe('no picked path outside the fs scope reaches a scoped door', () => {
  it('keeps the analysis unblinded', () => {
    const found = escapes.map((e) => `${e.file}:${e.line} — ${e.what}`);
    expect(found).toEqual([]);
  });

  it('routes every non-extending picker away from readBuffer/writeBuffer', () => {
    const offenders = VIOLATIONS.map(
      (v) =>
        `${v.file}:${v.line} (${v.fn}) — \`${v.door}\` is handed a path from ` +
        `\`dialog.${v.picker}\`, whose Rust command does not call ${SCOPE_EXTENDER}. ` +
        'plugin-fs is scoped to $TEMP/spectrapdf/** and refuses it at run time. ' +
        'Read it with `file.readExternalBuffer`, or write it through a Rust ' +
        'command that takes an arbitrary path.',
    );
    expect(offenders).toEqual([]);
  });
});
