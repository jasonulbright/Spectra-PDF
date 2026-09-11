import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { testPython } from './support/python';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('the integration-test Python interpreter', () => {
  it('uses the explicitly selected interpreter even when a dev venv exists', () => {
    vi.stubEnv('SPECTRAPDF_TEST_PYTHON', 'selected-python');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue('C:/selected/python.exe\r\n');
    expect(testPython()).toBe('C:/selected/python.exe');
    expect(execFileSync).toHaveBeenCalledWith('selected-python', expect.any(Array), expect.any(Object));
  });
  it('uses the local dev venv when no interpreter was explicitly selected', () => {
    vi.stubEnv('SPECTRAPDF_TEST_PYTHON', undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue('C:/dev/python.exe\n');
    testPython();
    expect(execFileSync).toHaveBeenCalledWith(resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), expect.any(Array), expect.any(Object));
  });
  it('resolves setup-python from PATH on a clean checkout', () => {
    vi.stubEnv('SPECTRAPDF_TEST_PYTHON', undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockReturnValue('C:/hosted/python.exe\n');
    expect(testPython()).toBe('C:/hosted/python.exe');
    expect(execFileSync).toHaveBeenCalledWith('python', expect.any(Array), expect.any(Object));
  });
  it('refuses a missing interpreter without falling back or skipping', () => {
    vi.stubEnv('SPECTRAPDF_TEST_PYTHON', 'missing-python');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(testPython).toThrow('ENOENT');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
