import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.includes('.local.') ? [path] : [];
  });
}

// A form picked by `count === 1` gives Polish or Russian `_other` where the
// catalog holds `_few` or `_many`, and Arabic never reaches `_zero` or `_two`.
describe('plural forms', () => {
  it('are chosen by the locale, never by comparing the count with 1', () => {
    const root = resolve(__dirname, '../src/renderer');
    const picked = /===\s*1\s*\?\s*'[\w.]+_one'/;
    const offenders = sources(root).filter((path) => picked.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
