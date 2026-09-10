import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchOwnedProcess } from '../e2e-tests/support/owned-process';

const script = resolve('e2e-tests/support/owned-process.ps1');
const python = resolve('.venv/Scripts/python.exe');
const fixture = resolve('e2e-tests/support/owned-process-fixture.py');
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 15_000;
  while (!check()) { if (Date.now() > end) throw new Error('process fixture timed out'); await sleep(40); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function paths() {
  const directory = mkdtempSync(resolve('docs/audit/owned-process.local.d-'));
  return { directory, receipt: resolve(directory, 'pids.json') };
}
function launch(mode = 'wait', args: string[] = []) {
  const { receipt } = paths(); let output = '';
  const owned = launchOwnedProcess(script, python, ['-B', fixture, receipt, mode, ...args], process.env, text => { output += text; });
  cleanups.push(() => owned.stop().catch(() => {}));
  return { owned, receipt, output: () => output };
}

describe.skipIf(process.platform !== 'win32')('Windows E2E process ownership', () => {
  it('kills only the owned tree, preserving unrelated Python and another live session', async () => {
    const unrelated = spawn(python, ['-B', '-c', 'import time; time.sleep(120)'], { stdio: 'ignore', windowsHide: true });
    cleanups.push(async () => { unrelated.kill(); });
    const first = launch(); const independent = launch();
    await Promise.all([first.owned.ready, independent.owned.ready]);
    await until(() => existsSync(first.receipt) && existsSync(independent.receipt));
    const firstPids: number[] = JSON.parse(readFileSync(first.receipt, 'utf8'));
    const otherPids: number[] = JSON.parse(readFileSync(independent.receipt, 'utf8'));
    expect(firstPids.every(alive)).toBe(true);
    await first.owned.stop();
    await until(() => firstPids.every(pid => !alive(pid)));
    expect(alive(unrelated.pid!)).toBe(true);
    expect(otherPids.every(alive)).toBe(true);
    await independent.owned.stop();
    await until(() => otherPids.every(pid => !alive(pid)));
    await first.owned.stop(); // idempotent; no global fallback
  }, 40_000);

  it('cleans orphaned descendants when their root exits', async () => {
    const run = launch('exit');
    await run.owned.ready;
    expect(await run.owned.closed).toBe(1);
    const pids: number[] = JSON.parse(readFileSync(run.receipt, 'utf8'));
    await until(() => pids.every(pid => !alive(pid)));
    await expect(run.owned.stop()).rejects.toThrow('cleanup failed');
  }, 40_000);

  it.each(['eof', 'kill'] as const)('cleans the entire job on supervisor %s', async mode => {
    const { receipt } = paths();
    const supervisor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    cleanups.push(async () => { supervisor.kill(); });
    let error = ''; supervisor.stderr.on('data', chunk => { error += chunk.toString(); });
    supervisor.stdout.resume();
    supervisor.stdin.write(JSON.stringify({ executable: python, args: ['-B', fixture, receipt, 'wait'], ready: 'READY' }) + '\n');
    await until(() => existsSync(receipt) || supervisor.exitCode !== null);
    expect(error).toBe('');
    const pids: number[] = JSON.parse(readFileSync(receipt, 'utf8'));
    if (mode === 'eof') supervisor.stdin.end(); else supervisor.kill();
    await until(() => pids.every(pid => !alive(pid)));
  }, 40_000);

  it('round-trips command arguments without a shell and refuses a missing executable', async () => {
    const args = ['a space', 'a"quote', 'trailing\\', '', '日本語', '&whoami'];
    const run = launch('wait', args);
    await run.owned.ready;
    await until(() => run.output().includes('&whoami'));
    expect(JSON.parse(run.output().trim())).toEqual(args);
    const bad = launchOwnedProcess(script, 'no-such-owned-e2e-executable.exe', [], process.env, () => {});
    await expect(bad.ready).rejects.toThrow('failed to start');
    expect(await bad.closed).toBe(1);
  }, 40_000);

  it('the harness has no image-wide or PID-based cleanup fallback', () => {
    const config = readFileSync(resolve('e2e-tests/wdio.conf.ts'), 'utf8');
    expect(config).toContain('await owned.stop()');
    expect(config).toContain('await requireFreeDriverPort()');
    for (const file of ['e2e-tests/wdio.conf.ts', 'e2e-tests/support/owned-process.ts', 'e2e-tests/support/owned-process.ps1', 'e2e-tests/support/owned-process.cs']) {
      expect(readFileSync(resolve(file), 'utf8')).not.toMatch(/taskkill|Stop-Process|Get-Process|\.kill\(/);
    }
  });
});
