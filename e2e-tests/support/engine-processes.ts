import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** The binary under test, as `wdio.conf.ts` resolves it. */
const APP_BINARY = process.env.SPECTRAPDF_E2E_APP
  ? resolve(process.env.SPECTRAPDF_E2E_APP)
  : resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

export interface EngineProcess {
  pid: number;
  /** `window`, `job`, `run` or `health`, from `--spectra-role=`. */
  role: string;
  /** The window label from `--spectra-window=`; null for the health worker. */
  window: string | null;
}

/**
 * Every engine process the app under test has started, read from the
 * operating system's process table: the descendants of the one running
 * instance of the binary under test, selected by the role argument each
 * engine spawn appends. A program an engine starts (Ghostscript, Tesseract)
 * carries no role and is not listed.
 */
export function engineProcesses(): EngineProcess[] {
  const script = [
    "$exe = $env:SPECTRA_PROBE_EXE",
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)",
    "$apps = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })",
    "if ($apps.Count -ne 1) { throw \"expected one running app, found $($apps.Count)\" }",
    "$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "$queue = New-Object System.Collections.Queue",
    "[void]$seen.Add([uint32]$apps[0].ProcessId); $queue.Enqueue([uint32]$apps[0].ProcessId)",
    "$found = @()",
    "while ($queue.Count -gt 0) {",
    "  $parent = $queue.Dequeue()",
    "  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {",
    "    if ($seen.Add([uint32]$child.ProcessId)) {",
    "      $queue.Enqueue([uint32]$child.ProcessId)",
    "      $found += [pscustomobject]@{ pid = [uint32]$child.ProcessId; cmd = [string]$child.CommandLine }",
    "    }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($found) -Compress -Depth 3",
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, SPECTRA_PROBE_EXE: APP_BINARY },
  });
  const rows = JSON.parse(out.trim() || '[]') as { pid: number; cmd: string }[];
  const engines: EngineProcess[] = [];
  for (const row of rows) {
    const role = /(?:^|\s)--spectra-role=(\w+)(?=\s|$)/.exec(row.cmd ?? '');
    if (!role) continue;
    const window = /(?:^|\s)--spectra-window=(\S+)(?=\s|$)/.exec(row.cmd);
    engines.push({ pid: row.pid, role: role[1], window: window ? window[1] : null });
  }
  return engines;
}

/** The one engine process of `role` for window `label`; fails on none or several. */
export function onlyEngineProcess(role: string, label: string, among = engineProcesses()): number {
  const matches = among.filter((p) => p.role === role && p.window === label);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${role} process for window ${label}, found ${matches.length}: ${JSON.stringify(among)}`,
    );
  }
  return matches[0].pid;
}

/** Whether process `pid` still exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
