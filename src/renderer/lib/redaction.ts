// Pending-redaction marks and their conversion into the engine's `redact`
// payload. Marks are TRANSIENT VIEW STATE owned by WorkspaceCanvasView — they
// are deliberately NOT PageAnnotations and never enter the page-edit tier:
// the tier commits by rebuilding file bytes in the renderer, while redaction
// is an engine (Python) operation. A mark is bound to a page id, and page ids
// are generation-tagged: bytes that a page-tier commit did not compose take
// new ids, so a mark can never re-bind to another physical page. A mark lives
// while its page does (`marksAcross`) and dies with the canvas view; an
// unsaved mark that dies with its page is counted for a notice. The apply
// path routes through App's performOperation so the commit gate materializes
// pending page edits first and the result lands on the snapshot undo chain.
import { displayRectToPdf } from './pdfx-build';
import { EDIT_DECLINED } from './edit-text';
import { workspacePageNumber } from './workspace-commit';
import { pathDescribesCurrentBytes } from './workspace-settle';
import { propertiesPayload, type RedactionProperties } from './redaction-properties';
import type { AppState, OpenDocument, PageRef } from '../state/types';

export interface RedactionMark {
  id: string;
  // The file whose bytes the mark was drawn on: the holder of its page at draw
  // time, or the file a page-tier commit wrote the page into since. Page
  // resolution goes by pageId, so a mark follows its page through in-memory
  // moves.
  path: string;
  pageId: string;
  // Display-normalized (0..1 of the page cell) in the orientation the page
  // was shown at draw time — i.e. the file's baked /Rotate composed with the
  // PageRef's in-memory rotation at that moment.
  rect: { x: number; y: number; w: number; h: number };
  // The PageRef's in-memory rotation DELTA at draw time only — NOT the
  // composed orientation the rect comment above describes. The baked /Rotate
  // half is read from the file at apply time (PageGeometry.bakedRotate) and
  // composed there; storing the composition here would double-count it.
  rotationAtDraw: 0 | 90 | 180 | 270;
  // The mark's own appearance — fill, overlay text, repeat,
  // alignment, size and colour. Per MARK, not per apply: a user marks some
  // regions under one FOIA exemption and others under another in the same
  // pass, and one global setting at apply time could not express that.
  // Absent = the plain black box a mark with no properties carries.
  props?: RedactionProperties;
  // A projection of a /Redact annotation the file stores, not a mark drawn
  // this session.
  seeded?: true;
  // The apply or save run that writes this mark into the file, while it runs.
  consumedBy?: string;
}

/**
 * `marks` once the seed of `path`'s stored marks lands: the path's earlier
 * seeded marks give way to `seeded`, and every mark drawn on the path since
 * its bytes changed stays. The seed reads the file after its bytes change,
 * and anything drawn meanwhile is not in the file. An empty `seeded` is a
 * file that stores no marks.
 */
export function withSeededMarks(
  marks: RedactionMark[],
  path: string,
  seeded: readonly RedactionMark[],
): RedactionMark[] {
  if (seeded.length === 0 && !marks.some((m) => m.path === path && m.seeded)) return marks;
  return [
    ...marks.filter((m) => m.path !== path || !m.seeded),
    ...seeded.map((m): RedactionMark => ({ ...m, seeded: true })),
  ];
}

/** A canvas's marks, and the unsaved ones it lost. */
export interface MarkLedger {
  marks: RedactionMark[];
  /** Unsaved marks whose page is gone for good. Monotonic: each increase is
   * owed a notice. */
  cleared: number;
  /** Per apply or save run, how many of its marks left with their page while
   * it ran. The run's outcome decides whether the file took them. */
  awaiting: Readonly<Record<string, number>>;
}

export const EMPTY_MARK_LEDGER: MarkLedger = { marks: [], cleared: 0, awaiting: {} };

type MarkWorld = Pick<AppState, 'files' | 'workspace' | 'pageUndoStack' | 'pageRedoStack'>;

