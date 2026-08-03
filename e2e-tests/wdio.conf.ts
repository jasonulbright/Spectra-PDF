/**
 * WebdriverIO config for Spectra PDF end-to-end tests.
 *
 * Runs against the debug build of the Tauri binary, driven by tauri-driver
 * which proxies to msedgedriver to control the embedded WebView2.
 *
 * WebView2 is Chromium-based and Windows Update bumps it roughly monthly —
 * msedgedriver only talks to the exact major version it was built for, so
 * ANY pinned copy (a stale `cargo install`-managed global, or a checked-in
 * binary) goes stale on its own schedule, not ours. There is no version to
 * pin here, minimum or otherwise: `onPrepare` below always re-resolves the
 * driver against whatever WebView2 is installed RIGHT NOW, by re-running
 * `msedgedriver-tool` at the start of every run. `--native-driver` then
 * points tauri-driver at that freshly-resolved copy instead of trusting PATH
 * to already have a correctly-versioned one.
 *
 * Prereqs (one-time per machine):
 *   cargo install tauri-driver --locked
 *   cargo install --git https://github.com/chippers/msedgedriver-tool
 *
 * Build the app harness with (from the repo root):
 *   VITE_E2E=1 npx tauri build --debug --no-bundle
 *
 * NOT with a bare `cargo build`: tauri-build re-runs whenever dist changes,
 * and outside the tauri CLI it bakes a DEV context into the binary — the
 * webview then points at http://localhost:5173 (no dev server = blank page)
 * and every spec fails with "Test harness never appeared on window", which
 * reads like a catastrophic regression. Proven live 2026-08-02 by CDP
 * (/json listed the page URL as localhost:5173).
 *
 * Then: npm test
 */
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';

const REPO_ROOT = resolve(__dirname, '..');
const APP_BINARY = resolve(REPO_ROOT, 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const NATIVE_DRIVER = resolve(__dirname, 'msedgedriver.exe');
const TAURI_DRIVER_PORT = 4444;

let tauriDriver: ChildProcessWithoutNullStreams | null = null;

function reapTestProcesses(): void {
  // Force-kill the driver/app/engine process tree by image name so each
  // session starts from a clean slate. /T covers child processes; a missing
  // image is expected and silenced.
  const appName = basename(APP_BINARY);
  for (const name of ['tauri-driver.exe', 'msedgedriver.exe', appName, 'python.exe']) {
    spawnSync('taskkill', ['/F', '/T', '/IM', name], {
      stdio: 'ignore',
      shell: false,
    });
  }
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./specs/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],
  hostname: '127.0.0.1',
  port: TAURI_DRIVER_PORT,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60_000 },
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: './tsconfig.json' },
  },
  onPrepare: () => {
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `App binary not found at ${APP_BINARY}. Run \`npm run build:app\` first.`,
      );
    }
    // Always re-resolve against whatever WebView2 is installed right now —
    // never trust a previously-downloaded copy to still match (see header).
    const result = spawnSync('msedgedriver-tool', [], { cwd: __dirname, shell: true, stdio: 'pipe' });
    if (result.error || result.status !== 0 || !existsSync(NATIVE_DRIVER)) {
      throw new Error(
        `msedgedriver-tool failed to resolve a matching msedgedriver.exe into ${__dirname}: ` +
          `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`,
      );
    }
  },
  beforeSession: (_config, _caps, specs: string[]) =>
    new Promise<void>((resolveSession, rejectSession) => {
      // Clear any orphaned driver/app/engine processes before the session starts.
      reapTestProcesses();

      // Set SPECTRAPDF_E2E so the Tauri binary skips single-instance + tray —
      // each WDIO session needs a clean launch and a clean exit.
      const env = { ...process.env, SPECTRAPDF_E2E: '1' };
      // The fallback spec's session launches the app with the backdrop forced
      // OFF (an e2e-gated lever in lib.rs), so the opaque presentation —
      // otherwise unreachable on a machine where Mica composes — runs live.
      if (specs?.some((s) => s.includes('backdrop-fallback'))) {
        env.SPECTRAPDF_E2E_FORCE_OPAQUE = '1';
      }
      tauriDriver = spawn(
        'tauri-driver',
        ['--port', String(TAURI_DRIVER_PORT), '--native-driver', NATIVE_DRIVER],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          env,
        },
      );
      tauriDriver.stderr.on('data', (chunk) => {
        process.stderr.write(`[tauri-driver] ${chunk}`);
      });
      tauriDriver.on('error', rejectSession);
      // Give tauri-driver a moment to bind the port before WDIO connects.
      setTimeout(resolveSession, 1500);
    }),
  afterSession: () =>
    new Promise<void>((resolveDone) => {
      if (tauriDriver && !tauriDriver.killed) {
        tauriDriver.kill();
        tauriDriver = null;
      }
      reapTestProcesses();
      // Short gap to let the OS release the WebDriver port before next spec.
      setTimeout(resolveDone, 800);
    }),
  onComplete: () => {
    reapTestProcesses();
  },
};

export const FIXTURES_DIR = resolve(__dirname, 'fixtures');
