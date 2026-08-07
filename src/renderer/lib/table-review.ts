// Detected tables — the review model, pure over data.
//
// A detected table is a SUGGESTION with the field-candidate lifetime: transient
// view state bound to a page id, invalidated when its file's bytes change, and
// carrying nothing into any output until the user accepts it. Nothing here ever
// touches the PDF: the reviewed set is a parameter to the spreadsheet export,
// and the export writes only its own file.
//
// TWO FRAMES, and the split is the whole of this module's geometry.
//
// The table's BOUNDS are display-normalized with the rotation they were
// detected at, exactly as a field candidate's rect is — the canvas already owns
// one conversion between page space and the cell, and a second one here would
// be a second answer to where a rectangle is.
//
// Its COLUMN and ROW lines are fractions of the bounds in UN-ROTATED USER
// SPACE, which is where the detector reports them and where the export reads
// them back. Storing them in the cell's frame instead would bake a quarter turn
// into a number the engine never rotated, and a page turned after detection
// would export the columns as rows. Which way a line is DRAWN is therefore a
// question about the current rotation, answered by `placeColumn`/`placeRow`.
//
// Fractions rather than absolute positions are what makes a bounds drag
// coherent: dragging the table's trailing edge carries its interior boundaries
// with it instead of leaving them where they no longer describe the table.

/** One region of the detection door's payload, in un-rotated user space. */
export interface DetectedTable {
  page: number;
  index: number;
  bounds: [number, number, number, number];
  columns: number[];
  rows: number[];
  evidence: string;
  caption: string | null;
  cells: number;
}

