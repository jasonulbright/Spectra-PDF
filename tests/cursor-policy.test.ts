import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITING_ATTRIBUTE } from '../src/renderer/lib/editing-marker';

// The pointing hand appears only on what follows a link in a PDF's content:
// link regions and form pushbuttons. Every other button, tab and tile uses the
// arrow, or grab/move/resize where the thing really is dragged. See the policy
// block at the end of src/renderer/styles.css.

const HAND_ALLOWED = ['.page-link-region', '.page-form-button'];

const ROOT = join(__dirname, '..', 'src', 'renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'locales') continue;
      walk(p, out);
    } else if (['.ts', '.tsx', '.css'].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

const HAND_DECL = /cursor\s*:\s*pointer\b/;

/** Block comments blanked to spaces, so line numbers and offsets survive. */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/** Every rule whose declarations take the hand and whose selector list names
 * anything outside the allowed rules. A selector list is judged whole: `.a,
 * .page-link-region { cursor: pointer }` gives the hand to `.a` as well. */
export function cssOffenders(text: string): string[] {
  const out: string[] = [];
  const clean = stripBlockComments(text);
  for (const m of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!HAND_DECL.test(m[2])) continue;
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const bad = selectors.filter((s) => !HAND_ALLOWED.includes(s));
    if (bad.length === 0) continue;
    const start = (m.index ?? 0) + (m[1].length - m[1].trimStart().length);
    const line = clean.slice(0, start).split('\n').length;
    out.push(`${line}: ${bad.join(', ')}`);
  }
  return out;
}

/** Every line of script that sets the hand: a Tailwind class, an inline style
 * value, a DOM style assignment, or a conditional that yields it. */
export function scriptOffenders(text: string): string[] {
  const out: string[] = [];
  stripBlockComments(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)\/\/.*$/, '$1');
    if (
      /\bcursor-pointer\b/.test(line)
      || /cursor['"`]?\s*[:=]\s*['"`]pointer['"`]/.test(line)
      || /cursor\b[^\n]*\?[^\n]*['"`]pointer['"`]/.test(line)
    ) {
      out.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

type Specificity = [number, number, number];

function compareSpecificity(x: Specificity, y: Specificity): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[') depth++;
    else if (s[i] === ')' || s[i] === ']') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Selectors Level 4 specificity of one complex selector: `:is()` and
 * `:not()` count their most specific argument, `:where()` counts nothing. */
function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  const add = (s: Specificity) => {
    total[0] += s[0];
    total[1] += s[1];
    total[2] += s[2];
  };
  let i = 0;
  while (i < selector.length) {
    const rest = selector.slice(i);
    const fn = /^:(is|not|where|matches)\(/.exec(rest);
    if (fn) {
      let depth = 1;
      let j = fn[0].length;
      while (depth > 0) {
        if (rest[j] === '(') depth++;
        else if (rest[j] === ')') depth--;
        j++;
      }
      if (fn[1] !== 'where') {
        const args = splitTopLevel(rest.slice(fn[0].length, j - 1)).map(specificity);
        add(args.reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m), [0, 0, 0]));
      }
      i += j;
      continue;
    }
    const m = /^(::[\w-]+|#[\w-]+|\.[\w-]+|:[\w-]+|\[[^\]]*\]|[a-zA-Z][\w-]*|\*|[\s>+~]+)/.exec(rest);
    if (!m) throw new Error(`cannot read selector at: ${rest}`);
    const t = m[0];
    if (t.startsWith('::')) add([0, 0, 1]);
    else if (t.startsWith('#')) add([1, 0, 0]);
    else if (t.startsWith('.') || t.startsWith('[') || t.startsWith(':')) add([0, 1, 0]);
    else if (/^[a-zA-Z]/.test(t)) add([0, 0, 1]);
    i += t.length;
  }
  return total;
}

const TEXTLESS_INPUTS = ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image'];

// Each opts a reader's text in: a comparison's changed text, a link's target,
// a measurement, a signature's failure, an operation's failure.
const SELECTABLE_REGIONS = [
  'components/canvas/SecondaryToolbar.tsx',
  'components/navpane/SignaturesNavPanel.tsx',
  'components/OperationQueue.tsx',
  'panels/ComparePanel.tsx',
  'panels/LinksPanel.tsx',
];

interface CssRule {
  at: number;
  selector: string;
  body: string;
}

function selectionPolicy(): { rules: CssRule[]; optIn: CssRule; optOut: CssRule } {
  const css = stripBlockComments(readFileSync(join(ROOT, 'styles.css'), 'utf8').replace(/\r\n/g, '\n'));
  const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    at: m.index ?? 0,
    selector: m[1].trim().replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'),
    body: m[2],
  }));
  const optIn = rules.find((r) => r.selector.startsWith(':root :is(') && /user-select:\s*text/.test(r.body));
  const optOut = rules.find((r) => r.selector.startsWith(':root :is(') && /user-select:\s*none/.test(r.body));
  expect(optIn).toBeDefined();
  expect(optOut).toBeDefined();
  return { rules, optIn: optIn!, optOut: optOut! };
}

