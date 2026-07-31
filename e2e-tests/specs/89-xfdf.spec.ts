// Rung 4 — XFDF through the shipped binary: annotations authored in the app,
// committed, exported to XFDF via the CLI, imported into a fresh PDF via the
// CLI, and verified by the CLI's own listing. The interchange loop, end to
// end, on real files.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  waitForHarness,
  openByPaths,
  setView,
  addAnnotation,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

describe('XFDF interchange via the CLI', () => {
  it('round-trips app-authored comments through xfdf-export and xfdf-import', async () => {
    await waitForHarness();
    const tmp = mkdtempSync(resolve(tmpdir(), 'xfdf-'));
    const src = resolve(tmp, 'annotated.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await addAnnotation({ kind: 'highlight', x: 0.2, y: 0.2, w: 0.2, h: 0.1, color: '#ffd54f', note: 'first' });
    await addAnnotation({ kind: 'ink', x: 0.5, y: 0.5, w: 0.2, h: 0.1, color: '#2f6fed', points: [0.5, 0.5, 0.7, 0.6] });
    await commitPendingEdits();
    const dest = resolve(tmp, 'committed.pdf');
    await saveActiveAs(dest);

    const xfdf = resolve(tmp, 'comments.xfdf');
    const exp = execFileSync(APP_EXE, ['xfdf-export', dest, '-o', xfdf], { encoding: 'utf-8' });
    const expReport = JSON.parse(exp.slice(exp.indexOf('{'))) as { count: number };
    expect(expReport.count).toBe(2);
    const xml = readFileSync(xfdf, 'utf-8');
    expect(xml).toContain('<square');
    expect(xml).toContain('<ink');
    expect(xml).toContain('<contents>first</contents>');

    const bare = resolve(tmp, 'bare.pdf');
    copyFileSync(FIXTURE, bare);
    const merged = resolve(tmp, 'merged.pdf');
    const imp = execFileSync(APP_EXE, ['xfdf-import', bare, '--xfdf', xfdf, '-o', merged], {
      encoding: 'utf-8',
    });
    const impReport = JSON.parse(imp.slice(imp.indexOf('{'))) as { added: number; skipped: unknown[] };
    expect(impReport.added).toBe(2);
    expect(impReport.skipped).toHaveLength(0);

    const list = execFileSync(APP_EXE, ['comments-list', merged], { encoding: 'utf-8' });
    const listed = JSON.parse(list.slice(list.indexOf('{'))) as { count: number; by_type: Record<string, number> };
    expect(listed.count).toBe(2);
    expect(listed.by_type['Square']).toBe(1);
    expect(listed.by_type['Ink']).toBe(1);
  });
});
