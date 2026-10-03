import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Directories made read-only, with their own mode and the paths holding them. */
const heldDirectories = new Map<string, { mode: number; holders: number }>();
const fileModes = new Map<string, number>();

/**
 * Makes the app's next replacement of `path` fail with a native refusal.
 *
 * Windows refuses to replace a file that carries the read-only attribute. A
 * POSIX rename ignores the file's own mode and checks only the directory, so
 * there the directory is made read-only as well; an in-place write, a write
 * beside the target and the rename over it then all fail with EACCES.
 */
export function refuseWrites(path: string): void {
  if (process.platform === 'win32') {
    chmodSync(path, 0o444);
    return;
  }
  if (!fileModes.has(path)) fileModes.set(path, statSync(path).mode & 0o7777);
  chmodSync(path, 0o444);
  const directory = dirname(path);
  const held = heldDirectories.get(directory);
  if (held) {
    held.holders += 1;
    return;
  }
  heldDirectories.set(directory, { mode: statSync(directory).mode & 0o7777, holders: 1 });
  chmodSync(directory, 0o555);
}

/**
 * Undoes `refuseWrites(path)`. Off Windows the file and its directory get
 * back the modes they had; the directory stays read-only while another path
 * in it is still refused.
 */
export function allowWrites(path: string): void {
  if (process.platform === 'win32') {
    chmodSync(path, 0o666);
    return;
  }
  const directory = dirname(path);
  const held = heldDirectories.get(directory);
  if (held) {
    held.holders -= 1;
    if (held.holders === 0) {
      heldDirectories.delete(directory);
      chmodSync(directory, held.mode);
    }
  }
  chmodSync(path, fileModes.get(path) ?? 0o666);
  fileModes.delete(path);
}
