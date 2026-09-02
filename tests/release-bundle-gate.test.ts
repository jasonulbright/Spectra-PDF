// The e2e harness (`window.__SPECTRA_TEST__`) is compiled out of the renderer
// by `VITE_E2E`; scripts/check-release-bundle.py is the only thing that reads
// the built tree for it. A gate that never sees a positive is not proven to
// detect anything, so this builds the renderer WITH the variable into a
// scratch tree and requires the gate to refuse it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');
const gate = resolve(root, 'scripts', 'check-release-bundle.py');
const venvPython = resolve(root, '.venv', 'Scripts', 'python.exe');
const python = existsSync(venvPython) ? venvPython : 'python';
const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

function runGate(tree: string) {
  const r = spawnSync(python, [gate, tree], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('the release bundle gate', () => {
  it('refuses a renderer built with VITE_E2E=1', () => {
    const scratch = resolve(root, 'release-bundle-gate-e2e.local.out');
    rmSync(scratch, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      [vite, 'build', '--config', 'vite.config.mts', '--outDir', scratch],
      { cwd: root, env: { ...process.env, VITE_E2E: '1' }, stdio: 'pipe' },
    );
    const { status, out } = runGate(scratch);
    expect(status).toBe(1);
    expect(out).toContain('__SPECTRA_TEST__');
    expect(out).toContain('must NOT be shipped');
  }, 300_000);

  it('passes a tree that carries no marker', () => {
    const scratch = resolve(root, 'release-bundle-gate-clean.local.out');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(resolve(scratch, 'assets'), { recursive: true });
    writeFileSync(resolve(scratch, 'assets', 'index.js'), 'window.__SPECTRA_APP__=1;');
    const { status, out } = runGate(scratch);
    expect(status).toBe(0);
    expect(out).toContain('release bundle OK');
  });

  it('refuses a missing tree rather than passing vacuously', () => {
    const { status, out } = runGate(resolve(root, 'release-bundle-gate-absent.local.out'));
    expect(status).toBe(1);
    expect(out).toContain('not a directory');
  });
});
