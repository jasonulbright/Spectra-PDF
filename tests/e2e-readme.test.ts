import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E = resolve(__dirname, '..', 'e2e-tests');

describe('the e2e README', () => {
  it('states no spec count, or the one the specs folder holds', () => {
    const readme = readFileSync(resolve(E2E, 'README.md'), 'utf8');
    const specs = readdirSync(resolve(E2E, 'specs')).filter((n) => n.endsWith('.spec.ts')).length;
    const claimed = [...readme.matchAll(/\*\*(\d+) specs\*\*|\b(\d+) specs\b/g)].map((m) => Number(m[1] ?? m[2]));
    for (const count of claimed) expect(count).toBe(specs);
  });

  it('names only table rows whose spec exists', () => {
    const readme = readFileSync(resolve(E2E, 'README.md'), 'utf8');
    const specs = new Set(readdirSync(resolve(E2E, 'specs')));
    const rows = [...readme.matchAll(/^\| `([^`]+\.spec\.ts)` \|/gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(specs.has(row), row).toBe(true);
  });
});
