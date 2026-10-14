// `callRaw` takes no file lock, runs no commit gate and creates no queue
// entry. A raw read of a working copy can read bytes a publication is
// replacing, and a raw write can land under another call's lock. So `callRaw`
// is only for:
//   commit      a step of the page commit, which already holds exclusive(W)
//               and the publication lane; the gated `call` would re-enter it.
//   stage       a staged rewrite's step on its private stage copy, inside the
//               rewrite's own locks.
//   outside     a path outside the workspace (a source, a scratch or mirror
//               file, a folder, a stage of its own) or no document at all.
//   credential  a call that names a working copy only to pick or drop its
//               registered credential; the bytes it reads travel inline and
//               no file is opened. Only the two App.tsx hand-offs listed in
//               CREDENTIAL_HANDOFFS may carry it.
//
// Every `callRaw(...)` call and every place the function is handed to other
// code is listed below, keyed by file and method (or by file and receiver),
// never by line. Aliases (`const raw = callRaw`, `useEngine().callRaw`,
// `{ callRaw: x }`), `x['callRaw']`, casts, conditional arms, JSX props and
// return values are followed; any other use fails as unclassified. A new site
// fails here until it is classified.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

type Kind = 'commit' | 'stage' | 'outside' | 'credential';

interface Site {
  file: string;
  /** The method name the call passes, or the source text of a computed one. */
  method: string;
  count: number;
  kind: Kind;
  reason: string;
}

interface Handoff {
  file: string;
  /** The callee the function is passed to, or the property it is stored in. */
  to: string;
  count: number;
  kind: Kind;
  reason: string;
}

