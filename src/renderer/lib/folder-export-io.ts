// Real-IO assembly for the folder-export driver — the thin layer between
// `lib/folder-export.ts`'s pure state machine and the world: the engine through
// `callRaw` (sources are original paths outside the workspace, so the commit
// gate must not run — it would side-effect-commit unrelated pending page edits
// mid-sweep) and the Rust batch filesystem commands.
//
// The engine applies a request's params as keyword arguments, so a tool path
// the chosen door does not take is a TypeError rather than an ignored extra:
// the document door reads both, the image door reads only the renderer.
import { batch } from './tauri-bridge';
import type { FolderExportIo } from './folder-export';
import { EXPORT_TARGETS } from './export-targets';

export function createFolderExportIo(
  callRaw: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  tools: { soffice: string; ghostscript: string },
): FolderExportIo {
  return {
    async exportFile(abs, output, format, params) {
      const door = EXPORT_TARGETS[format].door;
      const toolPaths =
        door === 'export_images'
          ? { gs_path: tools.ghostscript }
          : { soffice_path: tools.soffice, gs_path: tools.ghostscript };
      return (await callRaw(door, {
        ...params,
        file: abs,
        output,
        ...toolPaths,
      })) as never;
    },
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
  };
}
