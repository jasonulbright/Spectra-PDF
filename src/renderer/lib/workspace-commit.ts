import { buildPdf, buildPdfx, stripExtension } from './pdfx-format';
import { carriesManifest } from './doc-names';
import type { ExportPage } from './pdfx-format';
import type { AppAction, OpenFile, PdfBuffer, Workspace } from '../state/types';

export interface CommitDocumentPlan {
  name: string;
  pages: ExportPage[];
}

export interface CommitFilePlan {
  path: string;
  workingPath: string;
  title: string;
  // buildPdfx (manifest attached) for multi-partition files and .pdfx names;
  // plain buildPdf otherwise. Shared predicate with the reducer's rename rule.
  useManifest: boolean;
  documents: CommitDocumentPlan[];
  pageCount: number;
}

function toBytes(buffer: PdfBuffer): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  return new Uint8Array(buffer);
}

// Pure planning step for the commit bridge: for every dirty file, collect its
// workspace documents (in workspace order) as export pages. Source bytes are
// captured eagerly from the pre-commit buffers so cross-file moves keep their
// page indices consistent no matter the write order. Zero-page compositions
// (defensively — the reducer resets those paths) are never planned: a 0-page
// PDF must not be materialized over a working copy.
export function planCommit(
  workspace: Workspace,
  files: Map<string, OpenFile>,
  dirtyPaths: string[],
): CommitFilePlan[] {
  const bytesByPath = new Map<string, Uint8Array>();
  const bytesFor = (path: string): Uint8Array => {
    let bytes = bytesByPath.get(path);
    if (!bytes) {
      const source = files.get(path);
      if (!source?.buffer) {
        throw new Error(`Cannot commit: source file is no longer open (${path})`);
      }
      bytes = toBytes(source.buffer);
      bytesByPath.set(path, bytes);
    }
    return bytes;
  };

  const plans: CommitFilePlan[] = [];
  for (const path of dirtyPaths) {
    const f = files.get(path);
    if (!f?.buffer) continue;
    const docs = workspace.documents.filter((d) => d.path === path);
    if (docs.length === 0) continue;
    const documents: CommitDocumentPlan[] = docs.map((d) => ({
      name: d.name,
      pages: d.pages.map(
        (p): ExportPage => ({
          bytes: bytesFor(p.sourceDocId),
          sourceKey: p.sourceDocId,
          pageIndex: p.sourcePageIndex,
          ...(p.rotation ? { rotation: p.rotation } : {}),
        }),
      ),
    }));
    const pageCount = documents.reduce((sum, d) => sum + d.pages.length, 0);
    if (pageCount === 0) continue;
    plans.push({
      path,
      workingPath: f.workingPath,
      title: stripExtension(f.name),
      useManifest: carriesManifest(f.name, docs.length),
      documents,
      pageCount,
    });
  }
  return plans;
}

export async function buildCommitBytes(plan: CommitFilePlan): Promise<Uint8Array> {
  return plan.useManifest
    ? buildPdfx(plan.documents, plan.title)
    : buildPdf(plan.documents[0].pages);
}

interface CommitDeps {
  workspace: Workspace;
  files: Map<string, OpenFile>;
  dirtyPaths: string[];
  dispatch: (action: AppAction) => void;
  snapshot: (workingPath: string) => Promise<string>;
  writeBuffer: (filePath: string, bytes: Uint8Array) => Promise<unknown>;
  rename: (fromPath: string, toPath: string) => Promise<unknown>;
  remove: (filePath: string) => Promise<unknown>;
}

// Temp names are unique per run so a stale leftover (crash, prior failure)
// can never be renamed into place by a later commit.
let commitSeq = 0;
// Loud reentrancy guard: concurrent runs stage/rename the same working files
// and consume each other's temps. Callers must serialize (App shares one
// in-flight promise across all commit entry points); this turns a bypass of
// that contract into an explicit error instead of silent file corruption.
let commitRunning = false;

// Materialize pending page edits: rebuild every dirty file via pdf-lib and
// land the rebuilds on the snapshot undo chain in one atomic dispatch. All
// dirty paths commit together — cross-file moves entangle files, so partial
// commits would desync source page indices.
//
// Transactional against write failures: all bytes are staged to *.commit-tmp
// first; only when every stage succeeded are the originals snapshotted and
// the temps renamed into place. A failure before the rename phase deletes the
// temps and leaves both disk and state untouched, so a retry re-plans from
// the same pre-commit buffers and produces identical bytes. (A failure among
// the renames themselves still retries cleanly for the same reason — state
// buffers never change until the final dispatch.)
export async function commitPageEdits({
  workspace,
  files,
  dirtyPaths,
  dispatch,
  snapshot,
  writeBuffer,
  rename,
  remove,
}: CommitDeps): Promise<void> {
  if (commitRunning) {
    throw new Error('commitPageEdits is already running — callers must share the in-flight run');
  }
  commitRunning = true;
  try {
    const plans = planCommit(workspace, files, dirtyPaths);
    if (plans.length === 0) {
      dispatch({ type: 'CLEAR_PAGE_EDITS' });
      return;
    }
    const built = await Promise.all(plans.map(buildCommitBytes));

    const runTag = `.commit-tmp-${++commitSeq}`;
    const staged: string[] = [];
    const updates: { path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string }[] =
      [];
    try {
      for (let i = 0; i < plans.length; i++) {
        const tmp = plans[i].workingPath + runTag;
        await writeBuffer(tmp, built[i]);
        staged.push(tmp);
      }
      for (let i = 0; i < plans.length; i++) {
        const snapshotPath = await snapshot(plans[i].workingPath);
        await rename(staged[i], plans[i].workingPath);
        updates.push({
          path: plans[i].path,
          pageCount: plans[i].pageCount,
          buffer: built[i],
          snapshotPath,
        });
      }
    } catch (err) {
      await Promise.all(staged.map((tmp) => Promise.resolve(remove(tmp)).catch(() => {})));
      throw err;
    }
    dispatch({ type: 'COMMIT_PAGE_EDITS', updates });
  } finally {
    commitRunning = false;
  }
}