export interface TableDetectionResult {
  pages: number[];
  regions: DetectedTable[];
  untabled: Record<string, string[]>;
  vertical_writing_runs: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Quarter = 0 | 90 | 180 | 270;

export interface TableRegion {
  id: string;
  /** File path at detection time — used only to invalidate when its bytes change. */
  path: string;
  pageId: string;
  /** 1-based position in the file at detection time, for the panel's grouping. */
  page: number;
  /** Display-normalized (0..1 of the page cell) in the orientation the page was
   * shown at detection time. */
  rect: NormalizedRect;
  /** The PageRef's in-memory rotation DELTA at detection time. */
  rotationAtDraw: Quarter;
  /** The rotation between un-rotated user space and the cell at detection time,
   * i.e. the file's baked /Rotate composed with the delta above. The interior
   * lines are stored in user space, so this is what says which way they ran. */
  totalRotationAtDraw: Quarter;
  /** Column starts as fractions of the bounds' user-space width, ascending. The
   * first is the table's own leading edge, not a boundary between two columns. */
  columns: number[];
  /** Row baselines as fractions of the bounds' user-space height, measured from
   * its top. Drawn, never edited — a row is a cluster of baselines the page
   * states directly, not a guess. */
  rows: number[];
  evidence: string;
  caption: string | null;
  cells: number;
  accepted: boolean;
}

/** Two boundaries closer than this describe one column, so a drag may not
 * produce them. A fraction of the table's own width. */
export const MIN_COLUMN_FRACTION = 0.02;
/** A table cannot shrink below this on either side. */
const MIN_SIDE = 0.004;
/** The engine refuses a table with fewer boundaries than this, so the review
 * refuses the gesture that would produce one. */
const MIN_COLUMNS = 2;

export function clampRect(rect: NormalizedRect): NormalizedRect {
  const w = Math.max(rect.w, MIN_SIDE);
  const h = Math.max(rect.h, MIN_SIDE);
  return {
    x: Math.min(Math.max(rect.x, 0), 1 - w),
    y: Math.min(Math.max(rect.y, 0), 1 - h),
    w,
    h,
  };
}

export function quarter(rotation: number): Quarter {
  return ((((rotation % 360) + 360) % 360) as Quarter);
}

/** Where an interior line is DRAWN inside the table's cell rect, at a given
 * total rotation. `at` is a fraction of the rect's own drawn side. */
export interface LinePlacement {
  axis: 'x' | 'y';
  at: number;
}

/**
 * A column boundary's drawn placement.
 *
 * A column is a constant-x line in user space; a quarter turn of the page turns
 * it into a constant-y line on screen, which is the same clockwise
 * top-left-origin turn `rotateNormalizedPoint` applies, restated for the
 * table's own local frame.
 */
export function placeColumn(fraction: number, rotation: number): LinePlacement {
  const d = quarter(rotation);
  if (d === 90) return { axis: 'y', at: fraction };
  if (d === 180) return { axis: 'x', at: 1 - fraction };
  if (d === 270) return { axis: 'y', at: 1 - fraction };
  return { axis: 'x', at: fraction };
}

/** A row baseline's drawn placement, the `placeColumn` twin for the other axis. */
export function placeRow(fraction: number, rotation: number): LinePlacement {
  const d = quarter(rotation);
  if (d === 90) return { axis: 'x', at: 1 - fraction };
  if (d === 180) return { axis: 'y', at: 1 - fraction };
  if (d === 270) return { axis: 'x', at: fraction };
  return { axis: 'y', at: fraction };
}

/** The stored fraction a drawn column position stands for — `placeColumn`'s
 * inverse, so a drag reads back as the number the export writes. */
export function columnFractionAt(at: number, rotation: number): number {
  const d = quarter(rotation);
  return d === 180 || d === 270 ? 1 - at : at;
}

/** The rotation between un-rotated user space and the cell a region is drawn in
 * NOW: what it was at detection, moved by however far the page has turned since. */
export function currentRotation(region: TableRegion, pageRotation: number): Quarter {
  return quarter(region.totalRotationAtDraw + pageRotation - region.rotationAtDraw);
}

function sortedFractions(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The detection payload as review state, bound to the pages it was found on.
 * A region whose page the caller cannot resolve is dropped rather than bound to
 * a guess — the caller counts those and reports them. */
export function regionsFromDetection(
  result: TableDetectionResult,
  path: string,
  resolve: (row: DetectedTable) => {
    pageId: string;
    rect: NormalizedRect;
    rotationAtDraw: Quarter;
    totalRotationAtDraw: Quarter;
  } | null,
  newId: () => string,
): { regions: TableRegion[]; skipped: number } {
  const regions: TableRegion[] = [];
  let skipped = 0;
  for (const row of result.regions) {
    const placed = resolve(row);
    if (!placed) {
      skipped += 1;
      continue;
    }
    const [x0, y0, x1, y1] = row.bounds;
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) {
      skipped += 1;
      continue;
    }
    regions.push({
      id: newId(),
      path,
      pageId: placed.pageId,
      page: row.page,
      rect: clampRect(placed.rect),
      rotationAtDraw: placed.rotationAtDraw,
      totalRotationAtDraw: placed.totalRotationAtDraw,
      columns: sortedFractions(row.columns.map((x) => (x - x0) / width)),
      // User space measures up; the fraction measures down, so the table's top
      // row is the first entry however the page is turned.
      rows: sortedFractions(row.rows.map((y) => (y1 - y) / height)),
      evidence: row.evidence,
      caption: row.caption,
      cells: row.cells,
      // Nothing is accepted here: a review that pre-consents is not a review.
      accepted: false,
    });
  }
  return { regions, skipped };
}

/** Regions whose page still exists, pruned before anything reads them — a stale
 * generation-tagged id must never reach a gesture. */
export function prunedRegions(
  regions: readonly TableRegion[],
  livePageIds: ReadonlySet<string>,
): TableRegion[] {
  return regions.filter((r) => livePageIds.has(r.pageId));
}

export function toggleRegion(regions: readonly TableRegion[], id: string): TableRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, accepted: !r.accepted } : r));
}

export function setAcceptedAll(
  regions: readonly TableRegion[],
  accepted: boolean,
): TableRegion[] {
  return regions.map((r) => (r.accepted === accepted ? r : { ...r, accepted }));
}

export function acceptedRegions(regions: readonly TableRegion[]): TableRegion[] {
  return regions.filter((r) => r.accepted);
}

export type TriState = 'none' | 'some' | 'all';

export function selectionState(regions: readonly TableRegion[]): TriState {
  if (regions.length === 0) return 'none';
  const accepted = regions.filter((r) => r.accepted).length;
  if (accepted === 0) return 'none';
  return accepted === regions.length ? 'all' : 'some';
}

/** Move or resize a table's bounds. The column and row fractions are unchanged
 * by construction — they are measured against the bounds, so they travel with
 * them. */
