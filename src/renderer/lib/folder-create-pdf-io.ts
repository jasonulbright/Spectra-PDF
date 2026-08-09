// Real-IO assembly for the one-PDF-per-folder driver — the thin layer between
// `lib/folder-create-pdf.ts`'s pure state machine and the world: the engine
// through `callRaw` (sources are original paths outside the workspace, so the
// commit gate must not run — it would side-effect-commit unrelated pending
// page edits mid-sweep) and the Rust batch filesystem commands.
import { batch } from './tauri-bridge';
import type { BuildResult, FolderCreatePdfIo, FolderListing } from './folder-create-pdf';

export interface FolderCreatePdfBuildOptions {
  pageSize: string;
  orientation: string;
  marginPt: number;
  imageDpi: number;
  distillPreset: string;
}

export type EngineCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Enumerate the folders a run would build, through the engine's own walk.
 *
 * The grouping and the within-folder order are the ENGINE'S — the same
 * function the CLI arm and a guided action use — so what this listing shows is
 * the run, not a description of it. */
export async function listSourceFolders(
  callRaw: EngineCall,
  source: string,
  options: { sources: string; includeSubfolders: boolean },
): Promise<FolderListing> {
  return (await callRaw('list_source_folders', {
    source,
    sources: options.sources,
    include_subfolders: options.includeSubfolders,
  })) as unknown as FolderListing;
}

export function createFolderCreatePdfIo(
  callRaw: EngineCall,
  tools: { ghostscript: string; soffice: string },
  options: FolderCreatePdfBuildOptions,
): FolderCreatePdfIo {
  return {
    async buildFolder(files, output): Promise<BuildResult> {
      const built = (await callRaw('create_pdf', {
        sources: files.map((path) => ({ path })),
        output,
        page_size: options.pageSize,
        orientation: options.orientation,
        margin_pt: options.marginPt,
        image_dpi_default: options.imageDpi,
        distill_preset: options.distillPreset,
        // One unreadable page must not cost the other forty. A skipped member
        // is never silent: it comes back as a warning naming the file.
        on_unsupported: 'skip',
        gs_path: tools.ghostscript,
        soffice_path: tools.soffice,
      })) as { pages: number; warnings?: string[] };
      return {
        pages: built.pages,
        ...(built.warnings ? { warnings: built.warnings } : {}),
      };
    },
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
  };
}
