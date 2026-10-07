import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pointing-hand cursor means "web link". The renderer has none, so it must
// not appear: every button, tab and tile uses the arrow (or grab/move/resize
// where the thing really is dragged). See the policy note at the end of
// src/renderer/styles.css.

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

describe('cursor policy', () => {
  it('no stylesheet rule or class sets the pointing-hand cursor', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/cursor:\s*pointer|cursor-pointer|cursor:\s*'pointer'|'move'\s*:\s*'pointer'/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('page tiles on the board are the open hand', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.canvas-view \.page \{[^}]*cursor:\s*grab;/);
  });
});