export function moveRegionBounds(
  regions: readonly TableRegion[],
  id: string,
  rect: NormalizedRect,
): TableRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, rect: clampRect(rect) } : r));
}

/**
 * Move one column boundary, clamped between its neighbours.
 *
 * Two boundaries that met would describe a column with no cells in it, and two
 * that crossed would reverse the reading order of the columns they bound — so
 * the clamp is the rule, not a nicety. Index 0 is the table's leading edge and
 * is clamped against the bounds rather than against a boundary before it.
 */
export function moveColumn(
  regions: readonly TableRegion[],
  id: string,
  index: number,
  fraction: number,
): TableRegion[] {
  return regions.map((r) => {
    if (r.id !== id) return r;
    if (index < 0 || index >= r.columns.length) return r;
    const low = index === 0 ? 0 : r.columns[index - 1] + MIN_COLUMN_FRACTION;
    const high =
      index === r.columns.length - 1
        ? 1 - MIN_COLUMN_FRACTION
        : r.columns[index + 1] - MIN_COLUMN_FRACTION;
    if (high < low) return r;
    const columns = [...r.columns];
    columns[index] = Math.min(Math.max(fraction, low), high);
    return { ...r, columns };
  });
}

/** Add a boundary. A position that would sit on top of an existing one is
 * refused rather than nudged: the gesture said where, and moving it elsewhere
 * would answer a question nobody asked. */
export function addColumn(
  regions: readonly TableRegion[],
  id: string,
  fraction: number,
): TableRegion[] {
  return regions.map((r) => {
    if (r.id !== id) return r;
    if (fraction <= 0 || fraction >= 1) return r;
    if (r.columns.some((x) => Math.abs(x - fraction) < MIN_COLUMN_FRACTION)) return r;
    return { ...r, columns: sortedFractions([...r.columns, fraction]) };
  });
}

/** Remove a boundary. The leading edge is not one, and a table may not drop
 * below the two the engine requires. */
export function removeColumn(
  regions: readonly TableRegion[],
  id: string,
  index: number,
): TableRegion[] {
  return regions.map((r) => {
    if (r.id !== id) return r;
    if (index <= 0 || index >= r.columns.length) return r;
    if (r.columns.length <= MIN_COLUMNS) return r;
    return { ...r, columns: r.columns.filter((_x, i) => i !== index) };
  });
}

/**
 * The gestures the on-page overlay offers, as one bundle.
 *
 * Bundled rather than drilled one prop at a time because every layer between
 * the canvas and the page cell would otherwise carry seven signatures that must
 * stay in step — and a review whose six gestures are threaded separately is six
 * chances for one of them to arrive at only half the surfaces.
 */
export interface TableReviewHandlers {
  selectedId: string | null;
  onSelect: (regionId: string) => void;
  onToggle: (regionId: string) => void;
  onMoveBounds: (regionId: string, rect: NormalizedRect) => void;
  onMoveColumn: (regionId: string, index: number, fraction: number) => void;
  onAddColumn: (regionId: string, fraction: number) => void;
  onRemoveColumn: (regionId: string, index: number) => void;
}

/** One accepted table, as the engine's `regions` payload takes it. */
export interface ResolvedTable {
  page: number;
  bounds: [number, number, number, number];
  columns: number[];
  caption: string | null;
}

/**
 * The accepted set as the engine's `regions` payload.
 *
 * The caller supplies the page number and the user-space bounds — the only
 * parts that need the canvas — and the column positions follow from the stored
 * fractions, so the two halves of the geometry cannot disagree about the same
 * table. A table the caller cannot resolve is counted, never silently dropped.
 */
export function exportRegions(
  regions: readonly TableRegion[],
  resolve: (region: TableRegion) => {
    page: number;
    bounds: [number, number, number, number];
  } | null,
): { regions: ResolvedTable[]; skipped: number } {
  const out: ResolvedTable[] = [];
  let skipped = 0;
  for (const region of acceptedRegions(regions)) {
    const resolved = resolve(region);
    if (!resolved) {
      skipped += 1;
      continue;
    }
    const [x0, , x1] = resolved.bounds;
    const width = x1 - x0;
    out.push({
      page: resolved.page,
      bounds: resolved.bounds,
      columns: region.columns.map((f) => x0 + f * width),
      caption: region.caption,
    });
  }
  return { regions: out, skipped };
}
