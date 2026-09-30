/**
 * WebdriverIO config for the Linux build: the same specs and hooks as
 * `wdio.conf.ts`, driven by tauri-driver in front of WebKitWebDriver.
 *
 * WebKitWebDriver ships with the host's WebKitGTK (Debian/Ubuntu package
 * `webkit2gtk-driver`) and always matches the installed webview, so nothing
 * is resolved or downloaded here: the run refuses when the driver is absent.
 *
 * Prereqs (one-time per machine):
 *   cargo install tauri-driver --locked
 *   the distribution's WebKitWebDriver package
 *
 * Build the app harness with (from the repo root):
 *   VITE_E2E=1 npx tauri build --debug --no-bundle --features e2e-net-private
 *
 * Then: npx wdio run e2e-tests/wdio.linux.conf.ts --spec <spec>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as windowsConfig } from './wdio.conf';

const REPO_ROOT = resolve(__dirname, '..');
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(REPO_ROOT, 'src-tauri', 'target');
const APP_BINARY = resolve(TARGET_DIR, 'debug', 'spectrapdf');
const TAURI_DRIVER_PORT = 4444;

let tauriDriver: ChildProcess | null = null;

function which(program: string): string | null {
  const found = spawnSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path ? path : null;
}

/** The driver runs in its own process group so a stop also ends the
 * WebKitWebDriver and app processes it started. */
async function stopDriver(): Promise<void> {
  const owned = tauriDriver;
  tauriDriver = null;
  if (!owned || owned.exitCode !== null || owned.pid === undefined) return;
  const exited = new Promise<void>((done) => owned.once('exit', () => done()));
  try {
    process.kill(-owned.pid, 'SIGTERM');
  } catch {
    return;
  }
  await exited;
}

export const config: WebdriverIO.Config = {
  ...windowsConfig,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],
  port: TAURI_DRIVER_PORT,
  onPrepare: () => {
    if (!existsSync(APP_BINARY)) {
      throw new Error(`App binary not found at ${APP_BINARY}. Build the e2e harness first.`);
    }
    if (!which('WebKitWebDriver')) {
      throw new Error('WebKitWebDriver is not on PATH. Install the webkit2gtk-driver package.');
    }
    if (!which('tauri-driver')) {
      throw new Error('tauri-driver is not on PATH. Run `cargo install tauri-driver --locked`.');
    }
    // The same answered colour-profile baseline the Windows run seeds.
    const portableData = resolve(APP_BINARY, '..', 'data');
    mkdirSync(portableData, { recursive: true });
    writeFileSync(
      resolve(portableData, 'icc-assent.json'),
      '{\n  "adobeIccEulaAccepted": true\n}\n',
    );
  },
  beforeSession: async () => {
    await stopDriver();
    const child = spawn('tauri-driver', ['--port', String(TAURI_DRIVER_PORT)], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, SPECTRAPDF_E2E: '1' },
      detached: true,
    });
    tauriDriver = child;
    await Promise.race([
      new Promise<void>((done) => setTimeout(done, 1500)),
      new Promise<void>((_, reject) =>
        child.once('exit', (code) => reject(new Error(`tauri-driver exited during startup (${code})`))),
      ),
    ]);
  },
  afterSession: async () => {
    await stopDriver();
  },
  onComplete: async () => {
    await stopDriver();
  },
};
