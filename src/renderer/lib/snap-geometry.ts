// N11 slice A — the SNAP-GEOMETRY boundary: fetch the engine's per-page
// geometry probe and project it into the display-normalized space the canvas
// gestures work in. The impure half of snapping; all the math is in the pure
// `lib/snap.ts` beside it (the `edit-vectors.ts` / `measure.ts` split).
//
// The call goes through `useEngine.call` (a workspace file — `callRaw` is for
// non-workspace targets only, and that rule is not negotiable). It does NOT
// commit, because `list_page_geometry` is an INTERNAL_METHOD: it is a pure
// read that refetches on every workspace change, and an ANNOTATION is a
// pending page edit, so gating it would flush the user's markup to disk the
// instant they drew it (the documented `get_pdf_version`/`measure_text_box`
// hazard — e2e regression in specs 87 and 88, which lost their page-tier
// annotations mid-suite).
//
// What makes that SAFE rather than a stale read: the caller addresses the
// SOURCE file at `sourcePageIndex` — exactly the page pdf.js rasterizes — so
// a pending reorder cannot mis-address it (a physical page never moves) and a
// pending rotation is applied by the same projection the raster already gets.
// The answer matches the view by CONSTRUCTION rather than by forcing a write.
// Do not "fix" this by adding the gate back.
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