/** Each page, with the path of the document holding it. */
function pagesById(documents: readonly OpenDocument[]): Map<string, { page: PageRef; holder: string }> {
  return new Map(documents.flatMap((d) => d.pages.map((page) => [page.id, { page, holder: d.path }] as const)));
}

/** The pages a page-tier undo or redo can bring back. */
function stackedPageIds(world: MarkWorld): Set<string> {
  const ids = new Set<string>();
  for (const entry of [...world.pageUndoStack, ...world.pageRedoStack]) {
    for (const d of entry.documents) for (const p of d.pages) ids.add(p.id);
  }
  return ids;
}

function quarterTurn(degrees: number): 0 | 90 | 180 | 270 {
  return (((degrees % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/**
 * `mark` on `now`, the page it was on as `was`. Where the page reads from
 * other bytes, a page-tier commit wrote it: the pending rotation went into
 * the page, so the frame the mark was drawn in is that much less turned
 * relative to the new bytes, and the mark belongs to the file now holding it.
 */
function carriedMark(
  mark: RedactionMark,
  was: PageRef | undefined,
  now: PageRef,
  before: MarkWorld,
  after: MarkWorld,
): RedactionMark {
  if (!was) return mark;
  if (before.files.get(was.sourceDocId)?.buffer === after.files.get(now.sourceDocId)?.buffer) return mark;
  return {
    ...mark,
    path: now.sourceDocId,
    rotationAtDraw: quarterTurn(mark.rotationAtDraw - (was.rotation - now.rotation)),
  };
}

/**
 * `ledger` once the workspace moves from `before` to `after` in one dispatch.
 *
 * A mark lives while the documents hold its page, or a page-tier undo or redo
 * can bring the page back. Page ids are generation-tagged and a page-tier
 * commit keeps them, so a page that keeps its id is the same page.
 *
 * A mark whose page is gone for good leaves. An unsaved one that was on a
 * page of the documents just before is counted in `cleared`, except when the
 * file whose document held the page, or the file the page came from, closed,
 * or when an apply or save of it runs: that run's outcome decides
 * (`marksAfterRun`). A mark whose page had already left the documents left
 * view with it, by an edit the user made. A seeded mark leaves without a
 * count: the seed of the new bytes brings back what the file stores.
 */
export function marksAcross(ledger: MarkLedger, before: MarkWorld, after: MarkWorld): MarkLedger {
  if (ledger.marks.length === 0) return ledger;
  if (
    before.workspace === after.workspace &&
    before.files === after.files &&
    before.pageUndoStack === after.pageUndoStack &&
    before.pageRedoStack === after.pageRedoStack
  ) {
    return ledger;
  }
  const was = pagesById(before.workspace.documents);
  const now = pagesById(after.workspace.documents);
  let restorable: Set<string> | undefined;
  const marks: RedactionMark[] = [];
  let cleared = ledger.cleared;
  let awaiting = ledger.awaiting;
  let changed = false;
  for (const mark of ledger.marks) {
    const held = now.get(mark.pageId);
    if (held) {
      const carried = carriedMark(mark, was.get(mark.pageId)?.page, held.page, before, after);
      if (carried !== mark) changed = true;
      marks.push(carried);
      continue;
    }
    restorable ??= stackedPageIds(after);
    if (restorable.has(mark.pageId)) {
      marks.push(mark);
      continue;
    }
    changed = true;
    const last = was.get(mark.pageId);
    if (mark.seeded || !last) continue;
    if (!after.files.has(last.holder) || !after.files.has(last.page.sourceDocId)) continue;
    if (mark.consumedBy !== undefined) {
      awaiting = { ...awaiting, [mark.consumedBy]: (awaiting[mark.consumedBy] ?? 0) + 1 };
      continue;
    }
    cleared += 1;
  }
  return changed ? { marks, cleared, awaiting } : ledger;
}

/** `ledger` with the marks `ids` taken by the apply or save run `run`. */
export function marksInRun(ledger: MarkLedger, ids: readonly string[], run: string): MarkLedger {
  const taken = new Set(ids);
  if (!ledger.marks.some((m) => taken.has(m.id))) return ledger;
  return {
    ...ledger,
    marks: ledger.marks.map((m) => (taken.has(m.id) ? { ...m, consumedBy: run } : m)),
  };
}

/**
 * `ledger` once the run `run` ends. A run that wrote into the file took its
 * marks: those still here go, and those that left with their page were
 * written, not lost. A run that wrote nothing leaves its marks pending, and
 * those that left with their page meanwhile are lost.
 */
export function marksAfterRun(ledger: MarkLedger, run: string, wrote: boolean): MarkLedger {
  const { [run]: owed = 0, ...awaiting } = ledger.awaiting;
  const marks = wrote
    ? ledger.marks.filter((m) => m.consumedBy !== run)
    : ledger.marks.map((m) => {
        if (m.consumedBy !== run) return m;
        const { consumedBy: _run, ...pending } = m;
        return pending;
      });
  return { marks, cleared: wrote ? ledger.cleared : ledger.cleared + owed, awaiting };
}

// Geometry of the page as it exists in the CURRENT file bytes, read from the
// pdf.js proxy at apply time. `box` is page.view (the crop-intersected box —
// the same box the annotation import and commit sides use); `bakedRotate` is
// page.rotate, the /Rotate already in the file, on top of which
// PageRef.rotation is a pending in-memory delta.
export interface PageGeometry {
  box: { x: number; y: number; width: number; height: number };
  bakedRotate: number;
}

export interface RedactionRegion {
  page: number; // 1-based position within the file's committed order
  rect: [number, number, number, number];
  // In the ENGINE's key names (which are the PDF key names one
  // step removed): fill=/IC, overlay_text=/OverlayText, repeat_overlay=/Repeat,
  // align=/Q, font_size + text_color=/DA. Omitted where the user left the
  // default, so "no overlay" and "an overlay of nothing" stay distinguishable
  // through the file.
  fill?: [number, number, number];
  overlay_text?: string;
  repeat_overlay?: boolean;
  align?: number;
  font_size?: number;
  text_color?: [number, number, number];
}

export interface RedactionFilePayload {
  path: string;
  regions: RedactionRegion[];
  markIds: string[];
}

// Rotate a display-normalized rect by a quarter-turn delta — the rect-only
// twin of the reducer's rotateAnnotationRect (tests/redaction.test.ts
// cross-checks the two case-by-case so they can't drift apart). Used to
// re-project a mark drawn at one rotation onto a page later rotated in
// memory: user space never moves under /Rotate, only the projection does.
export function rotateNormalizedRect(
  r: { x: number; y: number; w: number; h: number },
  delta: number,
): { x: number; y: number; w: number; h: number } {
  const d = ((delta % 360) + 360) % 360;
  if (d === 90) return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  if (d === 180) return { x: 1 - (r.x + r.w), y: 1 - (r.y + r.h), w: r.w, h: r.h };
  if (d === 270) return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  return r;
}

/** The point twin of rotateNormalizedRect — same top-left-origin clockwise
 * quarter-turn, for per-point geometry (ink strokes under Rotate View).
 * Consistency with the rect form is unit-asserted: a zero-size rect's corner
 * must land where the point does. */
export function rotateNormalizedPoint(
  x: number,
  y: number,
  delta: number,
): { x: number; y: number } {
  const d = ((delta % 360) + 360) % 360;
  if (d === 90) return { x: 1 - y, y: x };
  if (d === 180) return { x: 1 - x, y: 1 - y };
  if (d === 270) return { x: y, y: 1 - x };
  return { x, y };
}

/** rotateNormalizedPoint over a flat [x0,y0,x1,y1,…] list. */
export function rotateNormalizedPoints(points: number[], delta: number): number[] {
  const d = ((delta % 360) + 360) % 360;
  if (d === 0) return points;
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const p = rotateNormalizedPoint(points[i], points[i + 1], d);
    out.push(p.x, p.y);
  }
  return out;
}

/**
 * The page that shows page `pageNumber` (1-based) of the bytes `path` holds
 * now, wherever a pending edit moved it, or null.
 *
 * A page number read from the file (a stored /Redact mark, a search hit)
 * counts the file's own page order, which a pending reorder does not change.
 * It resolves only while `path`'s documents describe the current bytes: the
 * page indexes of superseded documents name pages of the previous bytes.
 */
export function pageForFilePageNumber(
  state: Pick<AppState, 'files' | 'workspace'>,
  path: string,
  pageNumber: number,
): PageRef | null {
  if (!pathDescribesCurrentBytes(state, path)) return null;
  for (const d of state.workspace.documents) {
    for (const p of d.pages) {
      if (p.sourceDocId === path && p.sourcePageIndex === pageNumber - 1) return p;
    }
  }
  return null;
}

// Where a mark should render on a page whose in-memory rotation has changed
// since the mark was drawn.
export function projectMarkRect(
  mark: RedactionMark,
  currentRotation: number,
): { x: number; y: number; w: number; h: number } {
  return rotateNormalizedRect(mark.rect, currentRotation - mark.rotationAtDraw);
}

// Resolve marks against the current workspace and produce one engine payload
// per affected file. A mark whose page no longer exists (deleted since it was
// drawn) is skipped and reported, never guessed at.
//
// Rect conversion: displayRectToPdf against the geometry's box at
// (bakedRotate + rotationAtDraw) — the orientation the rect was DRAWN in.
// The page's current in-memory rotation is irrelevant here: /Rotate never
// moves content in user space, so a later rotation changes only the overlay
// projection (projectMarkRect), not the user-space rect. After the commit
// gate bakes the pending delta, the content stream the engine walks is still
// the same user space this rect targets.
export async function buildRedactionRegions(
  docs: OpenDocument[],
  marks: RedactionMark[],
  getGeometry: (page: PageRef, path: string) => Promise<PageGeometry>,
): Promise<{ files: RedactionFilePayload[]; skippedMarkIds: string[] }> {
  const byPath = new Map<string, RedactionFilePayload>();
  const skippedMarkIds: string[] = [];
  for (const mark of marks) {
    let doc: OpenDocument | undefined;
    let page: PageRef | undefined;
    for (const d of docs) {
      const p = d.pages.find((pg) => pg.id === mark.pageId);
      if (p) {
        doc = d;
        page = p;
        break;
      }
    }
    const pageNumber = doc && page ? workspacePageNumber(docs, doc, mark.pageId) : null;
    if (!doc || !page || pageNumber == null) {
      skippedMarkIds.push(mark.id);
      continue;
    }
    const { box, bakedRotate } = await getGeometry(page, doc.path);
    const rect = displayRectToPdf(mark.rect, box, bakedRotate + mark.rotationAtDraw);
    let payload = byPath.get(doc.path);
    if (!payload) {
      payload = { path: doc.path, regions: [], markIds: [] };
      byPath.set(doc.path, payload);
    }
    payload.regions.push({
      page: pageNumber,
      rect,
      ...(mark.props ? propertiesPayload(mark.props) : {}),
    });
    payload.markIds.push(mark.id);
  }
  return { files: [...byPath.values()], skippedMarkIds };
}

/**
 * The one engine call a document's marks become. The user's Ghostscript
 * travels with it when one is configured: a mark over part of a JBIG2 image
 * decodes that image through it, and without one that image refuses by name.
 */
export async function applyRedactions<R>(
  perform: (path: string, method: 'redact', params: Record<string, unknown>) => Promise<R>,
  path: string,
  regions: readonly RedactionRegion[],
  gsPath: () => Promise<string>,
): Promise<R> {
  return perform(path, 'redact', { regions, gs_path: await gsPath() });
}

/** Whether an operation wrote new bytes. An operation on a file that is no
 * longer open answers null, and one the document's policy declined answers
 * the decline. */
export function wroteBytes<R extends object>(outcome: R | null | typeof EDIT_DECLINED): boolean {
  return outcome !== null && outcome !== EDIT_DECLINED;
}
