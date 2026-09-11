import type { AppState, OpenFile } from '../state/types';
import { tChrome } from '../i18n';

export function createOwnedDocumentRuns(readState: () => AppState) {
  let active: object | null = null, lifetime = 0, mounted = true;
  const begin = (file: OpenFile | null) => {
    if (!mounted || active || !file?.buffer) return null;
    const ticket = {}, owner = lifetime;
    let source = file, prepared = false, abandoned = false;
    active = ticket;
    const visible = () => mounted && owner === lifetime && !abandoned && active === ticket
      && readState().activeFileId === file.path && readState().files.get(file.path)?.workingPath === file.workingPath;
    const isCurrent = () => visible() && readState().files.get(file.path)?.buffer === source.buffer
      && !readState().pageDirtyPaths.includes(file.path);
    const assertCurrent = () => { if (!isCurrent()) throw new Error(tChrome('app.history.changed')); };
    return {
      get source() { return source; },
      visible, isCurrent, assertCurrent,
      synchronize: () => {
        if (!visible() || prepared && !isCurrent()) abandoned = true;
      },
      prepare: async (commit: () => Promise<void>) => {
        if (!visible() || readState().files.get(file.path)?.buffer !== file.buffer) throw new Error(tChrome('app.history.changed'));
        await commit();
        if (!visible()) throw new Error(tChrome('app.history.changed'));
        const next = readState().files.get(file.path)!;
        if (next.buffer !== file.buffer && (next.authoredIdentity?.sourceBuffer !== file.buffer
            || next.authoredIdentity.buffer !== next.buffer)) throw new Error(tChrome('app.history.changed'));
        source = next; prepared = true; assertCurrent();
      },
      finish: () => { if (active === ticket) active = null; },
    };
  };
  return { begin, activate: () => { mounted = true; lifetime++; },
    deactivate: () => { mounted = false; lifetime++; } };
}
export type OwnedDocumentRun = NonNullable<ReturnType<ReturnType<typeof createOwnedDocumentRuns>['begin']>>;
