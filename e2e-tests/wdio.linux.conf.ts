/**
 * WebdriverIO config for the Linux build: the same specs and hooks as
 * `wdio.conf.ts`, driven by tauri-driver in front of WebKitWebDriver.
 *
 * WebKitWebDriver ships with the host's WebKitGTK (Debian/Ubuntu package
 * `webkit2gtk-driver`) and always matches the installed webview. Nothing is
 * pinned or downloaded: every run resolves the driver again from PATH and the
 * distribution's package directories, and hands tauri-driver that path.
 *
 * Prereqs (one-time per machine):
 *   cargo install tauri-driver --locked
 *   the distribution's WebKitWebDriver package
 *   the distribution's Ghostscript package (the .deb and .rpm depend on it;
 *   the debug binary has no included copy, so the suite needs it on PATH)
 *
 * Build the app harness with (from the repo root):
 *   VITE_E2E=1 npx tauri build --debug --no-bundle --features e2e-net-private
 *
 * CARGO_TARGET_DIR, when set, must end in a directory named `target`. A
 * binary outside `target/<profile>` resolves its resources to
 * `/usr/lib/<product>` and the engine cannot start.
 *
 * Then, from the e2e-tests directory (where wdio is installed):
 *   npx wdio run wdio.linux.conf.ts --spec specs/<spec>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { config as windowsConfig } from './wdio.conf';
import {
  APP_DATA_ROOT,
  E2E_XDG_CONFIG_HOME,
  E2E_XDG_DATA_HOME,
  ICC_ASSENT_RECORD,
} from './support/app-data';

const REPO_ROOT = resolve(__dirname, '..');
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(REPO_ROOT, 'src-tauri', 'target');
const APP_BINARY = resolve(TARGET_DIR, 'debug', 'spectrapdf');
const TAURI_DRIVER_PORT = 4444;
// Fits a single 1080p monitor at its origin, whatever the desktop layout.
const WINDOW_RECT = { x: 0, y: 0, width: 1600, height: 1000 } as const;

// Package layouts that install WebKitWebDriver outside PATH, newest API first.
const DRIVER_DIRS = [
  '/usr/libexec/webkit2gtk-4.1',
  '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1',
  '/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1',
  '/usr/lib64/webkit2gtk-4.1',
  '/usr/libexec/webkit2gtk-4.0',
  '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.0',
];

let tauriDriver: ChildProcess | null = null;

function which(program: string): string | null {
  const found = spawnSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path ? path : null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveNativeDriver(): string {
  const candidates = [which('WebKitWebDriver'), ...DRIVER_DIRS.map((d) => resolve(d, 'WebKitWebDriver'))];
  for (const candidate of candidates) {
    if (candidate && executable(candidate)) return candidate;
  }
  throw new Error(
    'No WebKitWebDriver found on PATH or in the WebKitGTK package directories. ' +
      'Install the distribution package that ships it (Debian/Ubuntu: webkit2gtk-driver).',
  );
}

async function requireFreeDriverPort(): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(new Error(`E2E port ${TAURI_DRIVER_PORT} is already in use; no existing process was stopped`)),
    );
    server.listen({ host: '127.0.0.1', port: TAURI_DRIVER_PORT, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
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

/** `pkill -f` reads its pattern as an extended regular expression; a path
 * holding a metacharacter would otherwise match other processes or none. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An app instance left by an aborted session holds the single-window claims
 * and the engine; only processes running this exact binary are stopped. */
function reapOrphanedApps(): void {
  spawnSync('pkill', ['-KILL', '-f', `^${escapeRegExp(APP_BINARY)}( |$)`]);
}

/** The harness exists before the window is shown, and pointer actions against
 * a hidden window fail as out of bounds. */
async function waitForVisibleWindow(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(
    async () => Boolean(await browser.execute(() => document.visibilityState === 'visible')),
    { timeout: timeoutMs, timeoutMsg: 'The app window never became visible' },
  );
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
    const profileDir = dirname(APP_BINARY);
    if (basename(dirname(profileDir)) !== 'target' || !existsSync(resolve(profileDir, '.cargo-lock'))) {
      throw new Error(
        `${APP_BINARY} is not inside a cargo output directory named "target"; its resources ` +
          'would resolve to /usr/lib and the engine could not start. Build with a CARGO_TARGET_DIR ending in /target.',
      );
    }
    resolveNativeDriver();
    if (!which('tauri-driver')) {
      throw new Error('tauri-driver is not on PATH. Run `cargo install tauri-driver --locked`.');
    }
    if (!which('gs')) {
      throw new Error(
        'Ghostscript (gs) is not on PATH. The suite needs it present, as the .deb and .rpm do; ' +
          'install the distribution package.',
      );
    }
    // The same answered colour-profile baseline the Windows run seeds, in
    // the per-user configuration directory the binary reads on Linux.
    mkdirSync(dirname(ICC_ASSENT_RECORD), { recursive: true });
    writeFileSync(ICC_ASSENT_RECORD, '{\n  "adobeIccEulaAccepted": true\n}\n');
  },
  beforeSession: async (_config, _caps, specs: string[]) => {
    await stopDriver();
    reapOrphanedApps();
    await requireFreeDriverPort();
    // A restored rectangle from an earlier session can span every monitor:
    // each session starts from the default placement instead.
    rmSync(resolve(APP_DATA_ROOT, 'session.json'), { force: true });
    // The binary keeps no state beside itself on Linux; these keep its
    // per-user state out of the developer's home.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SPECTRAPDF_E2E: '1',
      XDG_CONFIG_HOME: E2E_XDG_CONFIG_HOME,
      XDG_DATA_HOME: E2E_XDG_DATA_HOME,
    };
    if (specs?.some((s) => s.includes('backdrop-fallback'))) {
      env.SPECTRAPDF_E2E_FORCE_OPAQUE = '1';
    }
    const child = spawn(
      'tauri-driver',
      ['--port', String(TAURI_DRIVER_PORT), '--native-driver', resolveNativeDriver()],
      { stdio: ['ignore', 'inherit', 'inherit'], env, detached: true },
    );
    tauriDriver = child;
    await Promise.race([
      new Promise<void>((done) => setTimeout(done, 1500)),
      new Promise<void>((_, reject) =>
        child.once('exit', (code) => reject(new Error(`tauri-driver exited during startup (${code})`))),
      ),
    ]);
  },
  before: async (...args: unknown[]) => {
    // WebKitWebDriver's Get Element Text answers "" for rendered text under
    // this webview. The rendered text of a laid-out element is its
    // innerText; an element with no layout box keeps the driver's answer.
    browser.overwriteCommand(
      'getText',
      async function (this: WebdriverIO.Element, original: () => Promise<string>) {
        const driverText = await original();
        if (driverText !== '') return driverText;
        return browser.execute(
          (el: HTMLElement) => (el.getClientRects().length > 0 ? el.innerText.trim() : ''),
          this as unknown as HTMLElement,
        );
      },
      true,
    );
    await browser.setWindowRect(WINDOW_RECT.x, WINDOW_RECT.y, WINDOW_RECT.width, WINDOW_RECT.height);
    const inherited = windowsConfig.before as ((...a: unknown[]) => Promise<void>) | undefined;
    await inherited?.(...args);
    await waitForVisibleWindow();
  },
  onReload: async () => {
    await waitForVisibleWindow();
  },
  afterSession: async () => {
    await stopDriver();
    reapOrphanedApps();
  },
  onComplete: async () => {
    await stopDriver();
    reapOrphanedApps();
  },
};