const SITES: readonly Site[] = [
  {
    file: 'App.tsx', method: 'transplant_incremental', count: 1, kind: 'commit',
    reason: 'The commit appends its staged temp to the signed original.',
  },
  {
    file: 'App.tsx', method: 'text_box_appearance', count: 1, kind: 'commit',
    reason: 'The commit build asks for the text of annotations in bundled faces; no document is named.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'batch_ocr', count: 1, kind: 'outside',
    reason: 'A folder of sources read by path into a mirror tree.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'apply_ocr_layer', count: 1, kind: 'outside',
    reason: 'A mirror-tree output file.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'repair', count: 1, kind: 'outside',
    reason: 'A source read by path into a mirror-tree output.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'compress', count: 1, kind: 'outside',
    reason: 'A mirror-tree output file.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'enhance_scan', count: 1, kind: 'outside',
    reason: 'A mirror-tree output file.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', method: 'remove_empty_folders', count: 1, kind: 'outside',
    reason: 'The output folder tree.',
  },
  {
    file: 'components/CombineDialog.tsx', method: 'get_page_count', count: 2, kind: 'outside',
    reason: 'A source file the user picked.',
  },
  {
    file: 'components/CombineDialog.tsx', method: 'create_pdf', count: 2, kind: 'outside',
    reason: 'Source files the user picked, into a new output.',
  },
  {
    file: 'components/CreatePdfDialog.tsx', method: 'create_pdf', count: 2, kind: 'outside',
    reason: 'Source files the user picked, into a new output.',
  },
  {
    file: 'components/CreatePdfDialog.tsx', method: 'set_outline', count: 1, kind: 'outside',
    reason: 'The new output, before it opens.',
  },
  {
    file: 'components/navpane/SearchPanel.tsx', method: 'search_in_files', count: 1, kind: 'outside',
    reason: 'The files of a folder the user picked.',
  },
  {
    file: 'components/ScanDialog.tsx', method: 'apply_ocr_layer', count: 1, kind: 'outside',
    reason: 'The scan output, before it opens.',
  },
  {
    file: 'components/ScanDialog.tsx', method: 'create_pdf', count: 1, kind: 'outside',
    reason: 'Scanned page images, into the scan output.',
  },
  {
    file: 'components/ScanDialog.tsx', method: 'enhance_scan', count: 1, kind: 'outside',
    reason: 'The scan output, before it opens.',
  },
  {
    file: 'components/SignerSourceFields.tsx', method: 'list_pkcs11_certificates', count: 1, kind: 'outside',
    reason: 'A token module; no document.',
  },
  {
    file: 'components/WebCaptureDialog.tsx', method: 'add_header_footer', count: 1, kind: 'outside',
    reason: 'The capture\'s own scratch page files.',
  },
  {
    file: 'hooks/useSeparationPreview.tsx', method: 'composite_separations', count: 1, kind: 'outside',
    reason: 'The plate folder a separation render cached.',
  },
  {
    file: 'lib/disk-redact-io.ts', method: 'search_text_regions', count: 1, kind: 'outside',
    reason: 'A file of the folder being redacted on disk.',
  },
  {
    file: 'lib/disk-redact-io.ts', method: 'signature_policy', count: 1, kind: 'outside',
    reason: 'A file of the folder being redacted on disk.',
  },
  {
    file: 'lib/disk-redact-io.ts', method: 'save_redaction_marks', count: 1, kind: 'outside',
    reason: 'A file of the folder being redacted on disk.',
  },
  {
    file: 'lib/disk-redact-io.ts', method: 'redact', count: 1, kind: 'outside',
    reason: 'A file of the folder being redacted on disk.',
  },
  {
    file: 'lib/disk-redact-io.ts', method: 'remove_redaction_residue', count: 1, kind: 'outside',
    reason: 'A file of the folder being redacted on disk.',
  },
  {
    file: 'lib/folder-create-pdf-io.ts', method: 'list_source_folders', count: 1, kind: 'outside',
    reason: 'A folder tree the user picked.',
  },
  {
    file: 'lib/folder-create-pdf-io.ts', method: 'create_pdf', count: 1, kind: 'outside',
    reason: 'Source files of a picked folder, into a new output.',
  },
  {
    file: 'lib/folder-export-io.ts', method: 'door', count: 1, kind: 'outside',
    reason: 'A file of the folder being exported, into an output tree.',
  },
  {
    file: 'lib/folder-preflight-io.ts', method: 'run_preflight_sweep', count: 1, kind: 'outside',
    reason: 'A folder tree the user picked.',
  },
  {
    file: 'lib/folder-prep-io.ts', method: 'detect_form_fields', count: 1, kind: 'outside',
    reason: 'A file of the folder being prepared.',
  },
  {
    file: 'lib/folder-prep-io.ts', method: 'signature_policy', count: 1, kind: 'outside',
    reason: 'A file of the folder being prepared.',
  },
  {
    file: 'lib/folder-prep-io.ts', method: 'create_detected_fields', count: 1, kind: 'outside',
    reason: 'A file of the folder being prepared, into an output tree.',
  },
  {
    file: 'lib/ocr-recognize.ts', method: 'recognize_raster', count: 1, kind: 'outside',
    reason: 'Raster bytes sent inline; no document path.',
  },
  {
    file: 'panels/GuidedActionsPanel.tsx', method: 'recognize_music_run', count: 1, kind: 'outside',
    reason: 'The stage folder recognize_music_prepare wrote.',
  },
  {
    file: 'panels/GuidedActionsPanel.tsx', method: 'recognize_music_discard', count: 1, kind: 'outside',
    reason: 'Removes that stage folder.',
  },
  {
    file: 'panels/GuidedActionsPanel.tsx', method: 'run_action', count: 2, kind: 'outside',
    reason: 'A folder the user picked: the plan and the run.',
  },
  {
    file: 'panels/PortfolioPanel.tsx', method: 'create_portfolio', count: 1, kind: 'outside',
    reason: 'Source files the user picked, into a new output.',
  },
  {
    file: 'panels/RecognizeMusicPanel.tsx', method: 'recognize_music_discard', count: 1, kind: 'outside',
    reason: 'Removes the stage folder recognize_music_prepare wrote.',
  },
  {
    file: 'panels/RecognizeMusicPanel.tsx', method: 'recognize_music_run', count: 1, kind: 'outside',
    reason: 'The stage folder recognize_music_prepare wrote.',
  },
  {
    file: 'panels/SpellingPanel.tsx', method: 'list_text_paragraphs', count: 1, kind: 'outside',
    reason: 'A scratch copy of the buffer the fix was planned against.',
  },
  {
    file: 'panels/SpellingPanel.tsx', method: 'read_form_fields', count: 1, kind: 'outside',
    reason: 'A scratch copy of the buffer the fix was planned against.',
  },
];

