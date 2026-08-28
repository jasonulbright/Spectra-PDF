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
});
