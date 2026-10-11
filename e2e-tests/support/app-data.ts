/**
 * Where the binary under test writes its per-user state.
 *
 * The harness binary runs from `src-tauri/target/debug/`, a folder with no
 * `install-record.json` beside it — which the product reads as the PORTABLE
 * container and, on Windows, answers with `<exe dir>\data`, not the standard
 * per-user directory. On Linux the answer is the per-user directories. A spec that resolves the record from `%APPDATA%` therefore reads a
 * file the binary under test never writes: it silently passes for as long as a
 * stale copy sits there with the right shape, and asserts against some earlier
 * run's session forever after.
 *
 * One answer for every spec that reads the record, derived the way the product
 * derives it, so the two cannot drift apart again. `155-portable-assent`
 * asserts the container split itself — that the standard directory stays
 * untouched — and is the spec that would fail if this ever stopped being true.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The binary under test, launched by both WDIO configs: `SPECTRAPDF_E2E_APP`
 * when set (a suite run from a worktree against another checkout's build),
 * else this checkout's debug build.
 */
export const APP_BINARY = process.env.SPECTRAPDF_E2E_APP
  ? resolve(process.env.SPECTRAPDF_E2E_APP)
  : process.platform === 'win32'
    ? resolve(REPO_ROOT, 'src-tauri', 'target', 'debug', 'spectrapdf.exe')
    : resolve(process.env.CARGO_TARGET_DIR ?? resolve(REPO_ROOT, 'src-tauri', 'target'), 'debug', 'spectrapdf');

/** The development interpreter: `SPECTRAPDF_E2E_PYTHON` when set, else this
 * checkout's `.venv`. */
export const VENV_PYTHON = process.env.SPECTRAPDF_E2E_PYTHON
  ? resolve(process.env.SPECTRAPDF_E2E_PYTHON)
  : process.platform === 'win32'
    ? resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : resolve(REPO_ROOT, '.venv', 'bin', 'python');

// Every state path below derives from APP_BINARY: the data root follows the binary under test, never the checkout.

/** The bundle identifier every per-user root is keyed by. */
const APP_IDENTIFIER = 'com.spectrapdf.app';

/**
 * The per-user base directories the Linux run hands the binary under test.
 * On Linux the executable's folder is never a state root, so the suite points
 * `XDG_CONFIG_HOME` and `XDG_DATA_HOME` at folders of its own beside the
 * binary instead of the developer's home.
 */
export const E2E_XDG_CONFIG_HOME = resolve(APP_BINARY, '..', 'e2e-xdg', 'config');
export const E2E_XDG_DATA_HOME = resolve(APP_BINARY, '..', 'e2e-xdg', 'data');

/** `portable::data_root` for that binary: `<exe dir>\data` on Windows, the
 * per-user data directory on Linux. */
export const APP_DATA_ROOT =
  process.platform === 'win32'
    ? resolve(APP_BINARY, '..', 'data')
    : resolve(E2E_XDG_DATA_HOME, APP_IDENTIFIER);

/** Where the binary records the colour-profile answer: the portable root on
 * Windows, the per-user configuration directory on Linux. */
export const ICC_ASSENT_RECORD =
  process.platform === 'win32'
    ? resolve(APP_DATA_ROOT, 'icc-assent.json')
    : resolve(E2E_XDG_CONFIG_HOME, APP_IDENTIFIER, 'icc-assent.json');

/** The session record, written entirely on the Rust side. */
export const SESSION_FILE = resolve(APP_DATA_ROOT, 'session.json');

/** The pre-window startup flags, read before any renderer exists to be asked. */
export const STARTUP_FILE = resolve(APP_DATA_ROOT, 'startup.json');

/**
 * `startup.json` with window restore off, other flags kept. A record that is
 * missing, not JSON, or not an object becomes `{"restoreWindowsOnLaunch":false}`:
 * the launch sets a non-object record aside and reports it in a notice that
 * stands in front of the spec.
 */
export function normalizedStartupJson(current: string | null): string {
  let flags: Record<string, unknown> = {};
  if (current !== null) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        flags = parsed as Record<string, unknown>;
      }
    } catch {
      flags = {};
    }
  }
  return JSON.stringify({ ...flags, restoreWindowsOnLaunch: false });
}

/**
 * Runs before the binary launches. Rust reads `startup.json` and `session.json`
 * in setup, before any webview exists, so a reset made through a window comes
 * one launch too late. Removing the session record is recursive: one spec
 * plants a directory on that name, which the next launch reports as unreadable.
 */
export function resetLaunchRestoreState(): void {
  mkdirSync(APP_DATA_ROOT, { recursive: true });
  let current: string | null = null;
  try {
    current = readFileSync(STARTUP_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  writeFileSync(STARTUP_FILE, normalizedStartupJson(current));
  rmSync(SESSION_FILE, { recursive: true, force: true });
}
