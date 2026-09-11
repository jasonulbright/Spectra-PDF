import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Use an explicitly selected interpreter, the local dev venv, or CI's
 * setup-python interpreter. A missing interpreter is a failure, never a skip. */
export function testPython(): string {
  const venv = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const candidate = process.env.SPECTRAPDF_TEST_PYTHON ?? (existsSync(venv) ? venv : 'python');
  return execFileSync(candidate, ['-B', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', windowsHide: true }).trim();
}
