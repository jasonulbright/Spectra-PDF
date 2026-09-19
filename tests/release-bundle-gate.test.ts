// The e2e harness (`window.__SPECTRA_TEST__`) is compiled out of the renderer
// by `VITE_E2E`; scripts/check-release-bundle.py is the only thing that reads
// the built tree for it. A gate that never sees a positive is not proven to
// detect anything, so a VITE_E2E=1 build must carry the marker and the gate
// must refuse it.
//
// The build is the smallest one that carries the property: the harness's own
// enable expression and its own window assignment, read out of
// src/renderer/testHarness.ts, built through vite.config.mts in production
// mode. The same fixture built without the variable must drop the marker, or
// the variable is not what decides it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');
const gate = resolve(root, 'scripts', 'check-release-bundle.py');
const venvPython = resolve(root, '.venv', 'Scripts', 'python.exe');
const python = existsSync(venvPython) ? venvPython : 'python';
const MARKER = '__SPECTRA_TEST__';

function runGate(tree: string) {
  const r = spawnSync(python, [gate, tree], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The two harness lines that decide whether a build carries the marker. */
function harnessLines(): { enabled: string; assignment: string } {
  const source = readFileSync(resolve(root, 'src', 'renderer', 'testHarness.ts'), 'utf8');
  const enabled = /export const TEST_HARNESS_ENABLED =\s*([^;]+);/.exec(source);
  const assignment = new RegExp(`^\\s*(window\\.${MARKER} = harness;)$`, 'm').exec(source);
  expect(enabled, 'the harness enable expression moved').not.toBeNull();
  expect(assignment, 'the harness window assignment moved').not.toBeNull();
  return { enabled: enabled![1], assignment: assignment![1] };
}

/** Build the fixture through the renderer's own Vite config, with or without
 * VITE_E2E=1 in the environment the config reads it from. */
async function buildFixture(name: string, e2e: boolean): Promise<string> {
  const fixture = resolve(root, `release-bundle-gate-${name}.local`);
  const outDir = resolve(fixture, 'out');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const { enabled, assignment } = harnessLines();
  writeFileSync(resolve(fixture, 'harness.ts'), [
    `export const TEST_HARNESS_ENABLED = ${enabled};`,
    'export function installTestHarness(): void {',
    '  const harness = { ready: true };',
    `  ${assignment}`,
    '}',
  ].join('\n'));
  writeFileSync(resolve(fixture, 'entry.ts'), [
    "import { installTestHarness, TEST_HARNESS_ENABLED } from './harness';",
    'if (TEST_HARNESS_ENABLED) installTestHarness();',
  ].join('\n'));
  writeFileSync(resolve(fixture, 'index.html'), '<script type="module" src="./entry.ts"></script>');
  const saved = process.env.VITE_E2E;
  if (e2e) process.env.VITE_E2E = '1';
  else delete process.env.VITE_E2E;
  try {
    await build({
      configFile: resolve(root, 'vite.config.mts'),
      root: fixture,
      publicDir: false,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (saved === undefined) delete process.env.VITE_E2E;
    else process.env.VITE_E2E = saved;
  }
  return outDir;
}

describe('the release bundle gate', () => {
  it('refuses a renderer built with VITE_E2E=1', async () => {
    const { status, out } = runGate(await buildFixture('e2e', true));
    expect(status).toBe(1);
    expect(out).toContain(MARKER);
    expect(out).toContain('must NOT be shipped');
  });

  it('passes the same renderer built without VITE_E2E', async () => {
    const { status, out } = runGate(await buildFixture('plain', false));
    expect(status).toBe(0);
    expect(out).toContain('release bundle OK');
  });

  it('scans for the property the harness assigns', () => {
    const { assignment } = harnessLines();
    expect(assignment).toBe(`window.${MARKER} = harness;`);
    expect(readFileSync(gate, 'utf8')).toContain(`MARKERS = [b"${MARKER}"]`);
  });

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