/** A rule body's declarations, property to value. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return out;
}

/** The top-level arguments of the one `:is()` a policy selector holds. */
function isArguments(selector: string): string[] {
  const open = selector.indexOf(':is(');
  return splitTopLevel(selector.slice(open + 4, selector.lastIndexOf(')')));
}

describe('cursor policy', () => {
  it('only PDF link regions and form pushbuttons take the pointing hand', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const hits = file.endsWith('.css') ? cssOffenders(text) : scriptOffenders(text);
      for (const hit of hits) offenders.push(`${file.slice(ROOT.length + 1)}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner reads rules, not lines or comments', () => {
    expect(cssOffenders('/* .x { cursor: pointer } */\n.page-link-region {\n  cursor: pointer;\n}')).toEqual([]);
    expect(cssOffenders('.page-link-region,\n.page-form-button {\n  cursor: pointer;\n}')).toEqual([]);
    expect(cssOffenders('.thumb,\n.page-link-region {\n  cursor: pointer;\n}')).toEqual(['1: .thumb']);
    expect(cssOffenders('@media (hover: hover) {\n  .tab { cursor: pointer; }\n}')).toEqual(['2: .tab']);
    expect(cssOffenders('.page-link-region:hover { cursor: pointer; }')).toEqual(['1: .page-link-region:hover']);
    expect(scriptOffenders('// cursor-pointer is gone\nconst a = 1;')).toEqual([]);
    expect(scriptOffenders('/* cursor: \'pointer\' */')).toEqual([]);
    expect(scriptOffenders('<b className="flex cursor-pointer" />')).toHaveLength(1);
    expect(scriptOffenders('style={{ cursor: "pointer" }}')).toHaveLength(1);
    expect(scriptOffenders("el.style.cursor = 'pointer';")).toHaveLength(1);
    expect(scriptOffenders("cursor: movable ? 'move' : 'pointer',")).toHaveLength(1);
    expect(scriptOffenders("pointerEvents: 'auto', cursor: 'default'")).toEqual([]);
  });

  it('the allowed rules do take the hand', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    for (const sel of HAND_ALLOWED) {
      const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*\\}'));
      expect(m, sel).not.toBeNull();
      expect(m![0], sel).toMatch(HAND_DECL);
    }
  });

  it('page tiles on the board are the open hand, and the closed hand while carried', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.canvas-view \.page \{[^}]*cursor:\s*grab;/);
    expect(css).toMatch(/\.canvas-view\.dragging \.page \{[^}]*cursor:\s*grabbing;/);
    const view = readFileSync(join(ROOT, 'components', 'canvas', 'WorkspaceCanvasView.tsx'), 'utf8');
    expect(view).toMatch(/drag\.draggingPage \? ' dragging' : ''/);
  });

  it('select-none inside an opted-in region outranks the opt-in, and comes after it', () => {
    const { optIn, optOut } = selectionPolicy();
    expect(optOut.selector).toContain('.select-none');
    expect(optOut.at).toBeGreaterThan(optIn.at);
    expect(compareSpecificity(specificity(optOut.selector), specificity(optIn.selector))).toBeGreaterThanOrEqual(0);
    // The opt-in outranks a Tailwind select-none (0,1,0) under the root,
    // which is why the opt-out exists.
    expect(compareSpecificity(specificity(optIn.selector), specificity(':root .select-none'))).toBeGreaterThan(0);
  });

  it('the policy starts at the root, so menus and dialogs outside the shell follow it', () => {
    const { rules, optIn, optOut } = selectionPolicy();
    const base = rules.find((r) => r.selector === ':root' && /user-select:\s*none/.test(r.body));
    expect(base).toBeDefined();
    expect(base!.at).toBeLessThan(optIn.at);
    expect(optIn.selector.startsWith(':root :is(')).toBe(true);
    expect(optOut.selector.startsWith(':root :is(')).toBe(true);
    // Nothing else turns text back on for a whole region outside the opt-in.
    const others = rules.filter((r) => /user-select:\s*(text|auto|all)/.test(r.body) && r !== optIn);
    expect(others.map((r) => r.selector)).toEqual(['.textLayer :is(span, br)']);
  });

  it('a control with no text to copy never opts in, inside any region', () => {
    const { optIn, optOut } = selectionPolicy();
    const optInArgs = isArguments(optIn.selector);
    expect(optInArgs).not.toContain('select');
    const input = optInArgs.find((a) => a.startsWith('input'));
    expect(input, 'the opt-in names text entries only').toBeDefined();
    for (const type of TEXTLESS_INPUTS) expect(input).toContain(`[type='${type}']`);
    const optOutArgs = isArguments(optOut.selector);
    for (const control of ['button', "[role='button']", 'select', 'select *']) {
      expect(optOutArgs).toContain(control);
    }
    const textless = optOutArgs.find((a) => a.startsWith('input:is('));
    expect(textless).toBeDefined();
    for (const type of TEXTLESS_INPUTS) expect(textless).toContain(`[type='${type}']`);
  });

  it('a text field that is not being edited paints no selection, over every other highlight rule', () => {
    const { rules } = selectionPolicy();
    const editing = `[${EDITING_ATTRIBUTE}]`;
    const quiet = rules.find((r) => r.selector.includes(`:root :is(input, textarea):not(:focus, ${editing})::selection`));
    expect(quiet).toBeDefined();
    const selectors = splitTopLevel(quiet!.selector);
    expect(selectors).toEqual([
      `:root :is(input, textarea):not(:focus, ${editing})::selection`,
      `:root [contenteditable]:not([contenteditable='false']):not(:focus-within, ${editing})::selection`,
      `:root [contenteditable]:not([contenteditable='false']):not(:focus-within, ${editing}) *::selection`,
    ]);
    const others = rules.filter((r) => r !== quiet && /::selection/.test(r.selector));
    // It changes nothing: the highlight is transparent and the text keeps its
    // own colour.
    const declared = declarations(quiet!.body);
    expect(declared.get('background-color')).toBe('transparent');
    expect(declared.get('color')).toBe('currentColor');
    // It sets every property any other highlight rule sets, or that rule's
    // value shows through on the field (the high-contrast text colour).
    // The `background` shorthand sets only the colour in a highlight.
    const longhand = (p: string): string => (p === 'background' ? 'background-color' : p);
    const setHere = new Set([...declared.keys()].map(longhand));
    const setElsewhere = new Set(others.flatMap((r) => [...declarations(r.body).keys()].map(longhand)));
    expect([...setElsewhere].sort()).toEqual(expect.arrayContaining(['background-color', 'color']));
    expect([...setElsewhere].filter((p) => !setHere.has(p))).toEqual([]);
    // Every other highlight rule that can reach a field: a universal
    // `::selection`, under a theme or not. The field rule must outrank each.
    const universal = others
      .flatMap((r) => splitTopLevel(r.selector))
      .filter((s) => /(^|\s)(\*)?::selection$/.test(s));
    expect(universal.length).toBeGreaterThan(0);
    for (const other of universal) {
      expect(compareSpecificity(specificity(selectors[0]), specificity(other)), other).toBeGreaterThan(0);
    }
  });

  it('the property check reads every declaration of a rule', () => {
    expect([...declarations(' background: red;\n  color: #000000 ').entries()])
      .toEqual([['background', 'red'], ['color', '#000000']]);
  });

  it('every `.selectable` region is content a reader copies', () => {
    const uses: string[] = [];
    for (const file of walk(ROOT)) {
      if (!file.endsWith('.tsx')) continue;
      const text = stripBlockComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
      text.split('\n').forEach((line, i) => {
        if (/className=[^\n]*['"`{ ]selectable[ '"`}]/.test(line)) uses.push(`${file.slice(ROOT.length + 1).replace(/\\/g, '/')}:${i + 1}`);
      });
    }
    expect([...new Set(uses.map((u) => u.replace(/:\d+$/, '')))].sort()).toEqual([...SELECTABLE_REGIONS].sort());
  });

  it('error text opts in by its own class token, never by a hover variant', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    expect(css).not.toContain("[class*='text-red-']");
    expect(css).toContain("[class^='text-red-'], [class*=' text-red-']");
  });

  it('the specificity helper agrees with the selectors spec', () => {
    expect(specificity('.a')).toEqual([0, 1, 0]);
    expect(specificity('.a :is(b, .c, [d]:not([e]))')).toEqual([0, 3, 0]);
    expect(specificity('#x div::before')).toEqual([1, 0, 2]);
    expect(specificity(':where(.a, #b) *')).toEqual([0, 0, 0]);
  });

  it('the find bar is the open hand where it moves, and its controls are not', () => {
    const { rules } = selectionPolicy();
    const rule = (selector: string) => rules.find((r) => splitTopLevel(r.selector).includes(selector));
    const grab = rule('.find-bar .find-bar-grip');
    expect(grab?.body).toMatch(/cursor:\s*grab;/);
    expect(grab?.body).toMatch(/touch-action:\s*none;/);
    expect(splitTopLevel(grab!.selector)).toContain('.find-bar');
    const controls = rule('.find-bar :is(button:not(.find-bar-grip), select)');
    expect(controls?.body).toMatch(/cursor:\s*default;/);
    // A field and copyable error text take the text cursor: a press there
    // edits or selects, never moves the bar.
    expect(rule(".find-bar :is(input, .selectable, [class^='text-red-'], [class*=' text-red-'])")?.body)
      .toMatch(/cursor:\s*auto;/);
    const carried = rule(':root .find-bar.moving *');
    expect(carried?.body).toMatch(/cursor:\s*grabbing;/);
    expect(compareSpecificity(specificity(':root .find-bar.moving *'), specificity(controls!.selector))).toBeGreaterThan(0);
    const bar = readFileSync(join(ROOT, 'components', 'canvas', 'FindBar.tsx'), 'utf8');
    // A press on text the policy makes copyable starts no move.
    const copyable = isArguments(selectionPolicy().optIn.selector)
      .filter((a) => a.startsWith('.selectable') || a.includes('text-red-'))
      .filter((a) => !a.endsWith(' *'));
    expect(copyable).toEqual(['[class^=\'text-red-\']', '[class*=\' text-red-\']', '.selectable']);
    expect(bar).toContain(`const COPYABLE = "${['.selectable', ...copyable.slice(0, 2)].join(', ')}";`);
    expect(bar).toMatch(/moving \? ' moving' : ''/);
    expect(bar).toMatch(/className="find-bar-grip /);
  });

  it('a reading-view page takes the pane cursor, so it is not the hand under Select', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.docview-scroll \.page \{[^}]*cursor:\s*inherit;/);
    const at = (re: RegExp) => css.search(re);
    expect(at(/\.docview-scroll \.page \{/)).toBeGreaterThan(at(/\.canvas-view \.page \{/));
  });
});
