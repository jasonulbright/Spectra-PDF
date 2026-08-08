// The scan-enhancement panel's arithmetic. There is no DOM test environment,
// so the rules the panel rests on live in `lib/scan-enhance.ts` and are
// checked here: what the preview counts, what the Apply button is enabled by,
// and which pages are called out as uncertain rather than folded into
// "upright".
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCAN_ENHANCE,
  enhanceBatchNote,
  previewCounts,
  refusedRows,
  scanRows,
  scopeParam,
  settingsProblem,
  uncertainOrientation,
  worstSkew,
  type ScanAnalysis,
  type ScanPageRow,
} from '../src/renderer/lib/scan-enhance';

function analysis(pages: ScanPageRow[]): ScanAnalysis {
  return {
    file: 'C:\\scan.pdf',
    pages,
    pages_selected: pages.length,
    pages_scanned: pages.filter((p) => p.decision !== 'untouched').length,
    pages_would_change: pages.filter(
      (p) => p.would_deskew || p.would_despeckle || p.would_whiten || (p.would_rotate ?? 0) !== 0,
    ).length,
  };
}

const scan = (over: Partial<ScanPageRow> = {}): ScanPageRow => ({
  page: 1,
  decision: 'scan',
  skew_deg: 0,
  specks: 0,
  paper_before: 253,
  would_deskew: false,
  would_despeckle: false,
  would_whiten: false,
  would_rotate: 0,
  ...over,
});

describe('scan-enhance settings', () => {
  it('the shipped defaults are runnable', () => {
    expect(settingsProblem(DEFAULT_SCAN_ENHANCE)).toBeNull();
  });

  it('every correction off is refused before the round trip', () => {
    expect(
      settingsProblem({
        ...DEFAULT_SCAN_ENHANCE,
        deskew: false,
        despeckle: false,
        background: false,
        orientation: false,
      }),
    ).toBe('nothing');
  });

  it('names each out-of-band setting so the panel can point at it', () => {
    const bad = (over: Partial<typeof DEFAULT_SCAN_ENHANCE>) =>
      settingsProblem({ ...DEFAULT_SCAN_ENHANCE, ...over });
    expect(bad({ max_skew_deg: 90 })).toBe('maxSkew');
    expect(bad({ max_skew_deg: 0 })).toBe('maxSkew');
    expect(bad({ min_skew_deg: 20 })).toBe('minSkew');
    expect(bad({ speck_size_in: 0.5 })).toBe('speckSize');
    expect(bad({ background_strength: 2 })).toBe('strength');
    expect(bad({ jpeg_quality: 0 })).toBe('quality');
  });

  it('the minimum skew is judged against the CHOSEN search range, not a constant', () => {
    // 3 degrees is legal under a 10-degree search and illegal under a 1-degree
    // one; a fixed bound would have called one of the two wrong.
    expect(settingsProblem({ ...DEFAULT_SCAN_ENHANCE, min_skew_deg: 3 })).toBeNull();
    expect(
      settingsProblem({ ...DEFAULT_SCAN_ENHANCE, min_skew_deg: 3, max_skew_deg: 1 }),
    ).toBe('minSkew');
  });
});

describe('scan-enhance scope', () => {
  it('a document scope asks for every page and a page scope for one', () => {
    expect(scopeParam({ kind: 'document' })).toBe('all');
    expect(scopeParam({ kind: 'page', page: 7 })).toEqual([7]);
  });
});

