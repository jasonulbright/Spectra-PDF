// Real-IO assembly for the disk Search & Redact driver — the thin layer
// between `lib/disk-redact.ts`'s pure state machine and the world: the engine
// through `callRaw` (sources are original paths outside the workspace, so the
// commit gate must not run — it would side-effect-commit unrelated pending
// page edits mid-sweep) and the Rust batch filesystem commands.
//
// The redaction appearance lives here rather than in the driver: it is the
// persisted record the canvas band and the Search & Redact panel already
// share, so a code chosen on either of them is on the folder run too.
import { batch } from './tauri-bridge';
import { loadRedactionProperties, propertiesPayload } from './redaction-properties';
import type { DiskRedactIo, RedactRegion } from './disk-redact';
import type { SearchRequest } from './search-redact';
import type { SignaturePolicy } from './signatures';

export function createDiskRedactIo(
  callRaw: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  fontDir: string,
): DiskRedactIo {
  return {
    async search(abs, request: SearchRequest) {
      return (await callRaw('search_text_regions', {
        file: abs,
        query: request.query,
        terms: request.terms,
        patterns: request.patterns,
        pages: request.pages ?? 'all',
        regex: !!request.options.regex,
        case_sensitive: !!request.options.caseSensitive,
        whole_word: !!request.options.wholeWord,
        expand: request.expand,
        max_hits: request.maxHits,
      })) as Awaited<ReturnType<DiskRedactIo['search']>>;
    },
    async signaturePolicy(abs) {
      return (await callRaw('signature_policy', { path: abs })) as SignaturePolicy;
    },
    async write(abs, output, regions: RedactRegion[], marksOnly) {
      const properties = propertiesPayload(loadRedactionProperties());
      const payload = regions.map((region) => ({ ...region, ...properties }));
      if (marksOnly) {
        await callRaw('save_redaction_marks', { file: abs, output, regions: payload });
        return;
      }
      // The font-measured redactor is the only apply path, and the font
      // directory is what lets a non-Latin-1 overlay embed rather than draw
      // question marks over a redaction code.
      await callRaw('redact', { file: abs, output, regions: payload, font_dir: fontDir });
    },
    copyFile: (src, dest) => batch.copyFile(src, dest),
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
  };
}
