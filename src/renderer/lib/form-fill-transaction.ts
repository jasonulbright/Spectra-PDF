import type { AppAction, AppState, OpenFile, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';
import { readFormFields, type FormFieldValue, type FormReadResult } from './forms';
import { fillClosure, formCalculation, resolveFillTargets } from './form-overlay';
import { classifyFillResult } from './fill-result';
import { rewriteWorkspaceFile, type WorkspaceRewriteIo } from './workspace-rewrite';
import type { EngineCall } from './engine-call';

export interface FormFillIo extends Omit<WorkspaceRewriteIo, 'confirm'> {
  confirm: (path: string, policyPath: string, targets: readonly string[], typed: readonly string[], flatten: boolean) => Promise<boolean>;
  callStaged: EngineCall;
  fontDirectory: () => Promise<string>;
  track: (run: () => Promise<void>) => Promise<void>;
}
function unverified(): Error { return new Error(tChrome('panel.forms.fillUnverified')); }
function bytes(buffer: PdfBuffer): Uint8Array {
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer.slice(0)) : new Uint8Array(buffer);
}

export interface FormFillOptions {
  flatten?: boolean;
  expectedWorkingPath?: string;
  /** A panel draft's loaded revision; unlike a fresh canvas fill, stale page
   * edits must not silently change which field the draft names. */
  expectedBuffer?: PdfBuffer;
  /** Bind a read-modify-write (e.g. spelling offsets) to the actual field value,
   * including after the commit gate renames fields. */
  expectedValues?: Record<string, FormFieldValue>;
  changedMessage?: string;
}
export interface FormFillReceipt { completed: true; publication: OpenFile }
function sameValue(a: FormFieldValue, b: FormFieldValue): boolean {
  return Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
}

/** Consent and field fingerprints belong to the same immutable bytes as the
 * eventual rewrite. Re-read after the page gate renames imported fields, then
 * ask about the remapped typed names AND their calculation closure. Neither
 * inspection nor filling can change working bytes before native publication. */
export async function fillFormValues(path: string, values: Record<string, FormFieldValue>,
  getState: () => AppState, dispatch: (action: AppAction) => void, io: FormFillIo,
  options: FormFillOptions = {}): Promise<FormFillReceipt | { completed: false }> {
  const requested = structuredClone(values);
  const { expectedBuffer, ...rest } = options;
  const settings = structuredClone(rest);
  const requireDraftRevision = () => {
    if (expectedBuffer !== undefined && (getState().files.get(path)?.buffer !== expectedBuffer
        || getState().pageDirtyPaths.includes(path))) throw new Error(tChrome('app.history.changed'));
  };
  requireDraftRevision();
  if (settings.expectedWorkingPath !== undefined
      && getState().files.get(path)?.workingPath !== settings.expectedWorkingPath) throw unverified();
  if (!Object.keys(requested).length && !settings.flatten) {
    const publication = getState().files.get(path);
    if (!publication?.buffer || publication.importOnly) throw unverified();
    return { completed: true, publication };
  }
  let pre: FormReadResult | undefined;
  let resolved: Record<string, FormFieldValue> = {};
  const result = await rewriteWorkspaceFile(path, getState, dispatch, {
    ...io,
    confirm: async (source, working) => {
      requireDraftRevision();
      const buffer = getState().files.get(source)?.buffer;
      if (!buffer) throw unverified();
      const inspection = `${working}.forms-policy-${crypto.randomUUID()}.pdf`;
      try {
        await io.write(inspection, bytes(buffer));
        const post = await readFormFields(io.callStaged, inspection, true);
        if (!pre) {
          pre = post;
          // Never use the resolver's legacy name-only fallback when the
          // authoritative pre-gate read failed to account for a typed field.
          if (Object.keys(requested).some(name => !pre!.fields.some(f => f.name === name))) throw unverified();
        }
        const resolution = resolveFillTargets(pre.fields, post.fields, requested);
        if (resolution.skipped.length) {
          throw new Error(resolution.skipped.map(s => `"${s.name}": ${s.reason}`).join('; '));
        }
        resolved = resolution.resolved;
        if (settings.expectedValues) {
          const expected = resolveFillTargets(pre.fields, post.fields, settings.expectedValues);
          if (expected.skipped.length || Object.entries(expected.resolved).some(([name, value]) => {
            const field = post.fields.find(f => f.name === name);
            return !field || !sameValue(field.value, value);
          })) throw new Error(settings.changedMessage ?? tChrome('app.history.changed'));
        }
        const typed = Object.keys(resolved);
        if (typed.length !== Object.keys(requested).length) throw unverified();
        const targets = fillClosure(formCalculation(post.fields, post.calculationOrder), typed);
        return await io.confirm(source, inspection, targets, typed, settings.flatten === true);
      } finally {
        await io.remove(inspection).catch(() => {});
      }
    },
  }, async (stage, original, requireCurrent) => {
    requireDraftRevision();
    await io.write(stage, original);
    const fontDir = await io.fontDirectory();
    requireCurrent();
    const report = await io.callStaged('fill_form_fields', {
      file: stage, output: stage, edits: resolved, font_dir: fontDir, flatten: settings.flatten === true,
    });
    const outcome = classifyFillResult(report, Object.keys(resolved).length, stage);
    if (outcome.kind === 'refused') {
      throw outcome.refusal.kind === 'incomplete'
        ? new Error(tChrome('panel.forms.fillIncomplete', { named: outcome.refusal.requested, written: outcome.refusal.filled }))
        : unverified();
    }
    if ((report as Record<string, unknown>).flattened !== (settings.flatten === true)) throw unverified();
  }, { kind: 'forms', preservePageCount: true, unverified, track: io.track });
  return result.completed ? { completed: true, publication: result.publication } : result;
}
