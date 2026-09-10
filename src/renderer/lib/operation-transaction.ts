import type { AppAction, AppState, OpenFile, PdfBuffer } from '../state/types';
import type { EngineResult } from '../hooks/useEngine';
import { tChrome } from '../i18n';
import { EDIT_DECLINED } from './edit-text';
import type { OpMethod } from './op-edit-class';
import { rewriteWorkspaceFile, type WorkspaceRewriteIo } from './workspace-rewrite';

export interface OperationIo extends WorkspaceRewriteIo {
  callStaged: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  // Covers final validation/publication, not just a successful engine reply.
  track: (method: string, params: Record<string, unknown>, run: () => Promise<EngineResult>) => Promise<EngineResult>;
}
function unverified(): Error { return new Error(tChrome('app.operation.unverified')); }

export interface OperationStep { method: OpMethod; params: Record<string, unknown> }
export interface OperationOptions {
  expectedWorkingPath?: string;
  /** Revision-derived parameters must not survive a gate rebuild. */
  expectedBuffer?: PdfBuffer;
  structuralConsent?: boolean;
  /** One user edit that needs several engine calls: all run on the same private
   * stage and publish together. Not Guided Actions' deliberate per-step undo. */
  following?: readonly OperationStep[];
}
export type WorkspaceOperationResult = EngineResult & { publication: OpenFile };

export async function executeWorkspaceOperation(path: string, method: OpMethod,
  params: Record<string, unknown>, getState: () => AppState,
  dispatch: (action: AppAction) => void, io: OperationIo,
  options: OperationOptions = {}): Promise<WorkspaceOperationResult | null | typeof EDIT_DECLINED> {
  const initial = getState().files.get(path);
  if (!initial || initial.importOnly) return null;
  if (options.expectedWorkingPath !== undefined && initial.workingPath !== options.expectedWorkingPath) {
    throw new Error(tChrome('app.history.changed'));
  }
  const expectedBuffer = options.expectedBuffer;
  const requireSource = () => {
    if (expectedBuffer !== undefined && (getState().files.get(path)?.buffer !== expectedBuffer
        || getState().pageDirtyPaths.includes(path))) throw new Error(tChrome('app.history.changed'));
  };
  requireSource();
  const requested = structuredClone(params);
  const following = structuredClone(options.following ?? []);
  const result = await rewriteWorkspaceFile(path, getState, dispatch, io, async (stage, original, requireCurrent) => {
    requireSource();
    // Byte identity preserves signed originals for engine append/finalization.
    // file==output retains each engine method's existing in-place semantics.
    await io.write(stage, original);
    const runStep = async (stepMethod: OpMethod, stepParams: Record<string, unknown>): Promise<EngineResult> => {
      requireCurrent();
      const answer = await io.callStaged(stepMethod, { ...stepParams, file: stage, output: stage });
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)
          || (answer as Record<string, unknown>).output !== stage) throw unverified();
      return { ...answer, output: initial.workingPath } as EngineResult;
    };
    const reports = [await runStep(method, requested)];
    for (const step of following) reports.push(await runStep(step.method, step.params));
    // Keep operation-specific counts/refusals/warnings. The public output is
    // the stable working path, never the now-retired private stage.
    return reports.length === 1 ? reports[0] : { ...reports[0], stepResults: reports };
  }, { kind: 'operation', unverified,
    track: run => io.track(method, { ...requested, file: initial.workingPath, output: initial.workingPath }, run) });
  return result.completed ? { ...result.value, publication: result.publication } : EDIT_DECLINED;
}
