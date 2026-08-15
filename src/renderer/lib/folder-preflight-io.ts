// Real-IO assembly for the droplet driver — the thin layer between
// `lib/folder-preflight.ts`'s pure post-pass and the world.
//
// The engine is reached through `callRaw`: a sweep reads original paths
// outside the workspace, so the commit gate must not run — it would
// side-effect-commit unrelated pending page edits mid-sweep. That is the
// batch-OCR rule, and it applies here for its own reason.
//
// The two file calls go around the capability-scoped filesystem plugin, whose
// scope is the app's own temp tree: a sweep's destination is a folder the user
// picked, and a report is exactly the artifact `write_report_file` exists to
// write at an arbitrary path.
import { batch, report as reportFile } from './tauri-bridge';
import type { FolderPreflightIo, SweepRunReport } from './folder-preflight';
import type { PreflightReport } from './preflight-report';

export function createFolderPreflightIo(
  callRaw: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): FolderPreflightIo {
  return {
    run: async (params) =>
      (await callRaw('run_preflight_sweep', params)) as SweepRunReport,
    readReport: async (path) => {
      const bytes = await batch.readFileBuffer(path);
      return JSON.parse(new TextDecoder().decode(bytes)) as PreflightReport;
    },
    writeReport: (path, contents) => reportFile.write(path, contents),
  };
}
