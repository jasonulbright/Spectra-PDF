// The hairline panel's model: the widths it was asked for, and the report it
// shows before anything is rewritten.
//
// What counts as a hairline, and what a corrected stroke's operand should be,
// are the ENGINE's rules and live there alone — a second copy here would be a
// second source of truth for one measurement. What lives here is what the
// PANEL has to decide by itself: whether the two widths it was given can both
// hold, and how to read the report back. There is no DOM test environment, so
// those rules live in the model rather than in the component.

export const DEFAULT_THRESHOLD_PT = 0.25;
export const DEFAULT_REPLACEMENT_PT = 0.25;

export interface HairlineStroke {
  line_width: number;
  effective_pt: number;
  scale: number;
  kind: string;
  nested: boolean;
  rect: number[];
}

export interface HairlineAnnotation {
  index: number;
  subtype: string;
  source: string;
  width_pt: number;
}

export interface HairlinePage {
  page: number;
  strokes: HairlineStroke[];
  annotations: HairlineAnnotation[];
  error: string | null;
}

export interface HairlineReport {
  threshold_pt: number;
  count: number;
  stroke_count: number;
  annotation_count: number;
  widths: { effective_pt: number; count: number }[];
  pages: HairlinePage[];
}

/** Why this pair of widths cannot both hold, or null when they can. A
 *  replacement below the threshold leaves behind the hairline it was asked to
 *  remove — the engine refuses it, and the panel says so first. */
export function boundsProblem(
  thresholdPt: number,
  replacementPt: number,
): 'threshold' | 'replacement' | null {
  if (!(thresholdPt > 0)) return 'threshold';
  if (!(replacementPt >= thresholdPt)) return 'replacement';
  return null;
}

/** The widths found, thinnest first, as the preview line the panel shows
 *  BEFORE the fix runs. */
export function widthSummary(report: HairlineReport | null): {
  effective_pt: number;
  count: number;
}[] {
  if (!report) return [];
  return [...report.widths].sort((a, b) => a.effective_pt - b.effective_pt);
}

/** The pages whose content stream could not be parsed. One broken page is
 *  reported and the rest of the run continues; it never returns silently. */
export function unreadablePages(report: HairlineReport | null): number[] {
  if (!report) return [];
  return report.pages.filter((p) => p.error !== null).map((p) => p.page);
}
