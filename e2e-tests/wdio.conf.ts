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
 * and every spec fails with "Test harness never appeared on window". CDP's
 * /json endpoint exposes the incorrect localhost URL for diagnosis.
 *
 * Then: npm test
 */
import { spawn, spawnSync, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolve, basename } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { scanText } from './scan-run-log.js';

const REPO_ROOT = resolve(__dirname, '..');
const APP_BINARY = resolve(REPO_ROOT, 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const NATIVE_DRIVER = resolve(__dirname, 'msedgedriver.exe');
const TAURI_DRIVER_PORT = 4444;
const RUN_LOG_DIR = resolve(__dirname, 'logs');
const RUN_LOG = resolve(RUN_LOG_DIR, 'last-run.log');

// stdin is ignored and both output streams are piped, which is what the
// stdio tuple below declares — the process type has to say the same.
let tauriDriver: ChildProcessByStdio<null, Readable, Readable> | null = null;

// The driver-level WARN/ERROR rows are emitted inside the worker processes and
// reach the launcher only as forwarded output, so no launcher-side logger hook
// can see them; teeing those streams is the only point at which a run can
// collect its own rows. Both streams are needed: the logger's rows arrive on
// stderr while the spec/runner lines that attribute them arrive on stdout.
// Held in memory as well as written to disk so `onComplete` scans what it
// already has rather than racing a file flush.
type StreamWrite = typeof process.stdout.write;
let capturedOutput = '';
const restorers: (() => void)[] = [];

function captureStream(stream: NodeJS.WriteStream): void {
  const original: StreamWrite = stream.write.bind(stream) as StreamWrite;
  const tee = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    capturedOutput += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return (original as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as StreamWrite;
  stream.write = tee;
  restorers.push(() => {
    stream.write = original;
  });
}

function captureOutput(): void {
  if (restorers.length > 0) return;
  captureStream(process.stdout);
  captureStream(process.stderr);
}

/** Print the run's WARN/ERROR inventory. A report only: nothing here changes
 * the exit code, which stays WebdriverIO's verdict. */
function reportRunLog(): void {
  for (const restore of restorers.splice(0)) restore();
  try {
    mkdirSync(RUN_LOG_DIR, { recursive: true });
    writeFileSync(RUN_LOG, capturedOutput);
    process.stdout.write(`\n${scanText(capturedOutput, RUN_LOG)}\n`);
  } catch (err) {
    process.stdout.write(`\ne2e log inventory unavailable: ${String(err)}\n`);
  }
}

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
  onPrepare: () => {
    captureOutput();
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `App binary not found at ${APP_BINARY}. Run \`npm run build:app\` first.`,
      );
    }
    // The harness binary runs from a FOLDER, which is exactly the portable
    // container's shape — the app finds no `install-record.json` beside it and
    // correctly concludes it was not installed. A portable copy with no
    // colour-profile answer on record presents its licence dialog on first
    // run, which would stand in front of every spec in the battery.
    //
    // So the battery's baseline is an ANSWERED copy, seeded here once, the way
    // a fixture is: the answer is a file the product itself writes, in the
    // place the product itself reads. The spec that exercises the first-run
    // presentation removes this file (or drives the state through the
    // harness's pin) and puts it back, so the unanswered state stays reachable
    // for the one spec that is about it.
    const portableData = resolve(APP_BINARY, '..', 'data');
    mkdirSync(portableData, { recursive: true });
    writeFileSync(
      resolve(portableData, 'icc-assent.json'),
      '{\n  "adobeIccEulaAccepted": true\n}\n',
    );

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
      const env: NodeJS.ProcessEnv = { ...process.env, SPECTRAPDF_E2E: '1' };
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
    reportRunLog();
  },
};

export const FIXTURES_DIR = resolve(__dirname, 'fixtures');
