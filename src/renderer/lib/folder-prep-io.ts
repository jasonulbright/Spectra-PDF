// Real-IO assembly for the folder form-preparation driver — the thin layer
// between `lib/folder-prep.ts`'s pure state machine and the world: the engine
// through `callRaw` (sources are original paths outside the workspace, so the
// commit gate must not run — it would side-effect-commit unrelated pending
// page edits mid-sweep) and the Rust batch filesystem commands.
//
// The vendored recogniser paths travel with every detect call, not only when
// the run knows it will meet a scan: the arm is chosen per PAGE, inside the
// door.
import { batch } from './tauri-bridge';
import type { DetectRequest, FolderPrepIo } from './folder-prep';
import type { DetectedCandidate, DetectionResult } from './form-candidates';
import type { SignaturePolicy } from './signatures';

export function createFolderPrepIo(
  callRaw: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  tools: { tesseract: string; ghostscript: string; fontDir: string },
): FolderPrepIo {
  return {
    async detect(abs, request: DetectRequest) {
      return (await callRaw('detect_form_fields', {
        file: abs,
        pages: 'all',
        scan: request.scan,
        lang: request.lang,
        tesseract_path: tools.tesseract,
        gs_path: tools.ghostscript,
      })) as DetectionResult;
    },
    async signaturePolicy(abs) {
      return (await callRaw('signature_policy', { path: abs })) as SignaturePolicy;
    },
    async create(abs, output, candidates: DetectedCandidate[], includeSigned) {
      // The rows go back to the engine as they arrived: the grouping that
      // turns four options into one field, the naming and the uniqueness are
      // the engine's, so a folder run and a headless run write the same
      // fields from the same rows.
      const result = (await callRaw('create_detected_fields', {
        file: abs,
        output,
        candidates,
        allow_signed: includeSigned,
        font_dir: tools.fontDir,
      })) as { created?: number };
      return result.created ?? 0;
    },
    copyFile: (src, dest) => batch.copyFile(src, dest),
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
  };
}
