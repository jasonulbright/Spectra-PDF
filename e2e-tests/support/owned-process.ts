import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

/** One supervisor owns one Windows job; closing its control pipe retires only
 * that job. There is intentionally no PID/image-name recovery fallback. */
export function launchOwnedProcess(script: string, executable: string, args: string[],
  env: NodeJS.ProcessEnv = process.env,
  output: (text: string) => void = text => process.stderr.write(text)) {
  const marker = `E2E_JOB_READY_${randomUUID()}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env,
  });
  let readySeen = false;
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  // Attach immediately: spawn failures must not become unhandled rejections.
  void closed.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdin.end();
      reject(new Error('Owned E2E process startup timed out'));
    }, 30_000);
    createInterface({ input: child.stdout }).on('line', line => {
      if (line === marker) { readySeen = true; clearTimeout(timer); resolve(); }
      else output(`${line}\n`);
    });
    child.stderr.on('data', chunk => output(chunk.toString()));
    void closed.then(code => {
      clearTimeout(timer);
      if (!readySeen) reject(new Error(`Owned E2E process failed to start (exit ${code})`));
    }, error => { clearTimeout(timer); reject(error); });
  });
  child.stdin.on('error', () => {}); // Early startup refusal closes the pipe; closed/ready report it.
  child.stdin.write(`${JSON.stringify({ executable, args, ready: marker })}\n`);
  let stopping: Promise<void> | undefined;
  return {
    ready, closed,
    stop(): Promise<void> {
      stopping ??= (async () => {
        child.stdin.end();
        const code = await closed;
        if (code !== 0) throw new Error(`Owned E2E process cleanup failed (exit ${code})`);
      })();
      return stopping;
    },
  };
}
