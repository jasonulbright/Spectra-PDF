// Scan enhancement — the shapes the engine returns and the arithmetic the
// panel shows.
//
// It lives beside the panel rather than inside it for the reason the repo
// keeps saying: there is no DOM test environment, so anything with a rule in
// it belongs in a module a vitest suite can call. The panel renders; this
// decides.

/** Tesseract's orientation & script reading for one page. */
export interface OsdReading {
  /** Clockwise correction, degrees — the same sense as PDF /Rotate. */
  rotate: number;
  confidence: number;
  script: string;
  script_confidence: number;
}

/** One page's row in an `analyze_scan` / `enhance_scan` report. */
export interface ScanPageRow {
  page: number;
  decision: 'scan' | 'enhanced' | 'unchanged' | 'untouched';
  reason?: string;
  source_dpi?: number;
  width?: number;
  height?: number;
  skew_deg?: number | null;
  specks?: number | null;
  paper_before?: number;
  paper_after?: number;
  orientation?: OsdReading | null;
  orientation_reason?: string;
  would_deskew?: boolean;
  would_despeckle?: boolean;
  would_whiten?: boolean;
  would_rotate?: number;
  deskew_applied?: boolean;
  despeckle_applied?: boolean;
  background_applied?: boolean;
  rotate_applied?: number;
}

export interface ScanAnalysis {
  file: string;
  pages: ScanPageRow[];
  pages_selected: number;
  pages_scanned: number;
  pages_would_change: number;
}

export interface ScanEnhanceReport {
  output: string;
  written: boolean;
  pages: ScanPageRow[];
  pages_enhanced: number;
  pages_unchanged: number;
  pages_untouched: number;
}

/** The settings the panel owns. Names match the engine's parameters so the
 * request is a rename-free spread — a translation layer between a form and an
 * RPC is a place for a typo to become a silently ignored setting. */
export interface ScanEnhanceSettings {
  deskew: boolean;
  despeckle: boolean;
  background: boolean;
  orientation: boolean;
  background_strength: number;
  osd_confidence: number;
  max_skew_deg: number;
  min_skew_deg: number;
  speck_size_in: number;
  speck_gap_in: number;
  jpeg_quality: number;
}

/** The engine's own defaults, restated once so the panel opens showing what a
 * run with no settings would do. `engine/enhance_scan.py` states what each one
 * was measured against, on the constant it produced. */
export const DEFAULT_SCAN_ENHANCE: ScanEnhanceSettings = {
  deskew: true,
  despeckle: true,
  background: true,
  orientation: true,
  background_strength: 1,
  osd_confidence: 2,
  max_skew_deg: 10,
  min_skew_deg: 0.1,
  speck_size_in: 0.01,
  speck_gap_in: 0.02,
  jpeg_quality: 85,
};

/** Which pages the run covers. `page` carries the 1-based number. */
export type ScanScope = { kind: 'document' } | { kind: 'page'; page: number };

export function scopeParam(scope: ScanScope): 'all' | number[] {
  return scope.kind === 'document' ? 'all' : [scope.page];
}

/** Why the settings cannot be run, or null.
 *
 * Checked HERE as well as in the engine: the engine's refusal arrives after
 * the request, and a disabled button with a reason beside it is the same
 * information one round trip earlier. */
export function settingsProblem(s: ScanEnhanceSettings): string | null {
  if (!s.deskew && !s.despeckle && !s.background && !s.orientation) return 'nothing';
  if (!(s.max_skew_deg >= 0.1 && s.max_skew_deg <= 45)) return 'maxSkew';
  if (!(s.min_skew_deg >= 0 && s.min_skew_deg <= s.max_skew_deg)) return 'minSkew';
  if (!(s.speck_size_in >= 0.001 && s.speck_size_in <= 0.05)) return 'speckSize';
  if (!(s.background_strength >= 0 && s.background_strength <= 1)) return 'strength';
  if (!(s.jpeg_quality >= 1 && s.jpeg_quality <= 100)) return 'quality';
  return null;
}

/** The pages that are scans. */
export function scanRows(report: ScanAnalysis | null): ScanPageRow[] {
  return (report?.pages ?? []).filter((r) => r.decision !== 'untouched');
}

/** The pages that are NOT scans, with the engine's own reason. Shown rather
 * than hidden: "nothing happened to page 4" is a question the user will
 * otherwise have to guess the answer to. */
export function refusedRows(report: ScanAnalysis | null): ScanPageRow[] {
  return (report?.pages ?? []).filter((r) => r.decision === 'untouched');
}

/** What the run would do, counted per arm — the preview the Apply button is
 * justified by (the hairlines precedent: state the count before rewriting). */
export interface ScanPreviewCounts {
  scans: number;
  deskew: number;
  despeckle: number;
  specks: number;
  whiten: number;
  rotate: number;
  changing: number;
}

export function previewCounts(report: ScanAnalysis | null): ScanPreviewCounts {
  const rows = scanRows(report);
  return {
    scans: rows.length,
    deskew: rows.filter((r) => r.would_deskew).length,
    despeckle: rows.filter((r) => r.would_despeckle).length,
    specks: rows.reduce((n, r) => n + (r.would_despeckle ? (r.specks ?? 0) : 0), 0),
    whiten: rows.filter((r) => r.would_whiten).length,
    rotate: rows.filter((r) => (r.would_rotate ?? 0) !== 0).length,
    changing: report?.pages_would_change ?? 0,
  };
}

/** The largest skew any selected page carries, in degrees, or null when no
 * page was measured. Signed: the sign is which way the page leans. */
export function worstSkew(report: ScanAnalysis | null): number | null {
  let worst: number | null = null;
  for (const row of scanRows(report)) {
    const angle = row.skew_deg;
    if (typeof angle !== 'number') continue;
    if (worst === null || Math.abs(angle) > Math.abs(worst)) worst = angle;
  }
  return worst;
}

/** The batch-log note for one enhanced file.
 *
 * ENGLISH and byte-identical to `engine/batch_ocr.py`'s `_enhance_step` — a
 * run logged one way by the GUI and another by the scheduler makes the audit
 * trail useless exactly where it matters most (the standing batch-log
 * boundary; the log is not a translated surface). */
export function enhanceBatchNote(report: ScanEnhanceReport): string {
  if (!report.written) return 'Scan enhancement found nothing to correct';
  return `Enhanced ${report.pages_enhanced} scanned page(s)`;
}

/** Pages whose orientation reading was BELOW the confidence floor — looked at
 * and judged uncertain, which is a different answer from "upright" and is
 * reported as such rather than silently folded into it. */
export function uncertainOrientation(
  report: ScanAnalysis | null,
  floor: number,
): ScanPageRow[] {
  return scanRows(report).filter(
    (r) =>
      r.orientation != null &&
      r.orientation.rotate !== 0 &&
      r.orientation.confidence < floor,
  );
}
