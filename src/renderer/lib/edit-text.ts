// Edit-mode text runs (Phase 7.2+7.3): the engine's per-page run listing
// projected into display space, plus the LOCAL keystroke validation the
// inline edit box runs against each run's finite encodable inventory —
// live refusal ("this document's font does not contain 'X'"), never a
// save-time surprise.
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';

/** Sentinel returned by the App edit handlers when the user DECLINED the
 * signed-document warning — distinct from success (void) and from failure
 * (throw), so the canvas can restore its listing and say so; a silent
 * return was visually indistinguishable from a successful edit
 * (review-caught, both edit kinds). */
export const EDIT_DECLINED = 'edit-declined' as const;

export interface EditTextRun {
  /** Engine id — DFS show-op order on the page (the 7.1 discipline). */
  index: number;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  nested: boolean;
  editable: boolean;
  /** Why an uneditable run refuses (shown on hover/selection). */
  reason: string | null;
  /** The finite character inventory the run's font can encode. */
  encodable: string;
}

interface EngineRunListing {
  runs: {
    index: number;
    text: string;
    rect: [number, number, number, number];
    nested: boolean;
    editable: boolean;
    reason: string | null;
    encodable: string;
  }[];
}

export async function fetchTextRuns(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<EditTextRun[]> {
  const listing = (await call('list_text_runs', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EngineRunListing;
  return (listing.runs ?? []).map((run) => ({
    index: run.index,
    text: run.text,
    nested: Boolean(run.nested),
    editable: Boolean(run.editable),
    reason: run.reason ?? null,
    encodable: run.encodable ?? '',
    rect: pdfRectToDisplay(run.rect, geometry.box, geometry.bakedRotate),
  }));
}

/** Characters of `value` the font cannot encode, deduplicated in order —
 * empty means the value is fully expressible. */
export function unencodableChars(value: string, encodable: string): string[] {
  const inventory = new Set(encodable);
  const missing: string[] = [];
  for (const ch of value) {
    if (!inventory.has(ch) && !missing.includes(ch)) missing.push(ch);
  }
  return missing;
}
