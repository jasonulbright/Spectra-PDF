import { buildPdf, buildPdfx, stripExtension } from './pdfx-format';
import { carriesManifest } from './doc-names';
import type { ExportPage } from './pdfx-format';
import type { AppAction, OpenDocument, OpenFile, PdfBuffer, Workspace } from '../state/types';
// The one refusal here that reaches the user resolves through
// the catalog (the concurrent-entry throw below is an internal invariant —
// a programming error nobody is meant to read, so it stays English).
import { tChrome } from '../i18n';

// A page's 1-based position within its file's committed order: pages of all
// same-path documents in workspace order — what the file looks like after
// this bridge materializes pending edits. Callers that hand the number to
// something reading the file (inspector, extract-text, redaction) commit
// first, so on-disk order matches. Lives here (not workspace.ts) because it
// describes committed order — and stays importable in Node tests, where
// workspace.ts's pdf.js renderer chain can't load.
export function workspacePageNumber(
  docs: OpenDocument[],
  doc: OpenDocument,
  pageId: string,
): number | null {
  const index = doc.pages.findIndex((p) => p.id === pageId);
  if (index === -1) return null;
  let before = 0;
  for (const d of docs) {
    if (d.path !== doc.path) continue;
    if (d.id === doc.id) return before + index + 1;
    before += d.pages.length;
  }
  return null;
}

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
  // The identity channel: the old ids IN THE ORDER the new
  // file's pages/partitions are written — this plan IS the old→new
  // mapping, published instead of discarded. Adopted by the post-commit
  // reindex (lib/durable-identity.ts).
  authoredPageIds: string[];
  authoredDocuments: { id: string; name: string }[];
  // The file's own PRIOR bytes — the carry source for document-level catalog
  // trees (/Names /EmbeddedFiles, /Collection) that pdf-lib's page copies
  // leave behind (embedded-files-carry.ts). Own bytes only: pages inserted
  // from another document must not import that document's attachments.
  ownBytes: Uint8Array;
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
        throw new Error(tChrome('refusal.commit.sourceClosed', { path }));
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
          ...(p.annotations?.length
            ? {
                annotations: p.annotations.map(
                  ({ kind, x, y, w, h, color, note, points, strokes, imageData, markupType, quads, measureKind, measureRatio, measureUnitsPerPt, measureUnit, shapeType, strokeWidth, fillColor, opacity, calloutBox, lineEndings, cloudIntensity, countGroup, countSymbol, countSeq, legendRows, legendTitle, legendTotalWord, symbolId, symbolParts, importedOriginal }) => ({
                    kind,
                    x,
                    y,
                    w,
                    h,
                    color,
                    note,
                    points,
                    strokes, // Ink's per-pen-lift paths (the ALLOWLIST trap)
                    imageData,
                    markupType,
                    quads,
                    measureKind,
                    measureRatio,
                    measureUnitsPerPt,
                    measureUnit,
                    // Rung 2 — the shape/callout fields the builder reads.
                    shapeType,
                    strokeWidth,
                    fillColor,
                    opacity,
                    calloutBox,
                    lineEndings,
                    cloudIntensity,
                    // The count mark's group/symbol/sequence and
                    // the placed legend's snapshot rows. The ALLOWLIST trap
                    // again: a field absent from this map never reaches the
                    // builder, however faithfully the type carries it.
                    countGroup,
                    countSymbol,
                    countSeq,
                    legendRows,
                    legendTitle,
                    legendTotalWord,
                    // A placed symbol's registry id and its own
                    // carried geometry (the same allowlist trap).
                    symbolId,
                    symbolParts,
                    importedOriginal,
                  }),
                ),
              }
            : {}),
          ...(p.removedImportedOriginals?.length
            ? { removedImportedOriginals: p.removedImportedOriginals }
            : {}),
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
      authoredPageIds: docs.flatMap((d) => d.pages.map((p) => p.id)),
      authoredDocuments: docs.map((d) => ({ id: d.id, name: d.name })),
      ownBytes: toBytes(f.buffer),
    });
  }
  return plans;
}

export async function buildCommitBytes(plan: CommitFilePlan): Promise<Uint8Array> {
  // plan.path doubles as the OWN sourceKey (ExportPage.sourceKey is the
  // sourceDocId, which IS the path for the file's own pages) — the identity
  // the catalog carry keys on.
  return plan.useManifest
    ? buildPdfx(plan.documents, plan.title, plan.ownBytes, plan.path)
    : buildPdf(plan.documents[0].pages, plan.ownBytes, plan.path);
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
  /** Rewrite a staged temp as an incremental append onto the SIGNED
   *  working copy (engine `transplant_incremental`). Returns whether it
   *  applied — false covers unsigned files and out-of-scope deltas (page
   *  removal/reorder, content edits), which keep the plain rewrite. */
  preserveSignatures?: (workingPath: string, stagedPath: string) => Promise<boolean>;
  /** Read a staged file's bytes back — the state buffer must carry the
   *  TRANSPLANTED bytes, not the pdf-lib rebuild's (buffer identity keys
   *  the reindex). Required whenever preserveSignatures is supplied. */
  readBack?: (filePath: string) => Promise<Uint8Array>;
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
  preserveSignatures,
  readBack,
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
    const updates: {
      path: string;
      pageCount: number;
      buffer: PdfBuffer;
      snapshotPath: string;
      authored: { pages: string[]; documents: { id: string; name: string }[] };
    }[] = [];
    try {
      for (let i = 0; i < plans.length; i++) {
        const tmp = plans[i].workingPath + runTag;
        await writeBuffer(tmp, built[i]);
        staged.push(tmp); // before the transplant attempt — cleanup owns it either way
        // An annotation-tier commit on a SIGNED file lands as an
        // incremental append instead of the pdf-lib rewrite, so the
        // signature keeps verifying. Failure here (engine down, refusal)
        // NEVER blocks the commit — the rewrite is the standing behavior
        // and the fallback for every out-of-scope delta.
        if (preserveSignatures && readBack) {
          try {
            if (await preserveSignatures(plans[i].workingPath, tmp)) {
              built[i] = await readBack(tmp);
            }
          } catch (err) {
            console.warn('signature-preserving commit unavailable:', err);
          }
        }
      }
      for (let i = 0; i < plans.length; i++) {
        const snapshotPath = await snapshot(plans[i].workingPath);
        await rename(staged[i], plans[i].workingPath);
        updates.push({
          path: plans[i].path,
          pageCount: plans[i].pageCount,
          buffer: built[i],
          snapshotPath,
          authored: {
            pages: plans[i].authoredPageIds,
            documents: plans[i].authoredDocuments,
          },
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
