import type { AppAction, AppState } from '../state/types';
import { tChrome } from '../i18n';
import type { EngineCall } from './engine-call';
import { decodeToRawSource, engineWantsRawFallback, isJpegPath, isSvgPath, jpegExifOrientation,
  type AddImageSource, type ReplacementSource } from './image-replace';
import { rewriteWorkspaceFile, type WorkspaceRewriteIo } from './workspace-rewrite';

export type ImageEdit =
  | { kind: 'replace'; page: number; index: number; source?: ReplacementSource }
  | { kind: 'add'; page: number; rect: [number, number, number, number] | null; at?: [number, number]; source?: AddImageSource };
export interface ImageEditIo extends WorkspaceRewriteIo {
  pick: (allowSvg: boolean) => Promise<string | null>;
  readSource: (path: string) => Promise<Uint8Array>;
  decode: typeof decodeToRawSource;
  callStaged: EngineCall;
  track: (method: string, working: string, run: () => Promise<void>) => Promise<void>;
}
function unverified(): Error { return new Error(tChrome('app.operation.unverified')); }

/** JPEG passthrough and its raw-pixel fallback are one gesture. A refused
 * attempt is discarded, never used as the input to its fallback; only the
 * final validated stage can produce working bytes or an undo entry. */
export async function editWorkspaceImage(path: string, edit: ImageEdit, getState: () => AppState,
  dispatch: (action: AppAction) => void, io: ImageEditIo): Promise<boolean> {
  const request = structuredClone(edit);
  let source: AddImageSource | undefined = request.source;
  let picked: string | null = null;
  let prepared = false;
  let method = request.kind === 'replace' ? 'replace_page_image' : 'add_page_image';
  let workingPath = '';
  const result = await rewriteWorkspaceFile(path, getState, dispatch, {
    ...io,
    confirm: async (logical, working) => {
      workingPath = working;
      if (!await io.confirm(logical, working)) return false;
      if (!prepared) {
        if (!source) {
          picked = await io.pick(request.kind === 'add');
          if (!picked) return false;
          if (request.kind === 'add' && isSvgPath(picked)) source = { svg_path: picked };
          else if (isJpegPath(picked) && jpegExifOrientation(await io.readSource(picked)) === 1) source = { jpeg_path: picked };
        }
        if (source && 'svg_path' in source) method = 'add_page_vector_graphic';
        prepared = true;
      }
      return true;
    },
  }, async (stage, original, requireCurrent) => {
    const temps: string[] = [];
    const writeTemp = async (data: Uint8Array): Promise<string> => {
      const temp = `${stage}.${crypto.randomUUID()}.raw`;
      temps.push(temp); // even a partial failed write is ours to retire
      await io.write(temp, data);
      return temp;
    };
    const placement = request.kind === 'replace' ? { index: request.index, fit: 'contain' }
      : request.rect ? { rect: request.rect, fit: 'contain' } : { at: request.at };
    const invoke = async (input: AddImageSource) => {
      requireCurrent();
      const params = 'svg_path' in input
        ? { ...(request.kind === 'add' && request.rect ? { rect: request.rect } : { at: request.kind === 'add' ? request.at : undefined }), svg_path: input.svg_path }
        : { ...placement, source: input };
      const report = await io.callStaged(method, { ...params, page: request.page, file: stage, output: stage });
      if (!report || typeof report !== 'object' || Array.isArray(report)
          || (report as Record<string, unknown>).output !== stage) throw unverified();
    };
    try {
      await io.write(stage, original);
      if (source) {
        try { await invoke(source); return; }
        catch (error) {
          if (!picked || !('jpeg_path' in source) || !engineWantsRawFallback(error instanceof Error ? error.message : String(error))) throw error;
          // The rejected engine attempt may have dirtied its private stage.
          await io.write(stage, original);
        }
      }
      if (!picked) throw unverified();
      const raw = await io.decode(await io.readSource(picked), writeTemp);
      await invoke(raw);
    } finally {
      for (const temp of temps) await io.remove(temp).catch(() => {});
    }
  }, { kind: 'operation', preservePageCount: true, unverified,
    track: run => io.track(method, workingPath, run) });
  return result.completed;
}
