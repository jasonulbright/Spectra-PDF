/**
 * Where the binary under test writes its per-user state.
 *
 * The harness binary runs from `src-tauri/target/debug/`, a folder with no
 * `install-record.json` beside it — which the product reads as the PORTABLE
 * container and answers with `<exe dir>\data`, not the standard per-user
 * directory. A spec that resolves the record from `%APPDATA%` therefore reads a
 * file the binary under test never writes: it silently passes for as long as a
 * stale copy sits there with the right shape, and asserts against some earlier
 * run's session forever after.
 *
 * One answer for every spec that reads the record, derived the way the product
 * derives it, so the two cannot drift apart again. `155-portable-assent`
 * asserts the container split itself — that the standard directory stays
 * untouched — and is the spec that would fail if this ever stopped being true.
 */

import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The debug binary the WDIO config for this platform launches. */
export const APP_BINARY =
  process.platform === 'win32'
    ? resolve(REPO_ROOT, 'src-tauri', 'target', 'debug', 'spectrapdf.exe')
    : resolve(process.env.CARGO_TARGET_DIR ?? resolve(REPO_ROOT, 'src-tauri', 'target'), 'debug', 'spectrapdf');

/** The repository's development virtual environment interpreter. */
export const VENV_PYTHON =
  process.platform === 'win32'
    ? resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : resolve(REPO_ROOT, '.venv', 'bin', 'python');

/** `portable::data_root` for that binary: `<exe dir>\data`. */
export const APP_DATA_ROOT = resolve(APP_BINARY, '..', 'data');

/** The session record, written entirely on the Rust side. */
export const SESSION_FILE = resolve(APP_DATA_ROOT, 'session.json');

/** The pre-window startup flags, read before any renderer exists to be asked. */
export const STARTUP_FILE = resolve(APP_DATA_ROOT, 'startup.json');
