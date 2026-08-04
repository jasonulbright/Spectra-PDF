// N11 slice A — the SNAP-GEOMETRY boundary: fetch the engine's per-page
// geometry probe and project it into the display-normalized space the canvas
// gestures work in. The impure half of snapping; all the math is in the pure
// `lib/snap.ts` beside it (the `edit-vectors.ts` / `measure.ts` split).
//
// The call goes through the GATED `useEngine.call`, never `callRaw`. It reads
// the WORKING copy, and a pending page rotation or reorder changes the very
// geometry the user is snapping to — the gate is what makes the answer match
// the view. That is the same commit side effect the Edit tool's listing pass
// already has (`WorkspaceCanvasView`'s `runCommitGate()` before its listings);
// it is stated here so nobody "optimizes" it into a raw call later.
import { pdfPointToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';
import type { SnapPath } from './snap';

/** A page's snap geometry, display-normalized at the page's BAKED
 * orientation — pending in-memory rotation is applied by the consumer at
 * render/query time, exactly like image placements and redaction marks. */
export interface PageSnapGeometry {
  paths: SnapPath[];
}

export const EMPTY_PAGE_SNAP_GEOMETRY: PageSnapGeometry = { paths: [] };

interface EngineGeometry {
  paths?: {
    index: number;
    kind: string;
    closed?: boolean[];
    subpaths?: number[][];
  }[];
}

export async function fetchSnapGeometry(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<PageSnapGeometry> {
  const listing = (await call('list_page_geometry', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EngineGeometry;
  const paths: SnapPath[] = [];
  for (const entry of listing.paths ?? []) {
    const subs = entry.subpaths ?? [];
    const closed = entry.closed ?? [];
    const outSubs: number[][] = [];
    const outClosed: boolean[] = [];
    for (let i = 0; i < subs.length; i++) {
      const flat = subs[i];
      if (!Array.isArray(flat) || flat.length < 4) continue;
      const projected: number[] = [];
      for (let j = 0; j + 1 < flat.length; j += 2) {
        // Point-by-point, never corner-by-corner: a diagonal's endpoints are
        // only two of its bbox's four corners and nothing says which two —
        // the exact reason a bbox listing could not serve snapping.
        const [x, y] = pdfPointToDisplay(
          flat[j],
          flat[j + 1],
          geometry.box,
          geometry.bakedRotate,
        );
        projected.push(x, y);
      }
      outSubs.push(projected);
      outClosed.push(Boolean(closed[i]));
    }
    if (outSubs.length > 0) paths.push({ subpaths: outSubs, closed: outClosed });
  }
  return { paths };
}
