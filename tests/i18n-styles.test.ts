// The chrome mirrors under a right-to-left UI language, and it mirrors
// because its directional declarations are LOGICAL (`margin-inline-start`,
// `inset-inline-end`, `text-align: start`) rather than physical. A grep is not
// a gate: the next feature that adds a physical `margin-left` to a panel would
// pass every other test in this repo and simply not mirror.
//
// So the stylesheet is read here and every surviving PHYSICAL directional
// declaration must belong to a selector on the exception list below — the
// reviewed inventory of what deliberately does NOT mirror. The governing
// distinction: chrome is text flow and mirrors; the CANVAS is page geometry
// and does not. A page's top-left corner is its top-left corner in every
// language, and a north-west resize handle is geometrically north-west —
// mirroring it would make the handle under the pointer resize the opposite
// edge.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RENDERER = resolve(__dirname, '../src/renderer');
const CSS_PATH = join(RENDERER, 'styles.css');

/**
 * Selectors allowed to keep a physical `left`/`right` declaration, with the
 * reason each one is page geometry rather than chrome. Adding a row is a
 * design decision: it asserts that the surface is positioned against the
 * DOCUMENT, not against the reader's text flow.
 */
const PHYSICAL_EXCEPTIONS: Record<string, string> = {
  // The canvas coordinate space is the document's, not the reader's.
  '.canvas-world': 'canvas world origin',
  '.canvas-overlay': 'canvas world origin',
  '.dashed-border': 'canvas world origin',
  // Positioned against a PAGE, whose corners do not move with the UI language.
  '.pageview-detail': 'page-anchored overlay',
  '.page-number': 'page-anchored overlay',
  '.page-annot-x': 'page-anchored overlay',
  '.page-annot-recolor': 'page-anchored overlay',
  '.page-edittext-error': 'page-anchored overlay',
  '.page-edittext-convert': 'page-anchored overlay',
  '.page-crop-label': 'page-anchored overlay',
  '.page-editpara-resize-readout': 'page-anchored overlay',
  // Annotation text is DOCUMENT text: its alignment is the document's
  // property and must not follow the UI language.
  '.page-annot-text-body': 'document text alignment',
  // A compass handle is geometrically named. Mirroring it would make the
  // handle under the pointer resize the opposite edge.
  '.page-editpara-grip.grip-left': 'compass resize handle',
  '.page-editpara-grip.grip-right': 'compass resize handle',
  '.page-editpara-grip.grip-bottom': 'compass resize handle',
  '.annot-handle-nw': 'compass resize handle',
  '.annot-handle-n': 'compass resize handle',
  '.annot-handle-ne': 'compass resize handle',
  '.annot-handle-e': 'compass resize handle',
  '.annot-handle-se': 'compass resize handle',
  '.annot-handle-s': 'compass resize handle',
  '.annot-handle-sw': 'compass resize handle',
  '.annot-handle-w': 'compass resize handle',
  '.page-candidate-handle.is-nw': 'compass resize handle',
  '.page-candidate-handle.is-ne': 'compass resize handle',
  '.page-candidate-handle.is-sw': 'compass resize handle',
  '.page-candidate-handle.is-se': 'compass resize handle',
  '.page-table-handle.is-nw': 'compass resize handle',
  '.page-table-handle.is-ne': 'compass resize handle',
  '.page-table-handle.is-sw': 'compass resize handle',
  '.page-table-handle.is-se': 'compass resize handle',
  // A table's column and row lines span the table in page space. Their
  // positions come from the detector's own coordinates, already turned to
  // match the page's rotation, so mirroring them would turn them twice.
  '.page-table-row.is-y': 'page-anchored overlay',
  '.page-table-column.is-x': 'page-anchored handle centring',
  '.page-table-column.is-y': 'page-anchored overlay',
  // The reading view's own flow: the ruler grid starts at the page origin and
  // a spread pairs by the document's binding, so the frame does not mirror.
  '.docview-frame': 'reading-view page geometry',
  // A ruler measures page geometry from the page origin; ticks, labels and
  // the cursor stay in page order. Guides are drawn in the same space.
  '.docview-ruler-corner': 'ruler geometry',
  '.docview-ruler-v': 'ruler geometry',
  '.docview-ruler-h .ruler-tick': 'ruler geometry',
  '.docview-ruler-v .ruler-tick': 'ruler geometry',
  '.docview-ruler-h .ruler-label': 'ruler geometry',
  '.docview-ruler-v .ruler-label': 'ruler geometry',
  '.docview-ruler-v .ruler-cursor': 'ruler geometry',
  '.docview-guide-draft.axis-y': 'guide geometry',
  '.page-guide-x': 'guide geometry',
  '.page-guide-x::before': 'guide geometry',
  '.page-guide-y': 'guide geometry',
  '.page-guide-y::before': 'guide geometry',
  // Negative half-size margins centring a handle ON a point in page space.
  '.page-imgtx-rotate': 'page-anchored handle centring',
  '.page-imgtx-skew': 'page-anchored handle centring',
  '.page-imgtx-maskdot': 'page-anchored handle centring',
  '.page-imgtx-crophandle': 'page-anchored handle centring',
  '.annot-vertex': 'page-anchored handle centring',
  // Notation, not prose: a path, a URL or a key chord keeps its own order
  // inside a right-to-left line.
  '.ltr-notation': 'forced-LTR notation',
};

