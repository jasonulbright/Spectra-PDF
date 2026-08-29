// Checkboxes, radios and selects are themed by ONE element-level layer in
// `styles.css`, not per panel. The distinction is the whole point: an element
// selector themes a control that does not exist yet, and a per-panel opt-in
// themes only the panels somebody remembered. The product shipped #FFFFFF
// unchecked boxes and Chromium's #0075FF checked fill across ten surfaces
// because every panel was an opt-in nobody took.
//
// The i18n-styles suite guards DIRECTION (logical vs physical properties) and
// nothing else, so this convention gets its own gate rather than a row there.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Line endings are normalized: the repo's `.gitattributes` can hand this file
// over with CRLF, and a multi-line selector list would then never match.
const CSS = readFileSync(join(resolve(__dirname, '../src/renderer'), 'styles.css'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** The bodies of every rule whose selector list is exactly `selectors`, joined.
 * Every rule, not the first: a token block declared once per theme repeats the
 * same selector, and reading only the first would test the wrong one. */
function ruleBody(css: string, selectors: string[]): string | null {
  const escaped = selectors.join(',\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return found.length ? found.map((m) => m[1]).join('\n') : null;
}

describe('native form controls are themed once, at element level', () => {
  it('draws the checkbox and radio box itself rather than trusting the platform', () => {
    const body = ruleBody(CSS, ['input[type="checkbox"]', 'input[type="radio"]']);
    expect(body, 'the shared checkbox/radio rule is gone or its selector changed').not.toBeNull();
    expect(body).toMatch(/appearance:\s*none/);
    expect(body).toMatch(/background:\s*var\(--control-bg\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--control-border\)/);
  });

  it('themes the select at element level too', () => {
    const body = ruleBody(CSS, ['select']);
    expect(body, 'the element-level select rule is gone').not.toBeNull();
    expect(body).toMatch(/appearance:\s*none/);
    expect(body).toMatch(/background-color:\s*var\(--control-bg\)/);
  });

  it('takes the checked fill from the accent, never a literal', () => {
    const body = ruleBody(CSS, [
      'input[type="checkbox"]:checked',
      'input[type="radio"]:checked',
      'input[type="checkbox"]:indeterminate',
    ]);
    expect(body, 'the checked-state rule is gone or its selector changed').not.toBeNull();
    // A hex here is how the browser blue comes back under a different name.
    expect(body).toMatch(/background:\s*var\(--accent,/);
    expect(body).toMatch(/border-color:\s*var\(--accent,/);
  });

  it('defines the control tokens in every theme', () => {
    for (const theme of ['light', 'high-contrast']) {
      const body = ruleBody(CSS, [`[data-theme="${theme}"]`]);
      expect(body, `no control-token block for the ${theme} theme`).not.toBeNull();
      expect(body).toMatch(/--control-bg:/);
      expect(body).toMatch(/--control-border:/);
      expect(body).toMatch(/--control-border-hover:/);
    }
  });

  it('leaves the chevron gutter above a single class', () => {
    // Panel selects carry Tailwind `px-*`, which outranks a bare element rule.
    // Without the lifted gutter the label runs under the chevron everywhere.
    expect(ruleBody(CSS, [':root select'])).toMatch(/padding-inline-end:/);
  });

  it('reads a rule body rather than merely matching the whole file', () => {
    // The reader proved, not its silence: a matcher that returned the file
    // would pass every assertion above forever.
    const css = 'input[type="checkbox"] {\n  appearance: none;\n}\n';
    expect(ruleBody(css, ['input[type="checkbox"]'])).toMatch(/appearance:\s*none/);
    expect(ruleBody(css, ['select'])).toBeNull();
  });
});

describe('the tool strip separates the lock from the armed tool', () => {
  it('gives the locked pill an outline where the armed tool takes a fill', () => {
    const body = ruleBody(CSS, [':root .secondary-toolbar .secondary-tool-lock.active']);
    expect(body, 'the lock override is gone — it would take the armed-tool fill').not.toBeNull();
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/box-shadow:\s*inset 0 0 0 1px/);
  });

  it('gives every strip button a box, armed or not', () => {
    // X6: only the active item used to carry a pill, so the other eight were
    // bare text and the strip read as a breadcrumb trail. The border is on the
    // RESTING state, which is also what keeps arming a tool from resizing it.
    const body = ruleBody(CSS, ['.secondary-tool']);
    expect(body, 'the strip button rule is gone or its selector changed').not.toBeNull();
    expect(body).toMatch(/border:\s*1px solid var\(--strip-btn-border/);
    expect(body).toMatch(/display:\s*inline-flex/);
  });

  it('pins the strip height so arming a tool cannot move the page', () => {
    // X21: Takeoff's count-group buttons made the strip 40px against 28px
    // everywhere else, so the document jumped 13px entering and leaving that
    // tool. `inline-flex` above keeps a glyph beside its label rather than
    // over it; the floor keeps the box constant regardless.
    expect(ruleBody(CSS, ['.secondary-toolbar'])).toMatch(/min-height:\s*\d+px/);
  });
});

/** Every `--name: #hex;` declaration in a rule body, as a lookup. */
function tokensIn(body: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (body ?? '').matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** WCAG 2.1 relative luminance of an opaque sRGB hex. */
function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const channels = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 2.1 contrast ratio between two opaque sRGB hexes. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The ratios are COMPUTED from the hexes in the stylesheet, not asserted as
// remembered numbers. That is the whole point: a later edit that quiets a
// token back under the threshold fails here rather than shipping and being
// found again by eye. `axe-core` cannot stand in for this — it needs a live
// DOM, and it never sees a token that is only reachable in a theme nobody
// screenshotted.
describe('contrast, computed from the tokens themselves', () => {
  it('reads a colour out of a rule body rather than matching the whole file', () => {
    const found = tokensIn('x { --text-dim: #a0a0a8; --surface-2: #303034; }');
    expect(found['--text-dim']).toBe('#a0a0a8');
    expect(tokensIn(null)).toEqual({});
    // The maths, against a pair whose ratio is fixed by the spec.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('keeps --text-dim at AA on the lightest ground it lands on, in every theme', () => {
    // Dim text sits on the panel/shell AND on `--surface-2` (input fills, the
    // measure strip's controls). The lightest of those decides the value in a
    // dark theme, the darkest in a light one — so the token is checked against
    // its own theme's `--surface-2`, which is declared in the same block.
    const blocks: [string, string[]][] = [
      [':root', ['#171717', '#1f1f1f', '#232327']],
      ['[data-theme="light"]', ['#ffffff', '#f9fafb', '#f3f4f6']],
      ['[data-theme="high-contrast"]', ['#000000', '#0d0d0d']],
    ];
    for (const [selector, grounds] of blocks) {
      const tokens = tokensIn(ruleBody(CSS, [selector]));
      const dim = tokens['--text-dim'];
      expect(dim, `no --text-dim in ${selector}`).toBeDefined();
      for (const ground of [...grounds, tokens['--surface-2']].filter(Boolean)) {
        expect(
          contrast(dim, ground),
          `--text-dim ${dim} on ${ground} (${selector})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the remapped neutral text utilities at AA on a panel', () => {
    // Tailwind's own neutral-500/-600 measure 3.8:1 and 2.0:1 on a dark panel.
    // Both are remapped; the remaps are what this pins.
    for (const utility of ['.text-neutral-500', '.text-neutral-600']) {
      const body = ruleBody(CSS, [`:root ${utility}`]);
      expect(body, `${utility} is no longer remapped for the dark theme`).not.toBeNull();
      const color = (body ?? '').match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
      expect(color, `${utility} remap is not a plain hex any more`).toBeDefined();
      for (const ground of ['#171717', '#1f1f1f', '#232327', '#303034']) {
        expect(contrast(color!, ground), `${utility} ${color} on ${ground}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('keeps a destructive button legible against its own label', () => {
    // The product's red was #d9395f, which measures 4.47:1 against the white
    // it is always drawn with — under AA by a hair, and invisible to review.
    for (const selector of [':root', '[data-theme="light"]']) {
      const tokens = tokensIn(ruleBody(CSS, [selector]));
      expect(tokens['--danger'], `no --danger in ${selector}`).toBeDefined();
      expect(
        contrast(tokens['--danger-fg'], tokens['--danger']),
        `--danger-fg on --danger (${selector})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('one idiom per kind of action', () => {
  it('draws destructive actions as a button in the danger token', () => {
    // X12: Delete and Remove were bare text beside bordered buttons on four
    // surfaces — the irreversible action quieter than its reversible peers.
    const body = ruleBody(CSS, ['.danger-action']);
    expect(body, 'the destructive idiom is gone').not.toBeNull();
    expect(body).toMatch(/background:\s*var\(--danger\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--danger\)/);
    expect(ruleBody(CSS, ['.danger-action.is-quiet'])).toMatch(/color:\s*var\(--danger-text\)/);
  });

  it('keeps the underline for links and gives in-place actions a box', () => {
    // X13: five surfaces spelled one class of action three ways. A link
    // navigates; a `.quiet-action` acts on what is already on screen.
    expect(ruleBody(CSS, ['.link-action'])).toMatch(/text-decoration:\s*underline/);
    const quiet = ruleBody(CSS, ['.quiet-action']);
    expect(quiet, 'the low-emphasis in-place action idiom is gone').not.toBeNull();
    expect(quiet).toMatch(/border:\s*1px solid var\(--strip-btn-border\)/);
    expect(quiet).not.toMatch(/text-decoration:\s*underline/);
  });

  it('gives disabled controls one legible treatment at element level', () => {
    // X14: the dimming ran 0.3–0.55 across the product, and the strip's own
    // buttons declared none at all, so eight inapplicable image actions
    // rendered at full contrast. A control at 0.35 reads as absent, not as
    // unavailable.
    const body = ruleBody(CSS, [':where(button, select, input, textarea):disabled']);
    expect(body, 'the element-level disabled floor is gone').not.toBeNull();
    const value = Number((body ?? '').match(/opacity:\s*([\d.]+)/)?.[1]);
    expect(value).toBeGreaterThanOrEqual(0.6);
  });

  it('makes a placeholder unmistakable for a value', () => {
    // A11: an em-dash placeholder in near-white read as a typed em-dash.
    expect(ruleBody(CSS, ['input::placeholder', 'textarea::placeholder'])).toMatch(
      /color:\s*var\(--text-dim\)/,
    );
  });

  it('ellipsises an overlong input value rather than slicing a glyph', () => {
    // A10: "Northwind Instru" and "Page {page} of {p" read as stored values.
    expect(
      ruleBody(CSS, ['input[type="text"]', 'input[type="search"]', 'input:not([type])']),
    ).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe('colour-swatch pickers speak one language', () => {
  it('rings the selected swatch in the accent, outside the swatch', () => {
    // X19: three pickers, two selection behaviours, and one with none at all.
    // The ring is offset OUTSIDE because a swatch's whole surface is its
    // value — an inset ring reports a colour the picker would then apply.
    const base = ruleBody(CSS, ['.color-swatch']);
    expect(base, 'the shared swatch rule is gone').not.toBeNull();
    expect(base).toMatch(/outline:\s*2px solid transparent/);
    expect(base).toMatch(/outline-offset:/);
    // The near-background swatch must not read as a hole in the row.
    expect(base).toMatch(/box-shadow:\s*inset 0 0 0 1px/);
    expect(
      ruleBody(CSS, ['.color-swatch.is-selected', '.color-swatch[aria-pressed="true"]']),
    ).toMatch(/outline-color:\s*var\(--accent-text, var\(--accent/);
  });

  it('clears the 3:1 boundary floor for a swatch on every ground it lands on', () => {
    // N3: the palette black measured 1.10:1 with a 1.88:1 ring, and the Black
    // ink chip 1.01:1 with a 2.09:1 border — both read as an EMPTY swatch,
    // which in an ink list is a different claim from "black". The FILL is the
    // value and cannot carry a floor, so the BOUNDARY carries it, and it does
    // so against the panel ground rather than as an alpha over it. WCAG 1.4.11
    // sets the number at 3:1 for a UI component boundary.
    const grounds: [string, string[]][] = [
      [':root', ['#171717', '#1f1f1f', '#202020', '#232327', '#262629']],
      ['[data-theme="light"]', ['#ffffff', '#f9fafb', '#f3f4f6']],
      ['[data-theme="high-contrast"]', ['#000000', '#0d0d0d']],
    ];
    for (const [selector, surfaces] of grounds) {
      const edge = tokensIn(ruleBody(CSS, [selector]))['--swatch-edge'];
      expect(edge, `no --swatch-edge in ${selector}`).toBeDefined();
      for (const ground of surfaces) {
        expect(
          contrast(edge, ground),
          `--swatch-edge ${edge} on ${ground} (${selector})`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
    // And every chip takes it from the one token rather than re-deciding.
    expect(ruleBody(CSS, ['.color-chip'])).toMatch(
      /box-shadow:\s*inset 0 0 0 1px var\(--swatch-edge\)/,
    );
    expect(ruleBody(CSS, ['.color-swatch'])).toMatch(/inset 0 0 0 1px var\(--swatch-edge\)/);
    expect(
      ruleBody(CSS, [".page-editpara-ctl input[type='color']"]),
      'the colour well went back to a hairline border',
    ).toMatch(/inset 0 0 0 1px var\(--swatch-edge\)/);
  });

  // The floor is only worth the token if every picker in the product takes it.
  // The comment card's recolour row was the call site the first pass missed: it
  // carried a private `border-black/30` edge instead, and the palette black
  // measured 1.10:1 on the card ground with no ring at all — an invisible hole
  // in a row of choices, which is the exact defect the token exists to end.
  // Pinned per call site rather than by a CSS rule, because the defect is a
  // markup opt-out, and a rule-level assertion cannot see one.
  it.each([
    'panels/CommentsPanel.tsx',
    'panels/HeaderFooterPanel.tsx',
    'panels/WatermarkPanel.tsx',
    'components/canvas/PropertiesBar.tsx',
    'components/canvas/SecondaryToolbar.tsx',
  ])('takes the shared swatch class at the %s picker', (file) => {
    const src = readFileSync(join(resolve(__dirname, '../src/renderer'), file), 'utf8');
    const privateEdges = src.match(/className=[^\n]*\bborder-black\/\d+/g) ?? [];
    expect(privateEdges, `${file} still draws a private swatch edge`).toEqual([]);
    expect(src, `${file} has no shared swatch`).toMatch(/color-swatch/);
  });
});

describe('the select layer positions its own chevron', () => {
  it('places the chevron physically, because background-position has no logical keywords', () => {
    // N1, ten of thirty-six screenshots: `center end 7px` parses as nothing,
    // the declaration is dropped, and the chevron falls back to `0% 0%` — top
    // left, clipped by the control's own top border, on EVERY select.
    const body = ruleBody(CSS, ['select']);
    expect(body, 'the element-level select rule is gone').not.toBeNull();
    expect(body).toMatch(/background-position:\s*right 7px center/);
    expect(body, 'a logical keyword came back to background-position').not.toMatch(
      /background-position:[^;]*\b(end|start)\b/,
    );
    // The chevron travels with the reading direction as a second physical rule.
    expect(ruleBody(CSS, ['[dir="rtl"] select'])).toMatch(
      /background-position:\s*left 7px center/,
    );
  });

  it('ellipsises an overlong select value rather than slicing a glyph', () => {
    // N2: "Over conten" and "Keep each source's own s" read as stored values.
    const body = ruleBody(CSS, ['select']) ?? '';
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    // The ellipsis must land BEFORE the chevron, not under it.
    expect(ruleBody(CSS, [':root select'])).toMatch(/padding-inline-end:/);
  });

  it('keeps only the document-drawn control on the native side of the layer', () => {
    // A form widget on the canvas reproduces the FILE's own appearance stream,
    // so it keeps the native rendering. The paragraph editor's restyle toolbar
    // does not: it names the app's own commands and has no presence in the
    // file. Grouping it with page content is what left a light #EEF2F7 panel of
    // native OS controls floating inside a dark app across three audits.
    expect(ruleBody(CSS, [':root .page-form-select'])).toMatch(/appearance:\s*auto/);
    expect(
      CSS,
      'the paragraph toolbar is back on the native side of the control layer',
    ).not.toMatch(/\.page-editpara-ctl select\s*\{[^}]*appearance:\s*auto/);
    const toolbar = ruleBody(CSS, ['.page-editpara-toolbar']) ?? '';
    expect(toolbar).toMatch(/background:\s*var\(--surface-2\)/);
    expect(toolbar).toMatch(/color:\s*var\(--text\)/);
    expect(
      ruleBody(CSS, [".page-editpara-ctl input[type='number']"]),
    ).toMatch(/background:\s*var\(--control-bg\)/);
  });
});

describe('informational text on the signature card', () => {
  it('takes the product muted token rather than a private outlier', () => {
    // N8: #6b7280 measured 3.53:1 on #1c1c1c at ~10px, on three lines of real
    // information (integrity, field name, claimed time), while the same class
    // of text everywhere else runs 6.94:1.
    const body = ruleBody(CSS, ['.signature-nav-detail']) ?? '';
    expect(body).toMatch(/color:\s*var\(--text-dim\)/);
    expect(body, 'a literal grey came back').not.toMatch(/color:\s*#/);
  });
});

describe('a measurement drawn on the page carries its own contrast', () => {
  it('gives the committed dimension label a legible ground and the casing a floor', () => {
    // N8: a 1px amber hairline on white measured 1.79:1, under the 3:1 a
    // graphical object that carries information owes, with no label, no ticks
    // and no endpoints. Drawn ON the page, so the colours are literals.
    const body = ruleBody(CSS, ['.measure-annot-label']);
    expect(body, 'the committed measurement lost its value chip').not.toBeNull();
    const bg = '#171717'; // rgba(23,23,23,.92) over any page ground, near enough
    const fg = (body ?? '').match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(fg, 'the label colour is no longer a plain hex').toBeDefined();
    expect(contrast(fg!, bg)).toBeGreaterThanOrEqual(4.5);
    // The casing is what clears the non-text floor against page white.
    const src = readFileSync(
      join(resolve(__dirname, '../src/renderer'), 'components/canvas/PageCell.tsx'),
      'utf8',
    );
    const casing = src.match(/MEASURE_CASING = 'rgba\((\d+), (\d+), (\d+)/);
    expect(casing, 'the measurement casing is gone').not.toBeNull();
    const hex =
      '#' +
      [1, 2, 3].map((i) => Number(casing![i]).toString(16).padStart(2, '0')).join('');
    expect(contrast(hex, '#ffffff')).toBeGreaterThanOrEqual(3);

    // And the LINE, not only the casing under it. The casing covers the ground
    // the line does not; it cannot lend the line its own reading, and #f59e0b
    // measured 2.15:1 on page white with the casing already in place.
    const line = src.match(/MEASURE_COLOR = '(#[0-9a-fA-F]{6})'/)?.[1];
    expect(line, 'the measure colour is no longer a plain hex').toBeDefined();
    expect(
      contrast(line!, '#ffffff'),
      `MEASURE_COLOR ${line} on page white`,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('the tab lane has no phantom scrollbar', () => {
  it('zeroes BOTH scrollbar axes on the doc-tab lane', () => {
    // X8: `overflow-x: auto` makes the block axis compute to `auto` too, so
    // the lane grew a VERTICAL scrollbar. Zeroing only `height` left its
    // `width` at the platform default — the unlabelled ~6×25px pill hard
    // against the last tab in the hero shot.
    const body = ruleBody(CSS, ['.app-tab-lane::-webkit-scrollbar']);
    expect(body, 'the tab-lane scrollbar rule is gone').not.toBeNull();
    expect(body).toMatch(/height:\s*0/);
    expect(body).toMatch(/width:\s*0/);
  });
});
