import type { AppAction, AppState } from '../state/types';
import { tChrome } from '../i18n';
import { addFormFields, type NewFieldSpec } from './form-authoring';
import { choiceAppearanceFields, verticalFontCalls } from './form-writing';
import { rewriteWorkspaceFile, type WorkspaceRewriteIo } from './workspace-rewrite';

export interface FormCreateIo extends WorkspaceRewriteIo {
  fontDirectory: () => Promise<string>;
  callStaged: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}
function unverified(): Error { return new Error(tChrome('app.formCreate.unverified')); }
function checkReport(value: unknown, stage: string, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unverified();
  const report = value as Record<string, unknown>;
  if (report.output !== stage || !Array.isArray(report.fields)
      || report.fields.length !== names.length || new Set(report.fields).size !== names.length
      || report.fields.some(name => typeof name !== 'string' || !names.includes(name))) throw unverified();
}

/** One field batch, one native replacement and one undo entry. No intermediate
 * pdf-lib rewrite or engine postprocessing ever touches the working path. */
export async function createFormFields(path: string, requested: readonly NewFieldSpec[],
  getState: () => AppState, dispatch: (action: AppAction) => void, io: FormCreateIo): Promise<boolean> {
  if (!requested.length) return true;
  const specs = structuredClone(requested);
  const result = await rewriteWorkspaceFile(path, getState, dispatch, io, async (stage, original, requireCurrent) => {
    await io.write(stage, await addFormFields(original, specs));
    const vertical = verticalFontCalls(specs);
    const choices = choiceAppearanceFields(specs);
    if (vertical.length || choices.length) {
      const fontDir = await io.fontDirectory();
      for (const bind of vertical) {
        requireCurrent();
        checkReport(await io.callStaged('author_vertical_field_font', {
          file: stage, output: stage, fields: bind.fields, script: bind.script,
          font_dir: fontDir, allow_signed: true, // structural consent above
        }), stage, bind.fields);
      }
      if (choices.length) {
        requireCurrent();
        checkReport(await io.callStaged('author_choice_appearance', {
          file: stage, output: stage, fields: choices, font_dir: fontDir, allow_signed: true,
        }), stage, choices);
      }
    }
  }, { kind: 'forms', preservePageCount: true, unverified });
  return result.completed;
}