const HANDOFFS: readonly Handoff[] = [
  {
    file: 'App.tsx', to: 'sealed', count: 1, kind: 'commit',
    reason: 'The commit\'s build and landing of a user-opened file.',
  },
  {
    file: 'App.tsx', to: 'callStaged', count: 4, kind: 'stage',
    reason: 'A staged rewrite\'s engine step on its private stage copy.',
  },
  {
    file: 'App.tsx', to: 'setStageCredentialCaller', count: 1, kind: 'stage',
    reason: 'Lends a stage copy the working copy\'s credential and takes it back.',
  },
  {
    file: 'App.tsx', to: 'setSealedReader', count: 1, kind: 'credential',
    reason: 'Decrypts bytes sent inline under the working copy\'s credential; opens no file.',
  },
  {
    file: 'App.tsx', to: 'releaseDocumentCredentials', count: 1, kind: 'credential',
    reason: 'Drops the credential of a working copy that left the window.',
  },
  {
    file: 'components/BatchOcrDialog.tsx', to: 'recognizePage', count: 1, kind: 'outside',
    reason: 'A source read by path.',
  },
  {
    file: 'components/ScanDialog.tsx', to: 'recognizePage', count: 1, kind: 'outside',
    reason: 'The scan output, before it opens.',
  },
  {
    file: 'components/canvas/WorkspaceCanvasView.tsx', to: 'callRaw', count: 1, kind: 'outside',
    reason: 'The canvas OCR selection; it sends a rendered raster inline.',
  },
  {
    file: 'components/canvas/PageTextLayer.tsx', to: 'recognizeRaster', count: 1, kind: 'outside',
    reason: 'A rendered raster sent inline.',
  },
  {
    file: 'components/DiskRedactDialog.tsx', to: 'createDiskRedactIo', count: 1, kind: 'outside',
    reason: 'Files of a folder redacted on disk.',
  },
  {
    file: 'components/FolderCreatePdfDialog.tsx', to: 'listSourceFolders', count: 1, kind: 'outside',
    reason: 'A folder tree the user picked.',
  },
  {
    file: 'components/FolderCreatePdfDialog.tsx', to: 'createFolderCreatePdfIo', count: 1, kind: 'outside',
    reason: 'The folder Create PDF sweep over a picked tree.',
  },
  {
    file: 'components/FolderExportDialog.tsx', to: 'createFolderExportIo', count: 1, kind: 'outside',
    reason: 'Files of a folder exported into an output tree.',
  },
  {
    file: 'components/FolderFormPrepDialog.tsx', to: 'createFolderPrepIo', count: 1, kind: 'outside',
    reason: 'Files of a folder prepared into an output tree.',
  },
  {
    file: 'components/FolderPreflightDialog.tsx', to: 'createFolderPreflightIo', count: 1, kind: 'outside',
    reason: 'A folder tree the user picked.',
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function propertyName(name: ts.PropertyName | ts.JsxAttributeName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** A reference to the raw transport: `callRaw` or one of its aliases,
 * `x.callRaw`, or `x['callRaw']`. Declaration names are not references. */
function isRawRef(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) {
    if (!names.has(node.text)) return false;
    const parent = node.parent;
    if (!parent) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)
      || ts.isMethodDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)
      || ts.isFunctionDeclaration(parent)) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;
    if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
    return true;
  }
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'callRaw';
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    return ts.isStringLiteralLike(arg) && arg.text === 'callRaw';
  }
  return false;
}

/** The expression a reference stands in once parentheses, casts, non-null
 * assertions and the arms of a conditional are seen through. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return current;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)
      || (ts.isConditionalExpression(parent) && parent.condition !== current)
      || (ts.isBinaryExpression(parent) && parent.right === current
        && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))) {
      current = parent;
      continue;
    }
    return current;
  }
}

const HOOKS_WITH_DEPS = new Set(['useCallback', 'useMemo', 'useEffect', 'useLayoutEffect']);

function calleeText(call: ts.CallExpression, source: ts.SourceFile): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return callee.getText(source);
}

/** `callRaw` and every local bound to it: `{ callRaw: x }` destructured, or
 * `const x = <reference>`, to a fixed point. */