const PHYSICAL =
  /(^|[;{\s])(margin|padding|border|scroll-margin|scroll-padding)-(left|right)\b|(^|[;{\s])(left|right)\s*:|text-align\s*:\s*(left|right)\b|direction\s*:\s*(ltr|rtl)\b/;

interface Declaration {
  line: number;
  selector: string;
  text: string;
}

/** Every physical directional declaration in the stylesheet, with the
 * selector that owns it. A rule written entirely on one line carries its own
 * selector; only a rule that OPENS a block sets the enclosing one. */
function physicalDeclarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  let selector = '';
  let depth = 0;
  for (const [i, raw] of css.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const oneLine = /^([^{}]+)\{(.*)\}\s*$/.exec(line);
    if (oneLine) {
      if (PHYSICAL.test(oneLine[2])) {
        out.push({ line: i + 1, selector: oneLine[1].trim(), text: line });
      }
      continue;
    }
    if (line.endsWith('{')) {
      if (depth === 0) selector = line.slice(0, -1).trim();
      depth++;
      continue;
    }
    if (line.startsWith('}')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (PHYSICAL.test(line)) out.push({ line: i + 1, selector, text: line });
  }
  return out;
}

/** An asymmetric four-value shorthand pins an indent to a physical side
 * exactly as `padding-left` does, and no `left`/`right` grep sees it. */
function asymmetricShorthands(css: string): Declaration[] {
  const out: Declaration[] = [];
  let selector = '';
  let depth = 0;
  for (const [i, raw] of css.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const oneLine = /^([^{}]+)\{(.*)\}\s*$/.exec(line);
    const body = oneLine ? oneLine[2] : line;
    if (!oneLine) {
      if (line.endsWith('{')) {
        if (depth === 0) selector = line.slice(0, -1).trim();
        depth++;
        continue;
      }
      if (line.startsWith('}')) {
        depth = Math.max(0, depth - 1);
        continue;
      }
    }
    for (const m of body.matchAll(/\b(padding|margin|inset)\s*:\s*([^;}]+)/g)) {
      const parts = m[2].trim().split(/\s+/);
      if (parts.length === 4 && parts[1] !== parts[3]) {
        out.push({
          line: i + 1,
          selector: oneLine ? oneLine[1].trim() : selector,
          text: m[0].trim(),
        });
      }
    }
  }
  return out;
}

/** A selector matches an exception when the exception is one of the compound
 * selectors it lists (`a, b { … }` is two rules sharing a body). */
function allowed(selector: string): boolean {
  return selector
    .split(',')
    .map((s) => s.trim())
    .every((s) => s in PHYSICAL_EXCEPTIONS);
}

describe('chrome stylesheet direction', () => {
  const css = readFileSync(CSS_PATH, 'utf8');

  it('keeps a physical left/right only where the surface is page geometry', () => {
    const offenders = physicalDeclarations(css).filter((d) => !allowed(d.selector));
    expect(
      offenders.map((d) => `${d.selector} (line ${d.line}): ${d.text}`),
      'physical directional declaration on a chrome surface — use the logical property, or add the selector to PHYSICAL_EXCEPTIONS with its reason',
    ).toEqual([]);
  });

  it('keeps an asymmetric padding/margin shorthand only where the surface is page geometry', () => {
    const offenders = asymmetricShorthands(css).filter((d) => !allowed(d.selector));
    expect(
      offenders.map((d) => `${d.selector} (line ${d.line}): ${d.text}`),
      'asymmetric shorthand pins an indent to a physical side — split it into padding-block/padding-inline',
    ).toEqual([]);
  });

  it('catches a physical declaration on a selector it does not know', () => {
    // The detector proved, not merely its silence: a lint that matched
    // nothing would pass the two tests above forever.
    const injected = '.some-new-panel {\n  margin-left: 4px;\n}\n';
    expect(physicalDeclarations(injected).filter((d) => !allowed(d.selector))).toHaveLength(1);
  });

  it('finds every exception selector in the stylesheet', () => {
    // A stale exception is how an exception list stops being read: the
    // selector was renamed, the rule became logical, and the row now silently
    // permits a physical declaration somewhere else.
    const used = new Set(
      [...physicalDeclarations(css), ...asymmetricShorthands(css)].flatMap((d) =>
        d.selector.split(',').map((s) => s.trim()),
      ),
    );
    expect(
      Object.keys(PHYSICAL_EXCEPTIONS).filter((s) => !used.has(s)),
      'exception selector no longer carries a physical declaration',
    ).toEqual([]);
  });
});

/** Tailwind v4 ships the logical utilities (`ms-* me-* ps-* pe-* start-*
 * end-* border-s text-start text-end`) and they honour `dir` with no
 * configuration, so a physical one in the chrome is always a miss. The
 * fraction forms are CENTRING (`left-1/2` pairs with the physical
 * `-translate-x-1/2`); converting them breaks the centre under both
 * directions, which is why they are excluded rather than listed. */
const PHYSICAL_UTILITY =
  /(^|[\s"'`{])(ml|mr|pl|pr)-(auto|[\d.]+)(?![\w./-])|(^|[\s"'`{])(left|right)-[\d.]+(?![\w./-])|(^|[\s"'`{])text-(left|right)(?![\w-])|(^|[\s"'`{])border-[lr]-[\d.]+(?![\w./-])/;

function* tsxFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

describe('chrome markup direction', () => {
  it('uses no physical Tailwind directional utility', () => {
    const offenders: string[] = [];
    for (const p of tsxFiles(RENDERER)) {
      for (const [i, line] of readFileSync(p, 'utf8').split(/\r?\n/).entries()) {
        if (PHYSICAL_UTILITY.test(line)) {
          offenders.push(`${relative(RENDERER, p)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'physical directional utility in the chrome — use the logical one (ms/me/ps/pe/start/end/border-s/text-start/text-end)',
    ).toEqual([]);
  });

  it('catches a physical utility the chrome does not use', () => {
    expect(PHYSICAL_UTILITY.test('<div className="ml-4 text-left" />')).toBe(true);
    expect(PHYSICAL_UTILITY.test('<div className="left-1/2 -translate-x-1/2" />')).toBe(false);
  });
});
