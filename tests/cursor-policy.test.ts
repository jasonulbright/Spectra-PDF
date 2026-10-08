import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pointing-hand cursor means "this follows a link". In the app's own UI
// nothing does, so every button, tab and tile uses the arrow (or grab/move/
// resize where the thing really is dragged). The exception is the content of a
// PDF itself: link regions and form pushbuttons. See the policy note at the end
// of src/renderer/styles.css.

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

function ruleSelector(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    if (lines[i].includes('{')) return lines[i].split('{')[0].trim();
  }
  return '';
}

describe('cursor policy', () => {
  it('only PDF link regions and form pushbuttons take the pointing hand', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/cursor:\s*pointer|cursor-pointer|cursor:\s*'pointer'|'move'\s*:\s*'pointer'/.test(line)) return;
        if (file.endsWith('.css') && HAND_ALLOWED.includes(ruleSelector(lines, i))) return;
        offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the allowed rules do take the hand', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    for (const sel of HAND_ALLOWED) {
      const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*\\}'));
      expect(m, sel).not.toBeNull();
      expect(m![0], sel).toMatch(/cursor:\s*pointer/);
    }
  });

  it('page tiles on the board are the open hand', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.canvas-view \.page \{[^}]*cursor:\s*grab;/);
  });
});