function aliases(source: ts.SourceFile): Set<string> {
  const names = new Set(['callRaw']);
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node: ts.Node): void => {
      let bound: string | undefined;
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)
        && (node.propertyName ? propertyName(node.propertyName as ts.PropertyName) : node.name.text) === 'callRaw') {
        bound = node.name.text;
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        const refs: ts.Node[] = [];
        const collect = (n: ts.Node): void => {
          if (isRawRef(n, names) && outermost(n) === init) refs.push(n);
          ts.forEachChild(n, collect);
        };
        collect(init);
        if (refs.length > 0) bound = node.name.text;
      }
      if (bound && !names.has(bound)) {
        names.add(bound);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

interface Found {
  sites: Map<string, number>;
  handoffs: Map<string, number>;
  /** References that are neither a call, a hand-off, an alias nor a hook
   * dependency: each one is a use this roster cannot classify. */
  unclassified: string[];
}

function scanSource(file: string, text: string, found: Found): void {
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const names = aliases(source);
  const visit = (node: ts.Node): void => {
    if (isRawRef(node, names)) {
      const use = outermost(node);
      const parent = use.parent;
      if (parent && ts.isCallExpression(parent) && parent.expression === use) {
        const first = parent.arguments[0];
        const method = first && ts.isStringLiteralLike(first) ? first.text : first?.getText(source) ?? '';
        bump(found.sites, `${file} ${method}`);
      } else if (parent && ts.isCallExpression(parent) && parent.arguments.some(arg => arg === use)) {
        bump(found.handoffs, `${file} ${calleeText(parent, source)}`);
      } else if (parent && ts.isPropertyAssignment(parent) && parent.initializer === use) {
        bump(found.handoffs, `${file} ${propertyName(parent.name) ?? parent.name.getText(source)}`);
      } else if (parent && ts.isShorthandPropertyAssignment(parent)) {
        bump(found.handoffs, `${file} ${parent.name.text}`);
      } else if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
        bump(found.handoffs, `${file} ${propertyName(parent.parent.name) ?? parent.parent.name.getText(source)}`);
      } else if (parent && (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === use))) {
        bump(found.handoffs, `${file} return`);
      } else if (parent && ts.isVariableDeclaration(parent) && parent.initializer === use) {
        // An alias: its own references are classified where they are used.
      } else if (parent && ts.isArrayLiteralExpression(parent) && parent.parent
        && ts.isCallExpression(parent.parent) && HOOKS_WITH_DEPS.has(calleeText(parent.parent, source))) {
        // A hook dependency list.
      } else {
        found.unclassified.push(`${file}: ${(parent ?? use).getText(source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scan(): Found {
  const found: Found = { sites: new Map(), handoffs: new Map(), unclassified: [] };
  for (const full of sourceFiles(RENDERER)) {
    const file = relative(RENDERER, full).split(sep).join('/');
    if (file === 'hooks/useEngine.ts') continue;
    const text = readFileSync(full, 'utf8');
    if (!text.includes('allRaw')) continue;
    scanSource(file, text, found);
  }
  return found;
}

function scanFixture(text: string): Found {
  const found: Found = { sites: new Map(), handoffs: new Map(), unclassified: [] };
  scanSource('fixture.tsx', text, found);
  return found;
}

function listed(entries: readonly { file: string; count: number }[], key: (e: never) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of entries) {
    const k = key(entry as never);
    expect(out.has(k), `listed twice: ${k}`).toBe(false);
    out.set(k, entry.count);
  }
  return out;
}

const sorted = (map: Map<string, number>): [string, number][] => [...map].sort(([a], [b]) => a.localeCompare(b));

/** The only hand-offs that name a working copy for its credential alone. */
const CREDENTIAL_HANDOFFS = new Set(['App.tsx setSealedReader', 'App.tsx releaseDocumentCredentials']);

describe('callRaw sites', () => {
  const found = scan();

  it('finds sites to classify', () => {
    expect(found.sites.size).toBeGreaterThan(20);
    expect(found.handoffs.size).toBeGreaterThan(5);
  });

  it('lists every callRaw call, by file and method', () => {
    const roster = listed(SITES, (e: Site) => `${e.file} ${e.method}`);
    expect(sorted(found.sites)).toEqual(sorted(roster));
  });

  it('lists every place callRaw is handed to other code, by file and receiver', () => {
    const roster = listed(HANDOFFS, (e: Handoff) => `${e.file} ${e.to}`);
    expect(sorted(found.handoffs)).toEqual(sorted(roster));
  });

  it('classifies every reference to callRaw', () => {
    expect(found.unclassified).toEqual([]);
  });

  it('gives every entry a target kind and a reason', () => {
    for (const entry of [...SITES, ...HANDOFFS]) {
      expect(['commit', 'stage', 'outside', 'credential']).toContain(entry.kind);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('allows the credential kind only for the two credential hand-offs', () => {
    expect(SITES.filter(e => e.kind === 'credential')).toEqual([]);
    const credential = HANDOFFS.filter(e => e.kind === 'credential').map(e => `${e.file} ${e.to}`);
    expect(credential.sort()).toEqual([...CREDENTIAL_HANDOFFS].sort());
  });

  it('never reads the Sanitize audit through callRaw', () => {
    for (const entry of [...SITES, ...HANDOFFS]) {
      expect(entry.file).not.toBe('panels/SanitizePanel.tsx');
    }
    const keys = [...found.sites.keys(), ...found.handoffs.keys()];
    expect(keys.filter(k => k.startsWith('panels/SanitizePanel.tsx '))).toEqual([]);
  });
});

describe('the callRaw scan sees every spelling', () => {
  it('a local alias', () => {
    const f = scanFixture("const raw = callRaw;\nvoid raw('alias_method', {});\n");
    expect(sorted(f.sites)).toEqual([['fixture.tsx alias_method', 1]]);
  });

  it('a property of useEngine() bound to a local', () => {
    const f = scanFixture("const r = useEngine().callRaw;\nvoid r('engine_property', {});\n");
    expect(sorted(f.sites)).toEqual([['fixture.tsx engine_property', 1]]);
  });

  it('a renamed destructuring', () => {
    const f = scanFixture("const { callRaw: r } = useEngine();\nvoid r('renamed', {});\n");
    expect(sorted(f.sites)).toEqual([['fixture.tsx renamed', 1]]);
  });

  it('a JSX prop', () => {
    const f = scanFixture('const el = <Panel run={callRaw} />;\n');
    expect(sorted(f.handoffs)).toEqual([['fixture.tsx run', 1]]);
  });

  it('a return value', () => {
    const f = scanFixture('function pick() { return callRaw; }\nconst arrow = () => callRaw;\n');
    expect(sorted(f.handoffs)).toEqual([['fixture.tsx return', 2]]);
  });

  it('a conditional arm bound to a local', () => {
    const f = scanFixture("const t = flag ? callRaw : call;\nvoid t('ternary', {});\n");
    expect(sorted(f.sites)).toEqual([['fixture.tsx ternary', 1]]);
  });

  it('a cast passed as an argument', () => {
    const f = scanFixture('register(callRaw as EngineCall);\nregister((callRaw)!);\n');
    expect(sorted(f.handoffs)).toEqual([['fixture.tsx register', 2]]);
  });

  it('an element access by name', () => {
    const f = scanFixture("void engine['callRaw']('element_access', {});\n");
    expect(sorted(f.sites)).toEqual([['fixture.tsx element_access', 1]]);
  });

  it('a use that fits no form is reported, not dropped', () => {
    const f = scanFixture('let slot: unknown;\nslot = callRaw;\n');
    expect(f.unclassified).toEqual(['fixture.tsx: slot = callRaw']);
  });

  it('a hook dependency list is not a use', () => {
    const f = scanFixture('const cb = useCallback(() => 1, [callRaw]);\n');
    expect(f).toEqual({ sites: new Map(), handoffs: new Map(), unclassified: [] });
  });
});
