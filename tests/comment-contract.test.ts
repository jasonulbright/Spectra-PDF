import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

// Comment text that narrates a test's own history or points at a gitignored
// working document. Tracked files state invariants only.
const BANNED: Array<[string, RegExp]> = [
  ['test history', /\bthis (test|spec) used to\b/i],
  ['rename history', /\brenamed from\b/i],
  ['private working document', /\bdev notes\b|PUNCHLIST\.md|findings\.local|BASELINE\.local/i],
];

const COMMENT = /^\s*(\/\/|\*|\/\*|#)/;

function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'src', 'src-tauri/src', 'tests', 'e2e-tests', 'scripts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter((p) => /\.(ts|tsx|mts|js|mjs|py|rs|ps1|sh)$/.test(p))
    .filter((p) => p !== 'tests/comment-contract.test.ts');
}

describe('tracked comments carry no history narration or private-document references', () => {
  it('finds no banned phrase in a comment line', () => {
    const hits: string[] = [];
    for (const path of trackedSources()) {
      const lines = readFileSync(resolve(ROOT, path), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!COMMENT.test(line)) return;
        for (const [kind, pattern] of BANNED) {
          if (pattern.test(line)) hits.push(`${path}:${i + 1} ${kind}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('flags each banned phrase', () => {
    for (const sample of [
      '// This test used to pin the refusal.',
      '# renamed from old_name',
      ' * the baseline lives in the dev notes.',
    ]) {
      expect(BANNED.some(([, p]) => p.test(sample)), sample).toBe(true);
    }
  });
});