describe('scan-enhance report reading', () => {
  it('separates the scans from the pages that refused', () => {
    const report = analysis([
      scan({ page: 1 }),
      { page: 2, decision: 'untouched', reason: 'this page is not a scanned image' },
      scan({ page: 3 }),
    ]);
    expect(scanRows(report).map((r) => r.page)).toEqual([1, 3]);
    expect(refusedRows(report).map((r) => r.page)).toEqual([2]);
  });

  it('counts what each arm would do, per page and per speck', () => {
    const report = analysis([
      scan({ page: 1, would_deskew: true, skew_deg: 2.7 }),
      scan({ page: 2, would_despeckle: true, specks: 40 }),
      scan({ page: 3, would_despeckle: true, specks: 2, would_whiten: true }),
      scan({ page: 4, would_rotate: 90 }),
      scan({ page: 5 }),
    ]);
    expect(previewCounts(report)).toEqual({
      scans: 5,
      deskew: 1,
      despeckle: 2,
      specks: 42,
      whiten: 1,
      rotate: 1,
      changing: 4,
    });
  });

  it('a speck count on a page that would NOT be despeckled is not totalled', () => {
    // The engine reports what it measured whether or not the arm acts, so the
    // panel must sum what would be REMOVED, not what was counted.
    const report = analysis([scan({ page: 1, specks: 900, would_despeckle: false })]);
    expect(previewCounts(report).specks).toBe(0);
  });

  it('an empty report counts nothing rather than throwing', () => {
    expect(previewCounts(null).scans).toBe(0);
    expect(worstSkew(null)).toBeNull();
    expect(scanRows(null)).toEqual([]);
  });

  it('the worst skew is the largest LEAN, keeping its direction', () => {
    const report = analysis([
      scan({ page: 1, skew_deg: 1.2 }),
      scan({ page: 2, skew_deg: -3.4 }),
      scan({ page: 3, skew_deg: 2.0 }),
    ]);
    expect(worstSkew(report)).toBe(-3.4);
  });

  it('a page with no measured angle does not become a zero', () => {
    const report = analysis([
      scan({ page: 1, skew_deg: null }),
      scan({ page: 2, skew_deg: -0.6 }),
    ]);
    expect(worstSkew(report)).toBe(-0.6);
  });
});

describe('scan-enhance uncertain orientation', () => {
  const rows = (floor: number) =>
    uncertainOrientation(
      analysis([
        scan({
          page: 1,
          orientation: { rotate: 90, confidence: 1.1, script: 'Latin', script_confidence: 3 },
        }),
        scan({
          page: 2,
          orientation: { rotate: 90, confidence: 16, script: 'Latin', script_confidence: 30 },
        }),
        scan({
          page: 3,
          orientation: { rotate: 0, confidence: 0.4, script: 'Latin', script_confidence: 1 },
        }),
        scan({ page: 4, orientation: null }),
      ]),
      floor,
    ).map((r) => r.page);

  it('calls out a page that looks turned but scored below the floor', () => {
    expect(rows(2)).toEqual([1]);
  });

  it('an upright page with a weak reading is not "uncertain" — nothing was going to happen', () => {
    // Page 3 reads Rotate 0 at low confidence. Reporting it would tell the
    // user a page might be sideways when the engine did not say so.
    expect(rows(2)).not.toContain(3);
  });

  it('raising the floor moves confident pages into the uncertain list', () => {
    expect(rows(20)).toEqual([1, 2]);
  });
});

describe('scan-enhance batch note', () => {
  // ENGLISH and byte-identical to engine/batch_ocr.py's `_enhance_step` — a
  // run logged one way by the GUI and another by the scheduler makes the audit
  // trail useless exactly where it matters most.
  it('names the page count when the pass wrote', () => {
    expect(
      enhanceBatchNote({
        output: 'C:\\out.pdf',
        written: true,
        pages: [],
        pages_enhanced: 3,
        pages_unchanged: 1,
        pages_untouched: 0,
      }),
    ).toBe('Enhanced 3 scanned page(s)');
  });

  it('says so when there was nothing to correct', () => {
    expect(
      enhanceBatchNote({
        output: 'C:\\in.pdf',
        written: false,
        pages: [],
        pages_enhanced: 0,
        pages_unchanged: 2,
        pages_untouched: 0,
      }),
    ).toBe('Scan enhancement found nothing to correct');
  });
});
